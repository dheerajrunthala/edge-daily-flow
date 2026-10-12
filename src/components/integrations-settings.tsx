import { useState } from "react";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { ListSkeleton } from "@/components/common";
import { useApiTokenActions, useApiTokens, type ApiTokenRow } from "@/lib/queries";
import { relativeTime } from "@/lib/tz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The MCP server's URL. Derived from the Supabase URL the app is already configured with
 * rather than hardcoded, so this page is correct in every environment without a second
 * env var to keep in step.
 */
function mcpUrl(): string {
  const base = (import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ?? "";
  return `${base.replace(/\/+$/, "")}/functions/v1/mcp`;
}

const CLAUDE_CODE_CMD = (url: string, token: string) =>
  `claude mcp add --scope user --transport http daily-edge ${url} --header "Authorization: Bearer ${token}"`;

/**
 * The Claude Desktop snippet.
 *
 * The header is passed as `Authorization:${AUTH_HEADER}` with **no space after the colon**,
 * and the "Bearer " prefix lives in the env var. That is mcp-remote's own documented
 * workaround (README, v0.14.3) for Claude Desktop on Windows, Cursor and Codex, which do
 * not escape spaces inside `args` when invoking npx and would otherwise mangle the header
 * into something unparseable. The form is harmless on macOS, so one snippet covers every
 * platform instead of shipping two that differ by a space.
 */
const CLAUDE_DESKTOP_CONFIG = (url: string, token: string) =>
  `{
  "mcpServers": {
    "daily-edge": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${url}",
        "--header",
        "Authorization:\${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer ${token}"
      }
    }
  }
}`;

const TRY_SAYING = [
  "remind me tomorrow morning to finish this migration",
  "what's overdue?",
  "mark the PR review task done",
  "what's in today's AI news?",
];

export function IntegrationsSettings() {
  const { data: tokens, isLoading } = useApiTokens();
  const { create } = useApiTokenActions();
  const [name, setName] = useState("");
  // The plaintext token, held in component state for exactly as long as this page is
  // open. It is never written anywhere and cannot be fetched again.
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);

  const url = mcpUrl();

  const startCreate = () =>
    create.mutate(name.trim() || "MCP token", {
      onSuccess: (row) => {
        setFresh({ token: row.token, name: row.name });
        setName("");
      },
    });

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Connect Daily Edge to Claude Code or Claude Desktop. Once it is set up you can add tasks,
        check what is overdue and read your news digest from inside any conversation — including
        from a repo you are working in, so a reminder can carry the branch and the file with it.
      </p>

      {/* ------------------------------------------------------------- create */}
      <div className="space-y-2">
        <Label htmlFor="token-name">Create a token</Label>
        <div className="flex items-center gap-2">
          <Input
            id="token-name"
            value={name}
            placeholder="MacBook — Claude Code"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !create.isPending && startCreate()}
            className="h-11 flex-1 rounded-xl"
          />
          <Button
            className="h-11 shrink-0 rounded-xl"
            disabled={create.isPending}
            onClick={startCreate}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Create
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Name it after the machine it will live on, so you know which one to revoke later.
        </p>
      </div>

      {fresh && <FreshToken token={fresh.token} url={url} onDismiss={() => setFresh(null)} />}

      {/* ------------------------------------------------------------- list */}
      <div className="space-y-2">
        <Label>Your tokens</Label>
        {isLoading ? (
          <ListSkeleton rows={2} />
        ) : tokens?.length ? (
          <div className="divide-y divide-border rounded-xl border border-border">
            {tokens.map((t) => (
              <TokenRow key={t.id} token={t} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No tokens yet. Create one above to connect a client.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------- setup */}
      {!fresh && (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Setup</p>
          <p className="text-xs text-muted-foreground">
            Create a token above and the commands below will be filled in with it. Your existing
            tokens cannot be shown again, so these use a placeholder.
          </p>
          <SetupBlocks url={url} token="YOUR_TOKEN" />
        </div>
      )}

      {/* ------------------------------------------------------------- try saying */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-sm font-medium">Try saying</p>
        <ul className="space-y-1">
          {TRY_SAYING.map((s) => (
            <li key={s} className="text-sm text-muted-foreground">
              &ldquo;{s}&rdquo;
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The one and only sighting of a new token.
 *
 * Deliberately loud and deliberately not dismissible by accident: the plaintext is in
 * React state and nothing on the server can reproduce it, so navigating away loses it for
 * good and the only fix is creating another token.
 */
function FreshToken({
  token,
  url,
  onDismiss,
}: {
  token: string;
  url: string;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <TriangleAlert className="size-4 shrink-0" /> Copy this now — it is shown once
      </p>
      <p className="text-xs text-muted-foreground">
        Daily Edge stores only a hash of this token, so it cannot be shown again. If you lose it,
        revoke it and create another.
      </p>
      <CopyField label="Token" value={token} mono />
      <div className="space-y-3 border-t border-primary/20 pt-3">
        <SetupBlocks url={url} token={token} />
      </div>
      <Button variant="outline" className="h-10 rounded-xl" onClick={onDismiss}>
        <Check /> I&rsquo;ve copied it
      </Button>
    </div>
  );
}

function SetupBlocks({ url, token }: { url: string; token: string }) {
  return (
    <>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Claude Code</p>
        <p className="text-xs text-muted-foreground">
          Run this once. <code>--scope user</code> registers it for your whole account, so it works
          in every repo rather than only the current one.
        </p>
        <CopyField label="Claude Code command" value={CLAUDE_CODE_CMD(url, token)} mono />
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">Claude Desktop</p>
        <p className="text-xs text-muted-foreground">
          Claude Desktop speaks stdio, so <code>mcp-remote</code> bridges it to this HTTP server.
          Add the block below to <code>claude_desktop_config.json</code> and restart Claude Desktop.
          Keep the header exactly as written — there is no space after the colon, which is
          mcp-remote&rsquo;s documented workaround for clients that mangle spaces inside{" "}
          <code>args</code>.
        </p>
        <CopyField label="Claude Desktop config" value={CLAUDE_DESKTOP_CONFIG(url, token)} mono />
        <div className="space-y-0.5 pt-1">
          <p className="text-xs text-muted-foreground">
            <strong>macOS:</strong>{" "}
            <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
          </p>
          <p className="text-xs text-muted-foreground">
            <strong>Windows:</strong> <code>%APPDATA%\Claude\claude_desktop_config.json</code>
          </p>
        </div>
      </div>
    </>
  );
}

function CopyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused (insecure context, denied permission). The text
      // is selectable on screen, so say that rather than failing silently.
      toast.error("Could not copy — select the text and copy it manually");
    }
  };

  return (
    <div className="flex items-start gap-2">
      <pre
        className={cn(
          "min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted p-3 text-xs",
          mono && "font-mono",
        )}
      >
        {value}
      </pre>
      <Button
        variant="outline"
        size="icon"
        aria-label={`Copy ${label}`}
        className="size-10 shrink-0 rounded-lg"
        onClick={copy}
      >
        {copied ? <Check className="text-green-600" /> : <Copy />}
      </Button>
    </div>
  );
}

function TokenRow({ token }: { token: ApiTokenRow }) {
  const { revoke, remove } = useApiTokenActions();
  const revoked = !!token.revoked_at;

  return (
    <div className="flex items-center gap-3 p-3">
      <KeyRound
        className={cn("size-4 shrink-0", revoked ? "text-muted-foreground" : "text-primary")}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm", revoked && "text-muted-foreground line-through")}>
          {token.name}
        </p>
        <p className="text-xs text-muted-foreground">
          <code>{token.prefix}…</code>
          {revoked
            ? " · revoked"
            : token.last_used_at
              ? ` · last used ${relativeTime(token.last_used_at)}`
              : " · never used"}
        </p>
      </div>
      {!revoked && (
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 rounded-xl"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate(token.id)}
        >
          {revoke.isPending && <Loader2 className="animate-spin" />} Revoke
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete token"
        className="size-9 shrink-0 rounded-lg text-muted-foreground"
        disabled={remove.isPending}
        onClick={() => remove.mutate(token.id)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
