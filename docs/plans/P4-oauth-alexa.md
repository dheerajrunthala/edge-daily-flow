# P4 — One OAuth2 endpoint, two integrations

**Model: opus.** This is the one plan with genuine design work left: an auth flow has to be
right, and the two consumers have different expectations. **Size: ~1 day.**
**Depends on: nothing in code; needs an Alexa developer account.**

## Why this is one plan and not two

Both of the remaining doors are blocked by the same missing piece.

**Alexa** needs account linking, and Alexa supports exactly one mechanism: OAuth2
authorization-code. There is no token-paste option.

**ChatGPT as an MCP client** is blocked for the same reason. Its custom-connector UI accepts
Streamable HTTP with **OAuth or no-auth** — and the `mcp` function authenticates with a static
`Authorization: Bearer de_…` header, which that UI may not let a user set. One OAuth2 endpoint
in front of the existing `api_tokens` table unblocks both.

The product side is already done and tested. `SURFACE_TOOLS.voice` in
`_shared/agent-registry.ts` exists, has an allowlist (reads plus `create_task`, deliberately no
`complete_task` — a device in a room may have misheard and shows nothing back), and is covered
by unit tests. What is missing is only the front door.

## Design constraints

- **Do not invent a new identity system.** The authorization code must resolve to a row in
  `api_tokens`, so revocation, the sha256 storage, the 120/hour rate limit and the
  `mcp_tool_calls` audit all keep working unchanged.
- **The authorize page needs a logged-in user**, so it is a frontend route that calls a
  function, not a bare function.
- Codes are **single-use with a short expiry**. `telegram_links` already does exactly this
  (`request_telegram_link()`, a code nulled on use, 15-minute expiry) — copy that shape rather
  than inventing one. See [../notifications.md](../notifications.md).
- `verify_jwt = false` on the token endpoint, and **add a `[functions.*]` block to
  `supabase/config.toml`** — an unlisted function defaults to `true` and would reject every
  real caller before the handler ran. This has nearly broken `push-action` once already.

## Shape

```
GET  /oauth-authorize   → redirects to the app's /authorize?client_id&redirect_uri&state
                          (the browser has the session; the function never sees a password)
POST /oauth-token       → authorization_code → { access_token: "de_...", token_type: "Bearer" }
                          also handles refresh_token if Alexa requires one
```

New table `oauth_codes` (user_id, code, client_id, redirect_uri, expires_at, used_at). RLS on,
**no policies** — service-role only, like `prefetch_feeds`. Follow
[../plans/../data-model.md](../data-model.md) conventions: `revoke all from anon`.

Then `supabase/functions/alexa-skill/index.ts`: verify the Alexa request signature, map the
intent to `runTool` on the `voice` surface, and return speech. Keep replies to two or three
sentences, no markdown, no URLs read aloud — the `voice` branch of the system prompt in
`functions/agent/index.ts` already does this.

## Acceptance criteria

- An authorization code is single-use and expires; replaying it fails.
- A `redirect_uri` not on an allowlist is **rejected** — an open redirector is the classic bug
  in a hand-rolled OAuth endpoint, and it is worth a test of its own.
- The issued token is a real `api_tokens` row: revoking it in Settings → Integrations
  immediately stops the Alexa skill _and_ the ChatGPT connector.
- Alexa cannot reach `complete_task` or `delete_task`. Assert it through `runTool`, not just the
  declaration list.
- `scripts/contract/` gains an OAuth flow test: authorize → exchange → call a tool → revoke →
  assert 401.
- ChatGPT connects and calls `search_news`, verified by hand, with the `mcp_tool_calls` row as
  evidence.

## Verification

Production path only. Then check `mcp_tool_calls` shows the call with `surface = 'voice'`, and
confirm revocation really does kill a live connector rather than just marking a row.

## If it overruns

Ship the OAuth2 endpoint alone and connect ChatGPT with it. That is the smaller half, it needs
no external account, and it still demonstrates the multi-client point. Alexa's console
configuration and certification is the part that cannot be rushed.
