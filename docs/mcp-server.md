# The MCP server

Reference for the `mcp` Edge Function — transport, auth, tools and the decisions behind them.

For how MCP is used in _both_ directions in this project, including as the development loop, see [mcp-workflow.md](mcp-workflow.md).

### MCP server (Phase 7)

The fourth front door, after the browser, the Telegram bot and the push service worker — and the
only one whose caller is a config file rather than a session. `claude mcp add --scope user` is
pasted once and expected to work for months, which is why it authenticates with a long-lived
`de_...` token instead of a one-hour Supabase JWT.

**The design principle: the client is the intelligence.** The server does **no** natural-language
parsing and never calls Gemini. Daily Edge already has a Gemini parser (`parse-task`), and this
deliberately does not use it: an MCP client is a model already holding the conversation, the repo,
the branch and the diff, so it resolves "tomorrow morning" and names a tag far better than a second
model reading one bare sentence through a straw. Tools therefore take structured, well-described
parameters; the server validates them, enforces ownership, and persists.

The consequence is that **everything the client needs in order to fill those parameters well has to
be said out loud**, because there is no parser downstream to repair a bad guess. That is what
`mcp/instructions.ts` is for (sent on `initialize`): call `get_context` first to resolve relative
dates in the user's timezone and to reuse existing tags; infer tags from context (coding work →
"Coding" plus the repo name); put the repo, branch, paths, PR link and a one-line "Next: ..." in
`notes`, because the user reads it later with none of the conversation in front of them; "morning"
means their `morning_time`; search with `list_tasks` before acting on a task named by description,
and ask when more than one matches; confirm before `delete_task`.

#### Transport

- **`WebStandardStreamableHTTPServerTransport`**, not `StreamableHTTPServerTransport`. The latter
  wraps node's `req`/`res` and cannot run here; the Web Standards one speaks `Request`/`Response`
  and runs in the Edge runtime unmodified. Verified: the SDK's module graph (`zod`, `ajv`,
  `content-type`) resolves under `npm:` specifiers in the Edge runtime.
- **Stateless** (`sessionIdGenerator: undefined`) with a fresh `McpServer` per request. Edge
  invocations are ephemeral and a later request may land in a different isolate, so a session id
  would be a promise this platform cannot keep — it would resolve to "session not found" as soon as
  an isolate recycled. The bearer token carries all the identity a tool call needs.
- **`enableJsonResponse: true`**: there is nothing to stream when each response is one tool result.
- Errors are returned **JSON-RPC shaped**, not as this project's usual `{"error": "..."}` — a plain
  body surfaces in the client as a parse failure rather than as the reason the token was rejected.

#### Auth, ownership and limits

- `Authorization: Bearer de_...` → sha256 → `api_tokens`. Unknown and revoked give the _same_
  message; which it was is not something an unauthenticated caller needs to learn.
- **Ownership is the only guard.** Tools run with the service role, which bypasses RLS, so the
  token's `user_id` is all that separates two accounts. It is therefore not left to each handler to
  remember: reads go through `mine()` and single rows through `myRow()`, both of which pin
  `user_id` before the caller can add a filter, and an id from another account reads as
  **"not found"** rather than as a row. Proven in production against two accounts — see Phase 7.
- **Rate limit 120/token/hour**, counted over `mcp_tool_calls`. Per token rather than per user so
  one looping agent stops without taking out the user's other editors, and the token is the thing
  they can revoke. Checked _inside_ the tool wrapper, so `initialize` and `tools/list` cost nothing
  — a client reconnecting should not spend quota.
- Every call is logged to `mcp_tool_calls` (tool, ok/error, duration). `verify_jwt = false`, because
  the platform gate understands only Supabase JWTs and would reject every real caller.

#### Tools

Reads carry `readOnlyHint`; `delete_task` carries `destructiveHint`.

