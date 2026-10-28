# Daily Edge — AI-powered personal productivity + news brief

Multi-user web app (open signups). Built by an Indian software engineer as a showcase of practical
AI use for efficiency: task management with natural-language input, and a daily AI-curated news
digest delivered by email. Used via the published app at **https://dailyedgeapp.lovable.app**;
mobile app may come later on the same Supabase backend.

## Ownership split (important)

- **Schema** baseline was created by hand from `supabase/migrations/20261012000000_init_schema.sql`
  and `20261012000100_onboarding.sql` (run in the SQL editor). All further changes are new
  migration files in `supabase/migrations/`, applied via the Supabase MCP and committed.
- **Lovable** built the initial UI and wired it to the existing tables (no schema, no functions).
  It syncs two-way with this repo's default branch.
- **Claude Code owns everything from now on**: frontend changes, schema, Edge Functions, cron.
- Always `git pull` before starting work; push small, focused commits; never leave the tree dirty
  (Lovable may push to the same branch).
- Keep Lovable's layout: Vite + React + TS + Tailwind + shadcn/ui, Supabase client in
  `src/integrations/supabase/`. Regenerate types after schema changes.

## Stack

- Frontend: React + Vite + TypeScript + Tailwind + shadcn/ui, React Query, recharts.
- Backend: Supabase (Postgres, Auth, Edge Functions in Deno, pg_cron, pg_net, pgvector, Vault).
- AI: Gemini API — a current Flash model for parsing/summaries; a Gemini embedding model (768-dim
  output) for news similarity. Model names live in `_shared/gemini.ts` constants.
- Email: Gmail SMTP + App Password from Edge Functions (see limits below).
- MCP: the official `@modelcontextprotocol/sdk` running in the Edge runtime, so Claude Code and
  Claude Desktop can drive the app directly (see MCP server below).

## Supabase access & safety

- Use the Supabase MCP server (scoped to this project) to inspect schema/data, apply migrations,
  deploy functions, and read logs.
- This is production with real users' data. Before destructive SQL (DROP, DELETE without WHERE,
  type changes, disabling RLS) — stop and ask.
- RLS is on for every table (`user_id = auth.uid()`). New tables must enable RLS with policies.
  Edge Functions use the service role only server-side.

## Secrets — never in code, commits, or this file

Edge Function secrets (set by the owner with `supabase secrets set`):
`GEMINI_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `CRON_SECRET`,
`APP_URL` (`https://dailyedgeapp.lovable.app`),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
Vault (for pg_cron → functions): `project_url`, `cron_secret`.
The MCP server needs **no new secret**: its tokens live in `api_tokens` (sha256 only) and the
action-token signing key is HKDF-derived from the service role key.
Cron-invoked functions require header `x-cron-secret` = `CRON_SECRET`. User-invoked functions
require a valid user JWT. The browser never calls Gemini.

## Email

- Supabase Edge Functions block outbound ports 25 and 587 → use **smtp.gmail.com:465** (implicit TLS),
  e.g. `npm:nodemailer`.
- Gmail caps sending at roughly 500 recipients/day. Fine for now; keep sending behind
  `_shared/email.ts` so swapping to Resend later is one file.
- Recipient = the user's auth email (look up via service role), never GMAIL_USER.
- Every email has a footer link to `${APP_URL}/settings` to change times or turn off the digest.
- Inline-styled, simple HTML (Gmail strips <style>). Include a plain-text part.

## Notifications (Phase 5)

Every notification in the project goes out through `_shared/notify.ts`, the way every email
goes out through `_shared/email.ts`. `notify(recipient, payload, channels)` fans one payload
across the recipient's enabled channels and reports each independently, so one channel
failing never silences another.

- **Channels** live in `notification_prefs.channels` (`notification_channel` enum).
  All three deliver: `email`, `telegram` and `push` (web push — see below).
  `activeChannels()` is exported separately from `notify()` so a caller can claim its
  idempotency rows per channel before sending.
- `notify()` takes the service-role client as its first argument, because the push sender
  reads the recipient's subscriptions and prunes the dead ones.
- **Quiet hours** are enforced inside notify.ts, never by callers: it is a property of the
  user, and forgetting it at one call site is the bug that wakes someone at 3am. Wall clock
  in the user's timezone, normally wrapping midnight (22:00 → 07:00); `start = end` means
  off. Nothing is claimed or sent during the window, so the ladder simply resumes after it.

### The escalation ladder

A task that opted into reminders (`remind_before` is set) walks these stages:

| stage   | fires                                         | channels        |
| ------- | --------------------------------------------- | --------------- |
| `lead`  | the user's `remind_before`                    | all enabled     |
| `1h`    | one hour before due                           | telegram / push |
| `15m`   | fifteen minutes before due                    | telegram / push |
| `due`   | at `due_at`                                   | all enabled     |
| `nag:k` | `due_at + k × nag_interval`, while still open | telegram / push |

**Email carries `lead` and `due` only** (`EMAIL_STAGES` / `routeStage()` in check-reminders).
Email is the channel you read later, so it gets the two rungs that are still news on a
delay; the in-between rungs and every nag are push-shaped — only useful now, and an inbox
full of "still open" is how a reminder app gets muted. The filter runs **before** the
ledger is claimed, not after: a stage email never carries leaves no email row behind, and a
user whose only channel is email simply has a shorter ladder (`lead` → `due`) rather than
stages that silently go nowhere.

- **`task_notifications` is the ledger, not the timer.** One row per
  (task, occurrence, stage, channel), claimed _before_ the send and deleted again if the
  send fails — the same pattern as `brief_sends`. That is what makes a per-minute cron safe
  to run 1440 times a day, and what makes two overlapping ticks unable to double-send.
- A recurring task rolling `due_at` forward starts a **fresh ladder for free**, because the
  ledger is keyed on `due_at`.
- **Stages that coincide collapse.** With `remind_before` = 1 hour, `lead` and `1h` are the
  same instant; `plan()` keys stages by fire time so the user gets one notification.
- **A stage earlier than `tasks.created_at` never fires.** Creating a task due in five
  minutes must not immediately ping "due in 1 hour". This is also why a 5-minute test task
  only shows `lead` (if `remind_before` ≤ 5 min), `due` and the nags.
- **Several stages pending at once** (the function was down) sends only the latest; the
  older ones are written with `delivered = false` — accounted for, never fired late, and
  not pretending an email went out.
- **`snoozed_until`** retires every stage before it, permanently. The ladder resumes at the
  current nag instead of replaying what it slept through.
- **All-day tasks get only `lead`.** Their `due_at` is local midnight, so escalating through
  "due now" and nagging would mean a birthday pinging you from 00:00.
- Safety rails, deliberately opinionated: stop nagging after `NAG_WINDOW_HOURS = 48` or
  `MAX_NAGS = 24`, whichever comes first, cap `MAX_PER_USER = 5` notifications per tick, and
  drop fixed stages more than `MAX_LATENESS_HOURS = 6` late. Nags are exempt from the
  lateness horizon because `plan()` only ever emits the current one.

### Browser notifications (Phase 6)

