import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Mic } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

/**
 * OAuth2 implicit-grant account linking, for Alexa.
 *
 * Alexa supports implicit grant as well as authorization-code, and implicit is the right
 * choice here: it needs no token endpoint and no refresh flow, because the credential it
 * hands back is already long-lived and already revocable — an ordinary `de_` row in
 * api_tokens, the same kind the MCP server uses. Revoking it in Settings → Integrations
 * stops the Alexa skill immediately, and there is no second credential system to keep in
 * step with the first.
 *
 * This route only ever runs for a signed-in user (it lives under _authenticated), so no
 * password goes near Amazon and none reaches us either — the session is the proof of
 * identity, and the token is minted server-side by create_api_token().
 */
export const Route = createFileRoute("/_authenticated/authorize")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect_uri: typeof search.redirect_uri === "string" ? search.redirect_uri : "",
    state: typeof search.state === "string" ? search.state : "",
    client_id: typeof search.client_id === "string" ? search.client_id : "",
    response_type: typeof search.response_type === "string" ? search.response_type : "",
  }),
  component: Authorize,
});

/**
 * Which redirect targets are acceptable.
 *
 * This is the most important check in the file. A hand-rolled authorize endpoint that
 * reflects an arbitrary redirect_uri is an open redirector, and what it would hand out here
 * is a live API token — so anyone could send a user to this page and collect their
 * credential at a URL of their choosing.
 *
 * It was first written as a fixed set of four hostnames (layla / pitangui / alexa.amazon.com
 * / alexa.amazon.co.jp), which is the list every tutorial gives. That rejected a real linking
 * attempt from India: Amazon has a marketplace host per region and uses whichever matches the
 * account. Enumerating them is a losing game — the list is undocumented and grows.
 *
 * So the rule is now structural rather than a list: the host must be Amazon-owned, and the
 * path must be Amazon's account-linking path. Both halves matter.
 *
 * The suffix is matched as `(^|\.)amazon.<public-suffix>` deliberately. A naive
 * `endsWith("amazon.com")` would also accept `evil-amazon.com`, which is exactly the bug
 * this kind of check usually ships with.
 */
const AMAZON_HOST =
  /(^|\.)amazon\.(com|co\.uk|co\.jp|in|de|fr|it|es|nl|se|pl|com\.au|com\.br|com\.mx|com\.tr|sa|ae|eg|ca|cn|sg)$/i;

/**
 * Amazon's account-linking callback paths.
 *
 * Two of them, and the first one is the one that matters. The developer console actually
 * issues:
 *
 *   https://layla.amazon.com/spa/skill/account-linking-status.html?vendorId=…
 *
 * while `/api/skill/link/{vendorId}` is the older form that nearly every tutorial and SDK
 * doc still shows. Checking only the documented path refused a real link attempt whose host
 * was on the allowlist all along — the host was never the problem, the path was.
 *
 * Both are kept: Amazon has not retired the legacy form, and a skill created years ago may
 * still be configured with it.
 */
const LINK_PATHS = ["/spa/skill/account-linking-status.html", "/api/skill/link/"] as const;

function allowedPath(pathname: string): boolean {
  return LINK_PATHS.some((p) => pathname === p || pathname.startsWith(p));
}

function redirectAllowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!AMAZON_HOST.test(url.hostname)) return null;
  if (!allowedPath(url.pathname)) return null;
  return url;
}

/** Why a redirect was refused, specific enough to act on. */
function refusalReason(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `“${raw}” is not a valid URL.`;
  }
  if (url.protocol !== "https:") return `“${url.protocol}” is not https.`;
  if (!AMAZON_HOST.test(url.hostname)) return `“${url.hostname}” is not an Amazon domain.`;
  if (!allowedPath(url.pathname)) {
    return `the path “${url.pathname}” is not one of Amazon's account-linking paths (${LINK_PATHS.join(" or ")}).`;
  }
  return "it did not match the expected shape.";
}

function Authorize() {
  const { redirect_uri, state } = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const started = useRef(false);

  const target = redirect_uri ? redirectAllowed(redirect_uri) : null;

  useEffect(() => {
    if (!redirect_uri) {
      setError("This page was opened without a redirect target. Nothing was linked.");
      return;
    }
    if (!target) {
      // The rejected value is shown, not hidden. The first version of this page said only
      // "that redirect address is not one Alexa uses", which is true, useless, and left no
      // way to find out which address Amazon had actually sent.
      setError(
        `Nothing was linked: ${refusalReason(redirect_uri)}\n\nAmazon sent:\n${redirect_uri}`,
      );
      console.error("[authorize] refused redirect_uri", redirect_uri);
    }
  }, [redirect_uri, target]);

  const link = async () => {
    if (!target || started.current) return;
    started.current = true;
    setLinking(true);
    try {
      const { data, error: rpcError } = await supabase.rpc("create_api_token", {
        p_name: "Alexa",
      });
      if (rpcError) throw rpcError;
      const token = (data as { token: string }[] | null)?.[0]?.token;
      if (!token) throw new Error("No token was returned.");

      // Implicit grant returns the credential in the URL *fragment*, which is never sent to
      // a server and so never lands in a server log — that is the whole reason the fragment
      // is used rather than a query string.
      const fragment = new URLSearchParams({
        access_token: token,
        token_type: "Bearer",
        ...(state ? { state } : {}),
      });
      window.location.replace(`${target.toString()}#${fragment.toString()}`);
    } catch (e) {
      started.current = false;
      setLinking(false);
      setError(e instanceof Error ? e.message : "Could not create a token.");
    }
  };

  return (
    <AppShell>
      <PageHeader title="Link Alexa" subtitle="Connect Daily Edge to your Alexa account." />
      <Card>
        {error ? (
          <div className="space-y-3">
            <p className="text-destructive flex items-start gap-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="break-all whitespace-pre-wrap">{error}</span>
            </p>
            <Button variant="outline" onClick={() => navigate({ to: "/settings" })}>
              Back to settings
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">
              <Mic className="text-primary mr-1.5 inline size-4" />
              Alexa will be able to read your news and tasks, and add new tasks. It{" "}
              <strong>cannot</strong> complete or delete anything — a speaker may have misheard, and
              shows you nothing to check.
            </p>
            <p className="text-muted-foreground text-xs">
              This creates an API token named &ldquo;Alexa&rdquo;. Revoke it any time under Settings
              &rarr; Integrations and the skill stops working immediately.
            </p>
            <Button onClick={() => void link()} disabled={linking} className="w-full sm:w-auto">
              {linking ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> <span className="ml-2">Linking…</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-4" /> <span className="ml-2">Link my account</span>
                </>
              )}
            </Button>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
