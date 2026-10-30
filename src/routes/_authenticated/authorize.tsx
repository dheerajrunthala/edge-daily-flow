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
 * The hosts Amazon actually redirects account linking to, by region.
 *
 * An allowlist rather than a pattern, and checked on host AND path. A hand-rolled authorize
 * endpoint that reflects an arbitrary redirect_uri is an open redirector: anyone could send
 * a user here and collect a live API token at a URL of their choosing. This is the most
 * important check in the file.
 */
const ALLOWED_HOSTS = new Set([
  "layla.amazon.com",
  "pitangui.amazon.com",
  "alexa.amazon.co.jp",
  "alexa.amazon.com",
]);

function redirectAllowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;
  if (!url.pathname.startsWith("/api/skill/link/")) return null;
  return url;
}

function Authorize() {
  const { redirect_uri, state } = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const started = useRef(false);

  const target = redirect_uri ? redirectAllowed(redirect_uri) : null;

  useEffect(() => {
    if (!redirect_uri) setError("This page was opened without a redirect target.");
    else if (!target) setError("That redirect address is not one Alexa uses. Nothing was linked.");
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
              <span>{error}</span>
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