Two independent mechanisms, and keeping them separate is the point:

- **In-app (tab open)** — `NotificationCenter`, mounted inside `AppShell`, subscribes over
  Supabase Realtime to the user's own `task_notifications` inserts and renders a toast +
  chime + tab badge. It is a **view of the ledger, not a fourth channel**: the row is
  written by check-reminders _before_ it sends, so an in-app toast cannot disagree with
  what actually went out, nothing is scheduled in the browser, and a laptop waking from
  sleep shows nothing stale because it simply never receives the rows it missed.
  `task_notifications` is in the `supabase_realtime` publication; realtime applies the
  table's own RLS (`user_id = auth.uid()`) to the socket's JWT.
  - One notification writes one row **per channel**, which arrive as separate events, so
    the component collapses on `task_id|due_at|stage` or the user gets three toasts.
  - Rows with `delivered = false` are bookkeeping for a superseded stage and are skipped.
  - The chime is synthesized in WebAudio (no asset) and must be **unlocked on the first
    user gesture** — a context created before any interaction starts suspended and cannot
    be resumed later. A reminder arriving before the first click is therefore silent.
  - Title flash and favicon badge (`src/lib/tab-alert.ts`) only run while the tab is
    hidden, and clear on focus. The title interval re-reads `document.title` whenever it
    is neither of its own two strings, so navigating mid-alert doesn't get overwritten.
- **Web push (tab closed)** — `push_subscriptions` + `public/sw.js` + the `push` channel.
  - **The VAPID public key is served by `push-subscribe`, not bundled.** The keys live
    only in the platform's secret store and rotating them needs no frontend rebuild.
    Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (raw base64url, exactly as
    `npx web-push generate-vapid-keys` prints them), `VAPID_SUBJECT`. `_shared/push.ts`
    splits the 65-byte public point into JWK `x`/`y` because Web Crypto won't import the
    raw form.
  - Sender is `jsr:@negrel/webpush` — Deno-native and Web Crypto only; verified to
    resolve in the Edge runtime. A fresh `ApplicationServer` per send batch, because its
    ECDH key is meant to be ephemeral (RFC 8291 §2).
  - **404/410 means the subscription is gone**, so the row is deleted. That is the whole
    of expiry handling, and why `sendPush` reports `removed` separately from `failed`.
    Every endpoint failing for any _other_ reason throws, so the ledger claim is released
    and the next tick retries.
  - **Done / Snooze 10m are handled in the service worker, which has no Supabase
    session** — it lives in the page's localStorage, which a worker cannot read, and the
    worker often runs with no page open. So each notification carries an HMAC **action
    token** naming one user and one task, expiring in 24h, and `push-action` trusts the
    signature instead of a bearer token. The signing key is HKDF-derived from
    `SUPABASE_SERVICE_ROLE_KEY` (salt `daily-edge/push-action`, info `v1`), so there is no
    extra secret and the derived key cannot be used as the service role. The task is
    re-read scoped to the user id _inside_ the token, exactly as the Telegram webhook
    scopes a press to the chat's user.
  - **Two buttons, not three.** Chrome renders at most two notification actions and
    silently drops the rest; "Tomorrow" stays a Telegram/app affordance.
  - `requireInteraction: true` is honoured on macOS **only** if Chrome's notification
    style is "Alerts", not "Banners" — the Settings card says so, because under Banners
    the card vanishes in seconds and takes the buttons with it.
  - `tag` is `task:<id>` + `renotify`, so a later rung replaces the earlier card in place
    and still alerts rather than stacking three "still open" notifications.
  - **The service worker is a plain `public/sw.js`, deliberately not generated.**
    `vite-plugin-pwa` (`injectManifest`) was tried and emits to `dist/service-worker.js`,
    which the nitro build never copies into `.output/public/` — it would 404 in
    production. There is also nothing to precache (the app is SSR) and nothing to inject:
    every payload carries both the URL to open and the URL to post a button press to, so
    the worker needs no build-time configuration at all.
  - **`pushsubscriptionchange` cannot tell the server** (no session in the worker), so the
    worker only re-subscribes locally and `syncSubscription()` re-upserts whatever the
    browser holds on **every app load**. That plus 404/410 pruning is how a rotated
    endpoint repairs itself.
  - Service workers need a real secure origin: **test on https://dailyedgeapp.lovable.app**,
    never the Lovable preview iframe.

### Telegram (@DailyEdgeAppBot)

- **Linking** is a one-time code: the browser calls `request_telegram_link()` (SECURITY
  DEFINER, authenticated) which mints the code in the database — the browser never invents
  it — and opens `t.me/<bot>?start=<code>`. The webhook consumes the code, binds `chat_id`,
  nulls the code, and switches the `telegram` channel on. Codes are single-use and expire in
  15 minutes. `unlink_telegram()` undoes both halves.