| tool                       | notes                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `get_context`              | name, timezone, local datetime + UTC offset, `morning_time`, tags with colours, channels enabled, categories followed. **Call first.** |
| `list_tasks`               | `today`/`overdue`/`upcoming`/`someday`/`done`, plus `tag`, `search`, `limit`                                                           |
| `get_task`                 | full detail; recent completions for a recurring task                                                                                   |
| `create_task`              | `source = 'mcp'`; `project` adds the "Coding" tag, a tag for the repo, and a `Project:` line in notes                                  |
| `update_task`              | partial; `null` clears `notes`/`due_at`/`remind_before`; a changed `due_at` resets the ladder                                          |
| `complete_task`            | reuses `_shared/tasks.ts` `completeTask` (roll-forward + `task_completions`); `done: false` reopens                                    |
| `snooze_task`              | `until` must be in the future                                                                                                          |
| `delete_task`              | destructive; cascades to completions and the ledger                                                                                    |
| `list_tags` / `create_tag` | counts of open tasks; colours from the web app's palette                                                                               |
| `get_news`                 | `date`, `category`, `saved_only`, `limit`; flags `via_google_news`                                                                     |
| `get_brief`                | digest at-a-glance + today + overdue + birthdays in 7 days                                                                             |
| `save_news_item`           | bookmark / unbookmark                                                                                                                  |

#### Decisions worth not relitigating

- **`due_at` without a UTC offset is rejected, not assumed.** `new Date("2026-10-13T09:00:00")`
  reads as local-to-the-server (UTC here), which for an Asia/Kolkata user silently books 2:30pm.
  A loud error the model can act on beats a reminder the user quietly stops trusting.
- **An `all_day` task's `due_at` is snapped to local midnight** server-side rather than refused:
  the ladder reads it to decide an all-day task gets only a lead reminder, and a birthday with a
  09:00 due_at would nag from 9am.
- **Unknown tag names are created.** `tasks.tags` is a text[] with no FK, so an unknown name is not
  an error — it just renders uncoloured and never appears in the tag filter. Matched
  case-insensitively so "coding" folds into "Coding". The instructions warn that a typo therefore
  becomes a permanent tag.
- **`list_tasks` groups in TypeScript, not SQL.** `taskGroup()` in `_shared/tasks.ts` mirrors
  `src/lib/task-logic.ts`: comparison is by _day_ in the user's timezone first, so a task due later
  today is "today", and an all-day task due today is never overdue. A `due_at < now()` query gets
  both wrong, and a filter that disagreed with the /tasks page would be worse than no filter.
- **`search` is sanitized** of `,()\%_` before it reaches a PostgREST `or=(...)` filter, where
  those characters are syntax: "fix(auth), part 2" would otherwise parse as extra filter clauses.
- **Rescheduling deletes the old occurrence's ledger rows** rather than keeping them as history.
  Without that, rescheduling _back_ to a time already notified would find every stage claimed and
  send nothing at all.
- **Tool results are JSON in a text block**, and the instructions tell the client to summarize
  rather than paste it. `create_task` returns a `confirm` line naming the resolved local time, so a
  wrongly resolved date is visible to the user immediately.

#### Setup (what Settings → Integrations hands the user)

- Claude Code: `claude mcp add --scope user --transport http daily-edge <fn URL> --header "Authorization: Bearer <token>"`
  — user scope so it works in every repo, not just the current one.
- Claude Desktop speaks stdio, so `npx mcp-remote` bridges it. The header is passed as
  `Authorization:${AUTH_HEADER}` with **no space after the colon**, the "Bearer " prefix living in
  the env var. That is mcp-remote's own documented workaround (README v0.14.3) for Claude Desktop
  on Windows, Cursor and Codex, which do not escape spaces inside `args` when invoking npx. It is
  harmless on macOS, so one snippet covers every platform.
  Config: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
  `%APPDATA%\Claude\claude_desktop_config.json` (Windows).