- **Auth** is the `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET`
  (set via `setWebhook`'s `secret_token`), then `chat_id` → `telegram_links` for identity.
  An unlinked chat can do nothing but `/start`.
- **Registration needs no local secrets**: `POST {"register": true}` with a valid
  `x-cron-secret` makes the function call `setWebhook` on itself, so it can be driven from
  `select public.invoke_edge_function('telegram-webhook', '{"register": true}')` and the bot
  token never leaves the platform's secret store. `{"info": true}` returns `getWebhookInfo`.
- Reminder cards carry inline **Done / Snooze 1h / Tomorrow** buttons; `callback_data` is
  `<action>:<task_id>` and the task is re-read scoped to the chat's user, so a guessed id
  from another account is not actionable. The card is rewritten after the press so spent
  buttons disappear.
- Task mutations the bot performs live in `_shared/tasks.ts`, which mirrors
  `src/lib/task-logic.ts` (recurrence roll-forward, "tomorrow" meaning tomorrow's date
  rather than `due_at + 1 day`) — the bot has no browser to borrow that logic from.

## MCP server (Phase 7)

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

### Transport

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

### Auth, ownership and limits

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

### Tools

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

### Decisions worth not relitigating

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

### Setup (what Settings → Integrations hands the user)

- Claude Code: `claude mcp add --scope user --transport http daily-edge <fn URL> --header "Authorization: Bearer <token>"`
  — user scope so it works in every repo, not just the current one.
- Claude Desktop speaks stdio, so `npx mcp-remote` bridges it. The header is passed as
  `Authorization:${AUTH_HEADER}` with **no space after the colon**, the "Bearer " prefix living in
  the env var. That is mcp-remote's own documented workaround (README v0.14.3) for Claude Desktop
  on Windows, Cursor and Codex, which do not escape spaces inside `args` when invoking npx. It is
  harmless on macOS, so one snippet covers every platform.
  Config: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
  `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

## The agent layer (Phase 8)

The fifth front door, and the first one with a model on _our_ side of it.

The MCP server is built on "the client is the intelligence": it does no parsing because an
MCP client is already a model holding the conversation. The agent is the opposite case —
the caller is a person typing or dictating, so the thinking has to happen here. **That is
the only difference between them.** Both sit on the same ownership guard, the same date
coercion and the same task shaping, so they differ in who thinks, not in what is true.

### What is shared, and why those parts specifically

`_shared/agent-tools.ts` owns the ownership guard (`mine`/`myRow`), every value coercion
(`parseInstant`, `parseRemindBefore`, `snapToLocalMidnight`, `parseDate`, `sanitizeSearch`),
the task shape, tag creation, and `loadUserCtx`. `mcp/tools.ts` imports all of it and keeps
only what is genuinely MCP: the zod schemas, the `ToolResult` wrapper, and the `register()`
rate-limit and audit wrapper.

The 13 MCP handler _bodies_ were deliberately **not** moved. Moving 940 more lines of
production-verified registration would be a large change for an architectural tidy, while
the parts that can drift _dangerously_ are the ones that did move. Two copies of
`parseInstant` would quietly book 2:30pm for an Asia/Kolkata user who said 9am.

`Ctx` carries **no credential**. The MCP server extends it with the API token `register()`
needs; the chat agent resolves the same shape from a session JWT; the planner builds it from
a user id on a cron tick. A tool body cannot tell them apart, which is the point — one that
could would eventually behave differently.

### Surfaces get different tools by construction

A prompt is a request; an allowlist is a rule. `SURFACE_TOOLS` in `_shared/agent-registry.ts`:

| surface    | tools                                   | why                                                          |
| ---------- | --------------------------------------- | ------------------------------------------------------------ |
| `chat`     | reads + `create_task` + `complete_task` | the user sees exactly what happened                          |
| `voice`    | reads + `create_task`                   | a device in a room may have misheard, and shows nothing back |
| `telegram` | reads + `create_task` + `complete_task` | a chat log is a record                                       |
| `planner`  | reads only                              | cron, with nobody present to notice a mistake                |

`delete_task` is absent from all four. The MCP server has it because a developer's editor
can confirm first; "delete the thing about the client" said to a speaker is not a
confirmation.

The allowlist is checked at declaration time **and** inside `runTool`. Belt and braces on
purpose: a model hallucinating a tool name it was never given would otherwise land in the
dispatcher's default branch, and that branch is holding the user's id.

### Citations are checked, not trusted

Every retrieval tool records what it returned into `run.citations`. `unknownCitations()`
then reports any URL in the answer that was not among them, and the chat UI renders those
with a warning rather than stripping them. A fabricated link is worse than a wrong summary:
the summary is visibly the model's opinion, a URL looks like a fact. Reporting rather than
stripping also means it lands in the logs instead of only in a user's confusion.

### `mcp_tool_calls.surface`

Two of the four doors carry no API token, so a row with `token_id` null would be
unattributable. `surface` is `'mcp' | 'chat' | 'voice' | 'telegram' | 'planner'`, defaulted
to `'mcp'` so the pre-existing rows stay true. It is the only record of what an agent did
while nobody was watching.

### Gemini tool-calling gotchas (these cost a whole debugging session)

- **`parameters` must be omitted entirely for a no-argument tool.** Declaring
  `{ type: "object", properties: {} }` makes `generateContent` **hang** — not 400, not 503;
  the request never returns and the platform kills the invocation with `IDLE_TIMEOUT`.
  `get_brief` was the only such tool and `plan-day` the only surface that could reach it.
  `sanitizeDeclarations()` strips an empty schema defensively, because the symptom is so far
  from the cause.
- **A hang is different information from a 503.** A 503 means "busy, retry in a second"; a
  hang means the request went in and nothing came back. So a timeout **abandons that model
  immediately** rather than spending four more attempts rediscovering it — which is what
  leaves budget to try the fallback, the thing that actually worked.
- The model's turn must be echoed back verbatim before the `functionResponse` parts, or
  Gemini rejects the response as unanchored.
- The last turn drops the tools entirely. That is what forces prose out of a model which
  would otherwise reach for one more lookup, so hitting the turn cap still produces a reply.
- Several calls can arrive in one turn; they run **in sequence**, because they share one
  database and "complete this, then list what's left" has to see its own write.

### Gemini capacity is a real operational constraint

`gemini-flash-latest` is an alias, so we share its capacity with everyone pointing at the
same one, and it answers 503 "high demand" often enough to have lost three days of digests
(2026-10-24, -25, -28). The policy that works:

- **5 attempts, backing off 1s/2s/4s/8s**, jitter 500ms so the per-category ingest fan-out
  does not retry in lockstep and re-create the spike. The old policy — 3 attempts over about
  two seconds — was a formality, not a retry.
- **`GEMINI_FALLBACK_MODEL` = `gemini-flash-lite-latest`**, a different capacity pool, for 2
  more attempts. A digest ranked by the cheaper model is enormously better than no digest.
  Verified: plan-day's successful run was answered by the fallback.
- **Per-call deadline (25s) and a total budget (90s).** An unbounded fetch inside a 150s
  runtime is not a long wait, it is a lost error.
- `embedBatch` gets the same policy. On 2026-10-28 ingest pooled 138 articles and embedded
  only 99 — and an article with no vector is invisible to topic matching and follow-up
  linking _forever_, because articles are upserted with `ignoreDuplicates` on a unique url.

### Known structural gap

`build-digests` iterates users in one invocation with no per-user time budget, so one slow
user starves the rest. On 2026-10-28 a leftover QA account spent 140s on Gemini retries and
the real user's digest row was claimed at 01:32:21 and killed at 01:32:33 — which is why it
sat in `pending` and never reached `failed`: nothing survived to write a status.
`ingest-news` solved this with `fanout_ingest_news()`; build-digests has no equivalent yet.

## Vector retrieval (Phase 8)

Embeddings existed from Phase 3 and nothing ever read one. Now:

- **HNSW indexes** on `articles.embedding`, `news_items.embedding` and `topics.embedding`.
  HNSW over IVFFlat because IVFFlat's lists need retuning as a table grows and HNSW needs no
  training pass. `vector` lives in the **`extensions`** schema here, so every function pins
  `set search_path = public, extensions` or the parameter type will not resolve.
- `match_news_items`, `match_articles`, `match_topics_pool`, `link_followups` — all SECURITY
  DEFINER with the owner resolved as `coalesce(auth.uid(), p_user_id)`, so a signed-in caller
  can only ever reach their own rows whatever it passes, while the service-role path still
  works. `anon` is revoked, so the null-uid branch is unreachable from the publishable key.

### Both thresholds were wrong when guessed — measure, don't intuit

- **Follow-up linking: 0.90, not the 0.85 this file used to specify.** Over 316 embedded
  items the median nearest cross-digest neighbour sat at **0.8494**, so 0.85 badged 157 of
  316 — half the feed. Reading the pairs by band: 0.82–0.89 is "same category, unrelated
  story", 0.90+ is genuinely one thread. 0.90 keeps about 11%.
- **The link must point backwards.** `digest_id <> digest_id` alone is symmetric, so an item
  would cite tomorrow's coverage as the story it follows up on. `prior.created_at <
n.created_at` is what makes the badge mean what it says.
- **Topic matching: 0.80.** `gemini-embedding-001` at 768 dims compresses _everything_ into
  roughly 0.75–0.88, so a 0.5 floor ("at least half related") matches the entire archive.
  Measured over seven probe labels: covered topics peaked at 0.8758 / 0.8498 / 0.8448 /
  0.8401 (dev tooling, RBI policy, Kubernetes security, Indian semiconductors), uncovered
  ones at 0.7906 / 0.7817 / 0.7735 (Formula 1, Indian cricket team, cricket results). 0.80
  sits in that gap so an uncovered topic returns **nothing** rather than the four
  least-unrelated stories. 0.82 was rejected: it cuts a well-covered topic from 12 to 3.
- **Topic labels must be embedded with `taskType: "SEMANTIC_SIMILARITY"`**, matching what
  ingest-news uses for articles. `RETRIEVAL_QUERY`/`RETRIEVAL_DOCUMENT` are deliberately
  asymmetric; mixing them gives no error, just plausible-looking matches that are wrong.

## Topics: what you follow is a vector query (Phase 8)

A topic is a sentence the reader writes, embedded **once**, matched against the shared pool
by cosine similarity. One embed call per topic _ever_ and zero per digest, so the cost model
holds — the marginal cost of a twentieth interest is still nothing. It also turns a
documented wart into the design: once retrieval is a vector query, "a category's pool can
contain articles that arrived via another category's feeds" stops being a leak.

Topics **union** with categories rather than replacing them, so an account with no topics
gets exactly the digest it got before.

- `topics` has **no insert policy**. Creating one means embedding its label, the browser
  never calls Gemini, and a row without a vector silently matches nothing — so inserts go
  through the `topics` function on the service role.
- Updates are narrowed by **column grant** to `enabled` and `weight`, the same way
  news_items grants only `is_saved`/`read_at`. Editing a label would have to re-embed, so it
  is a delete and re-add.
- The **preview** is the point of the UI, not decoration: a topic is a guess until you see it
  hit something, and an interest we have no feeds for should announce itself rather than
  contributing nothing to every digest forever. It reports `covered` and the best similarity
  even when nothing clears the floor.

## Feature switches (Phase 8)

`user_features` + `_shared/features.ts`. The gate is read at **each function's entry point
through one helper**, for the same reason quiet hours live inside `notify.ts`: it is a
property of the user, and forgetting it once is the bug that messages someone who switched
it off. A toggle that only hides a nav item is decoration.

- **An absent row means the default**, so adding a feature needs no backfill and a failed
  read falls back to the default — "it works" rather than "it stopped for everyone".
- **`planner` is the only feature defaulting off.** A cron job that messages you at 9am is
  something you agree to, not something you discover.
- `filterEnabled()` narrows a list of ids in one query, because the cron functions iterate
  users and a round trip each is exactly the per-user cost the pipeline avoids.
- The browser's copy (`FEATURES`/`featureDefault` in `src/lib/queries.ts`) and the Edge copy
  are a **fourth mirrored pair** — see the drift note below. There is a parity test.

## Data model (source of truth = migration files)

- `profiles` (id, full_name, timezone default 'Asia/Kolkata', news_profile, onboarded_at)
- `tags` (user_id, name, color token; 6 defaults seeded on signup by `handle_new_user`)
- `tasks` (title, notes, due_at null = someday, all_day, recurrence none|daily|weekly|monthly|yearly,
  priority, status todo|done, tags text[] of tag names, remind_before interval, last_reminded_at,
  completed_at, source manual|ai)
  - Completing a recurring task inserts `task_completions` and moves `due_at` to the next occurrence.
  - Birthdays = yearly tasks tagged "Birthday".
- `task_completions` (task_id, due_at of the occurrence, completed_at)
- `news_prefs` (categories text[], headline_count 10|20|30, email_times text[] 'HH:MM' in the user's
  profile timezone, enabled)
- `digests` (user_id, digest_date, status pending|ready|failed, summary, items_count,
  sources_scanned, emailed_at) unique per user per day
- `news_items` (per-user digest entries: category, headline, summary, why_it_matters, url, source,
  importance, rank, embedding, related_item_id, is_saved, url_resolved — users may only update
  is_saved)
- `articles` — the shared daily pool (category, url unique, title, source, feed_name, tier,
  source_count, published_at, summary, embedding vector(768), url_resolved, fetched_on).
  RLS: authenticated read only; the service role writes. `url` is unique across all time, so an
  article is summarized and embedded exactly once, ever.
- `brief_sends` (user_id, sent_for date, slot 'HH:MM', digest_id, unique on the first three)
  — the idempotency record for send-briefs. Owner-readable.
- `notification_prefs` (user_id, channels `notification_channel[]` default `{email}`,
  quiet_start/quiet_end `time` default 22:00–07:00, nag_interval interval default 15 min)
  — owner-managed, seeded by `handle_new_user`.
- `task_notifications` (user_id, task_id, due_at of the occurrence, stage, channel,
  delivered, sent_at, unique on (task_id, due_at, stage, channel)) — the escalation ledger.
  Owner-readable; the service role writes.
- `tasks.snoozed_until` — "not now"; suppresses every stage before that instant.
- `telegram_links` (user_id, chat_id unique, one-time code + expiry, linked_at)
  — owner-readable only; written by `request_telegram_link()` and the webhook.
- `push_subscriptions` (user_id, endpoint **unique**, p256dh, auth, user_agent,
  last_used_at) — one row per browser that granted permission. The endpoint is the natural
  key, so re-subscribing updates rather than duplicates. Owner may select and delete (the
  Settings list and "turn off"); only `push-subscribe` writes, via the service role.
- `api_tokens` (user_id, name, token_hash **sha256 hex, unique**, prefix for display,
  last_used_at, revoked_at) — the MCP server's credentials. Minted only by
  `create_api_token()`; the plaintext exists in that one response and nowhere after.
  Owner may select/update/delete, but **column grants withhold `token_hash`**, so the
  frontend must select named columns and never `*`.
- `mcp_tool_calls` (user_id, token_id on delete set null, tool, ok, error, duration_ms)
  — one row per MCP tool call. The per-token rate limit counts it, and it is the only
  record of what an agent did while nobody was watching. Owner-readable.
- `notification_prefs.morning_time` (`time`, default 09:00) — what "tomorrow morning"
  resolves to; handed to the MCP client by `get_context`.
- `tasks.source` now allows `'mcp'`: neither hand-typed nor Gemini-parsed, and the one
  source where no human saw the task before it was saved.
- `prefetch_feeds` / `prefetch_requests` — plumbing for the Google News workaround below.
  RLS on with **no policies**: service role and SECURITY DEFINER functions only.
- `topics` (user_id, label, embedding vector(768), enabled, weight) — the interests a reader
  writes in their own words. HNSW index; unique on `(user_id, lower(btrim(label)))` so
  "coding" and "Coding" are one interest. **No insert policy**; UPDATE granted on `enabled`
  and `weight` only.
- `user_features` (user_id, feature, enabled) — the switches. An absent row means the default
  resolved in `_shared/features.ts`. Fully owner-managed, unlike the tables above, because
  changing it is the entire point.
- `plan_sends` (user_id, sent_for date, unique on both) — the planner's idempotency ledger,
  claimed before the Gemini call and released on a failed send. `brief_sends`' pattern.
- `mcp_tool_calls.surface` — which door made the call, defaulted to `'mcp'`.
- `tasks.source` now also allows `'agent'`: a conversation the user was present for, as
  distinct from `'ai'` (one parsed sentence they reviewed) and `'mcp'` (nobody watching).
- `ai_events.kind` now also allows `'agent'` and `'plan'`, each with its own daily limit.
- `ai_events` (user_id, kind, items_processed, tokens) → Insights page + rate limiting.
  `user_id` is **nullable**: ingest-news is shared work with no owning user, and a null row
  matches no RLS policy, so it stays out of every user's view and rate limit.

## Cost-aware news design (multi-user)

Never run the full Gemini pipeline per user. Built in Phase 3 and live:

1. `ingest-news` (cron, once daily ~06:30 IST / 01:00 UTC): for every category any enabled user
   follows, fetch that category's feeds, run the item pipeline below, then summarize + embed
   **once** into the shared `articles` pool.
2. `build-digests` (cron, right after): per user, a single Gemini call ranks that day's pooled
   articles for the user's categories against `profiles.news_profile`, picks top N, writes
   `why_it_matters`, and inserts `digests` + `news_items` (copying fields + embedding).
   Still to do (Phase 6) — follow-up linking: nearest neighbour among that user's `news_items`
   from the last 14 days (cosine similarity threshold ~0.85, tune it) → `related_item_id`.

### Item pipeline (helpers all live in `_shared/feeds.ts`)

1. **Parse + normalize** (`fetchFeed`/`parseFeed`) — strip tracking params, repair the SEBI quirks,
   resolve the publisher domain (for aggregator items from `<source url>`, not the feed name).
2. **Resolve redirect links** (`resolveItemUrl`) — unwrap the legacy `?url=` form and follow
   redirects. **Known limitation:** current Google News `/rss/articles/CBMi…` links cannot be
   resolved server-side at all — the id is opaque, the article page does the hop in client-side JS,
   and the `DotsSplashUi`/`Fbv4je` RPC that every library used now returns an empty result even
   with the page's own signature and timestamp (all three verified against live links 2026-10-12).
   Those items keep the Google link with `resolved: false`; the link still works in a browser, and
   step 4 prefers a direct feed's URL for the same story whenever one exists. Re-test occasionally.
3. **Enrich thin excerpts** (`fetchExcerpt`) — several feeds ship a headline and nothing else
   (Hugging Face, the GitHub release feeds, RBI). Below `THIN_EXCERPT_CHARS` the article page is
   fetched and its `og:description` / meta description used instead. Guards that matter: skip
   unresolved Google News links (their page describes Google News), skip non-`text/html` (SEBI
   links straight to PDFs), and require 60+ characters because Hugging Face serves "A Blog post
   by Ai2 on Hugging Face" and RBI "Press Releases - Reserve Bank of India" for every article.
   The floor has a real cost: some pages have nothing usable at all, and those keep a
   title-only summary. Measured on a repair run over 8 such articles, 5 were fixed and 3 were
   not — Hugging Face (boilerplate on every post), a Substack whose description names its
   audience rather than its content, and a page with no description tag. Reading the page body
   instead would need real content extraction: the first `<p>` on a Hugging Face blog post is
   the site navigation, so a naive body fallback would summarize a menu.
4. **Filter junk** (`isJunk`) — sponsored/brand-post/advertorial, plus the stock-tip genre that
   floods the Indian market feeds (multibagger, "top 5 stocks to buy", "trade setup", target
   prices) and recurring filler. Tip patterns match on the **title only**: a real story may quote
   an analyst's target price in its body. Typically drops ~17 of 600 items.
5. **Merge duplicates** (`mergeStories`) — exact URL first, then headline similarity
   (`DUPLICATE_THRESHOLD = 0.45` Jaccard over stopword-filtered title tokens, within one category).
   Produces `source_count` = distinct newsrooms carrying the story (`publisherKey` folds `m.`/`amp.`
   hosts and split domains like ET's, so one newsroom never counts twice). The canonical item is
   picked as resolved-URL > higher tier > longer headline — so an aggregator can tell us a story is
   big while a primary source supplies the link.
6. **Categorize from content** — the summarize call also returns the `category`, constrained to
   the enum in `NEWS_CATEGORIES`. The feed's category is passed only as a hint and is often
   wrong: a Reuters _tech_ query carries rupee/RBI stories, an Indian startup query carries
   DeepSeek funding. Anything outside the enum keeps the feed's category. ~20% of items get
   re-filed. Note this means a category's pool can contain articles that arrived via another
   category's feeds.
7. **Rank** — `describeForRanking` renders one line per story carrying `tier` and `source_count`,
   the two signals the model cannot infer from a headline. Instruct it to treat `primary` as
   authoritative, and a high `source_count` as corroboration/importance rather than as quality.

- **URLs must come only from fetched feed items.** `build-digests` has the model return indices
  into the candidate list instead of URLs, so there is nothing to validate after the fact.

### Measured in production (2026-10-12, 5 followed categories, 43 feeds)

Fan-out run, one invocation per category:

| category               | runtime | parsed | in window | stories | shortlist | new | inserted |
| ---------------------- | ------- | ------ | --------- | ------- | --------- | --- | -------- |
| AI                     | 39.0s   | 600    | 119       | 112     | 40        | 31  | 31       |
| Indian Stock Market    | 30.9s   | 270    | 219       | 176     | 40        | 20  | 20       |
| Global Tech            | 22.7s   | 149    | 121       | 118     | 40        | 18  | 18       |
| Indian Startups & Tech | 14.7s   | 204    | 78        | 69      | 40        | 10  | 10       |
| Software Development   | 13.8s   | 117    | 15        | 15      | 15        | 2   | 2        |

- **14 Gemini calls**, 10.0k input / 4.4k output tokens across the five invocations.
  Longest single invocation **39s** against the 150s wall clock (the old single-invocation
  run was 71s and growing with every feed added).
- `build-digests`: 14s, **1 Gemini call**, 16.6k input / 1.3k output, 171 candidates → 20 items.
  The marginal cost of each extra user is still one flash call over the same pool.
- Pool that day: 198 articles, 59 publishers, 68 aggregator-tier, 54 unresolved URLs,
  11 stories corroborated by more than one newsroom.

### Google News is blocked from the Edge runtime — fetched from Postgres instead

All Google News feeds answer **HTTP 503** inside an Edge Function while the identical URL
returns 200 from Postgres egress (`net.http_get`) and from a laptop: Google blocks the
functions network's IP range. Retries cannot fix a block, so the aggregator tier is fetched
by the database instead:

1. `prefetch_feeds` holds the aggregator URLs. **ingest-news writes this table on every
   run** from `FEEDS`, so `_shared/feeds.ts` stays the single source of truth and adding a
   feed needs no SQL change.
2. `prefetch_aggregator_feeds()` (cron 00:50 UTC, 10 min ahead of ingest) fires one
   `net.http_get` per URL and records the request id → URL mapping in `prefetch_requests`,
   because `net._http_response` does not store the URL.
3. `get_prefetched_feeds(interval)` — service-role-only RPC — returns `(url, status_code,
content)` for requests newer than the interval. `ingest-news` prefers a prefetched body
   and falls back to a direct fetch on a miss, so a failed prefetch degrades rather than breaks.

Verified: all 9 aggregator feeds prefetch at HTTP 200 (153KB for the AI query), and a run
pooled 68 aggregator-tier articles of which 54 carry `url_resolved = false`.

## Cron (UTC)

| when           | job                         | what                                                                |
| -------------- | --------------------------- | ------------------------------------------------------------------- |
| `50 0 * * *`   | `prefetch-aggregator-feeds` | pg_net fetches the aggregator tier                                  |
| `0 1 * * *`    | `fanout-ingest-news`        | `fanout_ingest_news()` → one ingest-news call per followed category |
| `30 1 * * *`   | `build-digests`             | one Gemini call per user over the shared pool                       |
| `*/15 * * * *` | `send-briefs`               | emails whoever's `email_time` falls in this window                  |
| `* * * * *`    | `check-reminders`           | the task escalation ladder (see Notifications)                      |
| `*/15 * * * *` | `plan-day`                  | the morning plan, for users whose `morning_time` is in the window   |

Defined in `20261012072101_cron_schedules.sql`; `check-reminders` was moved to every
minute by `20261012090000_notifications.sql`. `invoke_edge_function(name, body)` reads
`project_url` and `cron_secret` from Vault, so no secret is ever inlined into a
`cron.job` row. **To run any of these by hand, call the same SQL** rather than inventing a
new path — it is the exact production path.

## Edge Functions

1. `parse-task` (user JWT) — free text → Gemini with JSON response schema → array of tasks.
   The parsing itself is `_shared/parse-tasks.ts`, shared with the Telegram bot so the
   prompt, schema and rate limit cannot drift between the two front doors. Each task carries
   (title, notes, due_at ISO with the user's UTC offset, all_day, recurrence, priority, tags,
   remind_before). Pass today's date, weekday and the user's timezone + existing tag names in the
   prompt. Returns a preview only; the UI saves. Rate limit: 50 calls/user/day (count `ai_events`).
2. `ingest-news` (cron secret) — builds the shared pool. Fetches only the categories some
   enabled user follows, applies the recency windows, junk filter and merge, cuts to 40
   candidates per category, then summarizes in batches of 12 on `GEMINI_BULK_MODEL` and embeds
   in batches of 50. Upserts into `articles` with `ignoreDuplicates`, so a URL already pooled is
   never re-summarized. Returns per-category counts, gemini_calls and token totals.
   **Repair pass:** `{"repair": true, "limit"?: n}` re-summarizes pooled articles whose
   summary is really just their headline — the scar `summarize` leaves whenever the model
   skips an item or a batch errors. It re-runs the same enrichment and summarizer, writes a
   fresh embedding (the old vector was derived from the bad summary), and carries the fix
   into any `news_items` row that still holds the old copy. Articles with no usable
   description are left alone rather than rewritten badly. Safe to re-run.
3. `build-digests` (cron secret, optional `{user_id, force}` body) — **one** Gemini call per user
   per day on `GEMINI_PARSE_MODEL`: it ranks that day's pool for the user's categories against
   `profiles.news_profile` and writes importance + why_it_matters. The model returns **indices**
   into the candidate list, never URLs or headlines — those are copied from `articles`, which is
   how the "URLs only from feed items" rule is enforced structurally. Writes `digests` +
   `news_items` and logs an `ai_events` row of kind `digest`.
4. `send-briefs` (cron every 15 min) — for each enabled user, is one of their `email_times`
   inside the current 15-minute window **in their timezone** and not yet sent today? Then build
   the email from what is already in the database — the digest's "at a glance", today's tasks,
   overdue, birthdays in the next 7 days, news by category with links — and send it. **No Gemini
   call.** Idempotency is the `brief_sends` unique constraint, claimed _before_ the send so two
   overlapping ticks cannot both email; a failed send **releases** the claim, otherwise one SMTP
   hiccup would mark the slot sent and the user would silently get nothing that day. An item with
   `url_resolved = false` is labelled "via Google News".
5. `check-reminders` (cron **every minute**) — the escalation ladder described under
   Notifications. Computes each open reminder task's stages, claims the current one in
   `task_notifications` per channel, fans out through `notify()`, releases the claim on a
   failed send, and stamps `last_reminded_at` for the rest of the app. A tick with nothing
   due is one indexed query and returns in well under a second.
6. `push-subscribe` (user JWT) — `{"action":"key"}` returns the VAPID public key;
   `subscribe` / `unsubscribe` store and drop a browser's `PushSubscription`; `test` sends
   a test notification. Subscribing switches the `push` channel on, and unsubscribing the
   **last** device switches it off — one laptop going quiet must not silence the phone.
   `test` calls `sendPush` directly rather than `notify()`: the user is standing there
   asking for it, so quiet hours are not what they're testing.
7. `push-action` (**no JWT**; authenticated by the HMAC action token described under
   Notifications) — the Done / Snooze 10m buttons on a desktop notification. Does nothing
   but those two mutations on the one task the token names.
8. `mcp` (**no JWT**; `Authorization: Bearer de_...` against `api_tokens`) — the MCP server.
   See the section below; it is the only function that answers a protocol rather than a
   JSON body, and the only one whose caller is a config file rather than a session.
9. `agent` (user JWT) — the conversational door. Gemini tool-calling over
   `_shared/agent-registry.ts` with a per-surface allowlist, a 6-turn cap, and 60
   conversations/user/day counted off `ai_events`. Gated on the `chat` feature at its entry
   point. Returns the answer, its citations, the tool calls it made, and any link it cited
   that no tool returned.
10. `plan-day` (cron secret, every 15 min) — the autonomous morning planner. Read-only tool
    allowlist, gated on the `planner` feature (which defaults off), claimed in `plan_sends`
    before spending, delivered through `notify()` so it inherits quiet hours and the channel
    fan-out. Verified in production: 3 tool calls in one turn, answered by the fallback
    model, delivered on email + telegram + push.
11. `topics` (user JWT) — `preview` / `add` / `reembed`. The only path that creates a topic,
    because creating one means embedding its label and the browser never calls Gemini.
12. `telegram-webhook` (**no JWT**; `x-telegram-bot-api-secret-token` verified against
    `TELEGRAM_WEBHOOK_SECRET`) — `/start <code>` linking, `/today` `/tasks` `/brief` `/help`,
    free text → `parseTasks()` → rows in `tasks` (no preview step in a chat), and the
    Done / Snooze 1h / Tomorrow buttons. Always answers 200 after the secret check, because a
    non-200 makes Telegram redeliver the update forever. Also self-registers on
    `{"register": true}` + `x-cron-secret`.

## Source map (`_shared/feeds.ts`) — all URLs verified 2026-10-12

Every feed is `{ url, name, category, tier }`. **Tier is the trust signal** and is passed to the
ranking prompt:

- `primary` — the actor speaking for itself (regulator, lab, release feed). First-hand facts.
- `trusted` — a newsroom with an editor, reporting on someone else.
- `aggregator` — Google News / Hacker News. Best recall and the signal of what is breaking, but
  no editorial control and the links need cleaning.

43 feeds: 15 primary, 19 trusted, 9 aggregator.

- **AI**: OpenAI, Google DeepMind, Hugging Face blogs (primary) · MIT Technology Review,
  Simon Willison, The Verge AI, **TechCrunch AI**, **The Decoder** (trusted) · Google News
  `"artificial intelligence"`, **`hnrss.org/newest?q=AI+OR+LLM&points=50`** (aggregator).
  The two newsrooms and the hnrss query were added because the lab blogs post every few
  days: one run found only 5 AI candidates all day. Now ~40.
- **Software Development**: GitHub Blog + `releases.atom` for node, TypeScript, Deno, React, Vite,
  Tailwind, Supabase, Postgres (primary) · InfoQ (trusted) · `hnrss.org/frontpage?points=100`
  (aggregator — the points threshold is why we use hnrss over the official HN feed)
- **Indian Stock Market**: RBI press releases + RBI notifications + SEBI (primary) · ET Markets,
  Livemint Markets, Business Standard Markets (trusted) · Google News IN `Sensex OR Nifty`
- **Indian Startups & Tech**: Inc42, Entrackr, YourStory, Livemint Companies, Business Standard
  Companies (trusted) · Google News IN `India startup funding`
- **Global Tech**: The Verge, TechCrunch, Ars Technica (trusted) · Google News
  `technology site:reuters.com` (aggregator — Reuters killed its public RSS, a site: query is the
  only way in)
- **Policy & Regulation**: MediaNama, Business Standard Economy & Policy (trusted) · Google News
  `site:pib.gov.in`, `(DPDP OR "data protection" OR TRAI OR MeitY) India`, `"AI regulation"`
- X/Twitter highlights: later phase (X API is paid). Option: Gemini with Google Search grounding,
  using only URLs from grounding metadata.

### Feed gotchas (all of these cost an hour to find; don't rediscover them)

- **Send a browser User-Agent.** Business Standard answers 403 to anything bot-shaped. `feeds.ts`
  sets this for every fetch.
- **Dead, in `DROPPED` with reasons — do not re-add**: **VentureBeat** (HTTP 429 on every path,
  spaced out — a block, not rate limiting to wait out); no Ars Technica AI feed exists;
  PIB's `RssMain.aspx` (serves an `<rss>` with
  an empty `<channel>` for every ModId/Regid combination, so PIB is reached via a `site:` query
  instead); **Moneycontrol** (feed abandoned, newest item 23 Apr 2024 — it was in the old plan);
  Anthropic (no public RSS); the old `deepmind.google/discover/blog` path.
- Entrackr is `/rss`; `/feed` 404s.
- SEBI emits `"09 Oct, 2026 +0530"`, which `Date.parse` rejects → `parseFeedDate` has a fallback.
  SEBI also prefixes its own origin onto already-absolute links → `normalizeUrl` unwraps that.
- OpenAI and Hugging Face serve their whole archive in one feed (1287 and 876 items), so
  `parseFeed` caps at the 150 newest per feed.
- GitHub release feeds and the lab blogs often have nothing in a 24h window. That is normal, not
  broken — don't drop them for a quiet day.
- A live 24h pull yields roughly **600 items → ~520 stories after junk filtering and merging**.

## Edge runtime gotchas (not feed-specific)

- **`dayKey()` in `_shared/time.ts` must take `Date | string`.** `src/lib/tz.ts` always did
  `new Date(date)` inside it; the Edge copy did not, while half its callers pass an ISO timestamp
  straight out of Postgres. Intl's `formatToParts` coerces a string with `ToNumber`, gets `NaN` and
  throws `RangeError: Invalid time value` — so `nextOccurrenceAhead` threw on its `allDay` branch,
  i.e. every time an **all-day recurring task (a birthday)** was completed from Telegram or a push
  button. Fixed 2026-10-12 with a regression test in `_shared/time.test.ts`; the vitest `include`
  was widened to cover `_shared/*.test.ts`, which works only because time.ts has no `npm:`/`jsr:`
  imports. Every function that bundles time.ts was redeployed from the fixed commit and
  verified byte-identical to the repo; the roll-forward of an all-day yearly task was then
  re-run end to end against the live runtime.
- Anything mirrored between `src/lib/` and `_shared/` can drift exactly like that. When touching
  one, check the other: `tz.ts`↔`time.ts`, `task-logic.ts`↔`tasks.ts`, and now the feature
  defaults in `queries.ts`↔`features.ts`. There is a `mirror-drift-checker` subagent, and a
  parity test for the feature pair that runs both copies over the same list.
- **`Date.parse` on a string with no timezone reads as server-local.** V8 parses a zoneless
  "09 Oct, 2026" leniently as midnight in the _host's_ zone, so `parseFeedDate` resolved a SEBI
  item to a different calendar day in the Edge runtime (UTC) than on an Asia/Kolkata laptop —
  and `isRecent()` therefore disagreed with itself depending on where it ran. The day-month-year
  shape is now matched _before_ `Date.parse` gets a chance, and pinned to UTC. Found by the
  first test ever written for feeds.ts; production was accidentally right, being UTC.
- **A missing export is a boot failure, not a type error.** `import { X }` where the module
  does not export `X` makes the isolate refuse to start, and pg_net sees
  `{"code":"BOOT_ERROR"}` with nothing in the function logs.
- **An unbounded `fetch` loses the error.** The wall clock is 150s; a hung upstream call means
  the platform kills the invocation with `IDLE_TIMEOUT` and nothing that was going to be
  logged ever is. Every Gemini call carries its own deadline for this reason — keep that true
  of any new network call.
- **Read logs with `event_message`, the top-level column.** `log_attributes['event_message']`
  returns empty strings, which looks exactly like a function that logged nothing. And run
  `select now()` before choosing a window: one guessed from local time is hours off and
  returns nothing, which also looks like silence.

## Frontend routes

`/` landing (logged out) · `/login` · `/onboarding` · `/brief` · `/tasks` · `/news` · `/ask` ·
`/insights` · `/settings`

`/ask` is the conversational surface: citation cards, a visible trace of which tools ran and
which of them wrote something, the remaining daily quota, and dictation via the browser's own
SpeechRecognition (`src/lib/speech.ts`, behind a support check — Firefox has no
implementation).

Settings carries the Integrations card (`src/components/integrations-settings.tsx`): create, list
and revoke MCP tokens, with copy-paste setup for Claude Code and Claude Desktop.

## Roadmap

- [ ] Phase 1: review Lovable draft against schema; fix data wiring, recurrence roll-forward, types
- [ ] Phase 2: `parse-task` + quick-add preview, rate limiting
- [x] Phase 3: `articles` pool migration, `ingest-news`, `build-digests`, `url_resolved` +
      "via Google News" tag in the news card. Both functions are deployed and have been run
      end to end; **cron is not wired yet** (that migration is Phase 4).
- [x] Phase 4: `send-briefs` + `check-reminders` + all five cron schedules. Gmail SMTP is
      live and verified: a real brief was delivered (20 stories, 2 tasks, 5.1s), `brief_sends`
      linked it to the digest and stamped `digests.emailed_at`, and re-firing the same slot
      answered "already sent" without a second email. `check-reminders` runs clean but its
      SMTP path is still unexercised — no task has `remind_before` set yet.
- [x] Phase 5: Notifications. `notification_prefs`, `task_notifications`,
      `tasks.snoozed_until`, `telegram_links`; `_shared/notify.ts`; check-reminders reworked
      into the escalation ladder on a per-minute cron; `telegram-webhook` with linking,
      inline buttons, commands and free-text task capture; Settings UI for channels, quiet
      hours and the nag interval.
      **Verified in production 2026-10-12:** Telegram linking end to end (`chat_id` bound,
      one-time code consumed, the `telegram` channel switched on by the webhook); `lead`
      delivered to email + Telegram at 14:21:04, one tick after its fire time; `15m`
      delivered to **Telegram only** with no email row written, which is the routing rule
      holding; the Done button completing a task from the chat. **Not yet exercised:** the
      `due` and `nag:k` rungs (the test task was completed four minutes before it came
      due), `1h`, quiet-hours suppression, snooze and Tomorrow, and the free-text →
      `parse-task` path from a chat.
- [ ] Phase 6: Insights page with real data, PWA polish. **Follow-up linking is done** —
      see Vector retrieval (Phase 8); the threshold it specified turned out to be the median.
      **Browser notifications are done** (2026-10-12): in-app realtime toast + chime +
      tab/favicon badge, `push_subscriptions`, `public/sw.js`, `push-subscribe`,
      `push-action`, the `push` sender in `notify.ts`, and the Settings card with
      enable/test and the macOS "Alerts" hint. Verified: both functions boot in the Edge
      runtime (so `jsr:@negrel/webpush` resolves), `push-action` rejects an unsigned
      token, and check-reminders still returns 200 on the new module graph.
      **Not yet exercised:** a real end-to-end push to a granted browser, the Done /
      Snooze buttons from a notification, and expiry pruning on 404/410.
- [x] Phase 7: **MCP server.** `api_tokens` + `create_api_token()`, `mcp_tool_calls`,
      `notification_prefs.morning_time`, `tasks.source = 'mcp'`; the `mcp` Edge Function with
      13 tools; Settings → Integrations. **Verified in production 2026-10-12** against two
      throwaway accounts: all 13 tools over HTTP, a full handshake with the official SDK
      client (instructions delivered, 13 tools listed, create → delete round trip), every
      validation rejection, the 120/hour rate limit returning 429, token revocation, and
      **cross-user isolation** — token B could not read, update, complete, snooze, delete or
      save any of user A's tasks or news items, and A's rows were untouched afterwards.
      **Not yet exercised:** a real Claude Code session from a repo (the owner connects their
      own token), and Claude Desktop via `mcp-remote`.
- [x] Phase 8: **the agent layer.** Vector retrieval (`match_news_items`, `match_articles`,
      `match_topics_pool`, `link_followups` + HNSW indexes), topics as vector queries, the
      shared tool registry, `generateWithTools`, the `agent` function and `/ask` with
      dictation, feature switches, and the `plan-day` autonomous planner.
      **Verified in production 2026-10-28:** the refactored MCP server byte-identical to its
      pre-refactor output across get_context / list_tasks / search / create → delete, with
      `parseInstant` still rejecting an offset-less `due_at` and "coding" still folding into
      "Coding"; follow-up linking backfilled 14 correct links over 30 digests, every one
      pointing earlier (the Jio IPO thread came out as Oct 15 → 18 → 25); `build-digests`
      rebuilt a `ready` digest with 20 items from 105 candidates; `plan-day` called three
      tools in one turn, fell through to the fallback model, and delivered on email +
      telegram + push; and the feature gate held — the run before the `planner` row existed
      spent nothing and said "no users due for a plan".
      **Also fixed, found while building:** three days of missing digests (a leftover QA
      account starving the invocation plus a retry policy that was a formality), and a
      host-timezone bug in `parseFeedDate`.
      **Not yet exercised:** the `agent` function's happy path from a browser session (a user
      JWT cannot be minted from a Claude Code session — the owner must try `/ask`), dictation
      on a real microphone, and the `voice` and `telegram` surfaces of the registry.
- [ ] Phase 9 (optional): weekly review email, X highlights, Google Calendar, an Alexa skill
      on the same agent, and a per-user time budget for `build-digests`.

## Working conventions

- Test each Edge Function by invoking it and reading logs via MCP before wiring cron.
- `npm run build`, `npm run lint` and `npm test` must pass before committing.
- Shared helpers in `supabase/functions/_shared/` (gemini.ts, email.ts, notify.ts, push.ts,
  telegram.ts, supabase.ts, feeds.ts, time.ts, tasks.ts, parse-tasks.ts, agent-tools.ts,
  agent-registry.ts, features.ts, api-tokens.ts).
- Log every Gemini call to `ai_events`.
- **Deploy every function that bundles a changed `_shared/` module**, not only the one you
  edited: `git grep -l 'shared/<file>' supabase/functions` lists them. A shared fix reaching
  one function is how the `dayKey` bug survived in half the project.
- **A threshold is measured, not chosen.** Two in this schema were wrong when intuited (0.85
  for follow-ups, 0.60 for topics). Run the distribution, then put the numbers in the
  migration comment so nobody re-derives them.

### Tooling in this repo

- `.claude/skills/` — `add-migration`, `deploy-and-verify-fn`, `add-news-feed`.
- `.claude/agents/` — `schema-guardian` (reviews a migration against the live database),
  `mirror-drift-checker` (the four duplicated pairs), `edge-fn-verifier` (proves a deploy).
- `.claude/hooks/` — `block-destructive-sql.sh` (PreToolUse on the Supabase MCP write tools;
  strips SQL comments first, so a DROP hidden behind `--` is still caught) and
  `check-after-edit.sh` (PostToolUse lint + test, never blocking).
- Deploys need `SUPABASE_ACCESS_TOKEN` in `.env.local`, which is gitignored by `*.local`.
  **Do not put secrets in `.env`** — that file is tracked, and currently holds only the
  publishable key and project URL, which are designed to be public.

### Commits

The house style is a **prose-imperative subject with a substantial body explaining why** —
the tradeoff, the thing rejected, the production fact that forced it. Not Conventional
Commits. Those bodies are the only record of why a threshold is 0.90 and not 0.85, so write
them properly the first time.

- `git pull` before starting and before committing; Lovable pushes to the same branch.
- Never rewrite published history — no force push, no rebase or amend of pushed commits. It
  rewrites history on Lovable's side and the owner loses their project history.
- One commit per coherent change; never leave the tree dirty between steps.
- The tag `pre-hackathon` marks the state before the Phase 8 window, so
  `git log --oneline pre-hackathon..HEAD` is exactly the work done in it.
