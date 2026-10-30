# MCP in this project, in both directions

Model Context Protocol appears twice in Daily Edge, and the two uses are easy to conflate.
They are opposites:

|                             | direction              | who is the client                                           | what it gives                                                                  |
| --------------------------- | ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Supabase MCP**            | agent → infrastructure | Claude Code, during development                             | the agent can inspect, migrate, deploy and **verify** against the live project |
| **The `mcp` Edge Function** | agent → product        | Claude Code / Claude Desktop / any MCP client, in daily use | the product is addressable by whatever agent the user already has open         |

The first changed how this repo was built. The second is a product feature. This document
covers both, with the evidence from this repo rather than a description of the protocol.

---

## Part 1 — MCP as the development loop

### The problem it solves

Daily Edge has thirteen Edge Functions on Deno, a Postgres database with pgvector and
pg_cron, and eight cron schedules. None of it runs locally: there is no Docker here, the Edge runtime
cannot be emulated, and a user JWT cannot be minted outside a browser session because the
service role key exists only in the platform's secret store.

Without MCP, an agent working on this codebase can write code and run unit tests, and that is
all. It cannot answer "did that work?" — which means every claim it makes about production is
unverified, and the human becomes the integration test.

With the Supabase MCP server scoped to this project, the agent closes its own loop.

### The loop, concretely

```
            ┌─────────────────────── Claude Code ───────────────────────┐
            │                                                          │
  write ────┤  Edit / Write          .claude/skills/ship-change         │
            │       │                                                  │
  gate  ────┤  npm lint / test / build        ← .claude/hooks/          │
            │       │                                                  │
  review────┤  schema-guardian subagent       ← .claude/agents/         │
            │       │                                                  │
            └───────┼──────────────────────────────────────────────────┘
                    ▼
        ┌───────── Supabase MCP ──────────┐
        │  apply_migration                │  schema change, recorded
        │  execute_sql                    │  inspect + assert
        │  deploy_edge_function / CLI      │  ship the function
        │  query_logs                     │  read what happened
        │  generate_typescript_types      │  regenerate types
        └──────────────┬──────────────────┘
                       ▼
            ┌──── live project ────┐
            │  invoke_edge_function │  ← the production path, not a test path
            │  net._http_response   │  ← the outcome
            │  the rows themselves  │  ← the proof
            └───────────────────────┘
```

The rule that makes it worth anything is in `.claude/skills/write-tests`:

> **A 200 is not success.** Invoke through the production path, read the pg_net response, read
> the logs with `event_message`, then **read back the rows.**

### Five things this found that no local test could

Each of these is a real production defect, found through MCP, with the evidence still in the
database or the git log.

**1. Three days of silently missing digests.** `query_logs` on `build-digests` returned the
whole story in five lines: booted 01:30:03, two minutes of Gemini 503 retries for a leftover
QA account, the real user's digest row claimed at 01:32:21, `shutdown` at 01:32:33. The 150s
wall clock had killed the isolate mid-build — which is exactly why the row sat in `pending`
and never reached `failed`: nothing survived to write a status. No unit test can see this.
See `docs/gotchas.md`.

**2. The embedding quota, which looked like capacity for two weeks.** `execute_sql` showed 797
of 2,651 pooled articles with no vector, and the gap _widening_. `query_logs` gave the actual
error: `embed_content_free_tier_requests, limit: 100`, with the API's own
`Please retry in 49.215166941s`. The constraint was never flakiness — it was a per-minute
quota that `batchEmbedContents` burns one request per _text_ against. A run asked to repair
200 repaired exactly 100, which confirmed it to the digit.

**3. A measured threshold replacing a plausible one.** The design document specified cosine
≥ 0.85 for follow-up linking. One `execute_sql` over 316 embedded items showed the median
nearest-neighbour similarity was **0.8494** — the threshold was the median, and would have
badged half the feed as a follow-up. Reading the actual pairs by band gave 0.90. The same
exercise caught a topic floor of 0.60 that would have matched the entire archive.
See `docs/decisions.md`.

**4. Schema drift between the repo and the database.** `execute_sql` over `pg_indexes` found
`news_items_embedding_idx` live in production and in no migration file — created by hand in
the dashboard. It is now declared with `if not exists`, so the repo and the database agree.

**5. A cron job that was never scheduled.** `plan-day` was written, deployed, documented in
the cron table and verified end to end by hand — and `select * from cron.job` showed jobids
1, 2, 3, 4, 6 and no `plan-day`. The autonomous planner had only ever run when a human
invoked it. Nothing in the code or the docs could have revealed that; only the database.

### What the agent is _not_ allowed to do with it

MCP access to production is a loaded tool, so it is fenced:

- **`.claude/hooks/block-destructive-sql.sh`** is a PreToolUse hook on
  `mcp__supabase__execute_sql` and `mcp__supabase__apply_migration`. It strips SQL comments
  first, then blocks `DROP`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`,
  `DISABLE ROW LEVEL SECURITY`, and `DROP POLICY` with no `CREATE POLICY` after it. Exit code
  2, with the reason. Verified both directions: seven dangerous statements blocked — including
  one hidden behind `--` — and six legitimate ones passed, including this repo's own
  idempotent `drop policy if exists` + `create policy` idiom. A guard that blocks ordinary
  work gets switched off, and then it guards nothing.
- **`schema-guardian`** reviews every migration _against the live database_ before it is
  applied. It has blocked a migration: see Part 3.
- Destructive or irreversible changes stop and ask, which is why a leftover QA account was
  _disabled_ rather than deleted.

---

## Part 2 — MCP as a product surface

### The design principle: the client is the intelligence

The `mcp` Edge Function exposes 13 tools and **calls no model at all**. That is deliberate and
it is the opposite of the `agent` function's design.

Daily Edge already owns a Gemini parser. The MCP server does not use it, because an MCP client
is _already_ a model holding the conversation, the repo, the branch and the diff. It will
resolve "tomorrow morning" and name a tag far better than a second model reading one bare
sentence through a straw.

The consequence is that everything the client needs in order to fill the parameters well has
to be said out loud, because there is no parser downstream to repair a bad guess. That is what
`supabase/functions/mcp/instructions.ts` is for — it is sent on `initialize` and tells the
client to call `get_context` first, to infer tags from context, to put the repo and branch in
`notes` because the user reads it later with none of the conversation in front of them, and to
confirm before deleting.

### What it is actually for

The motivating use: you are in a terminal, mid-task, and you notice something that needs doing
later. Instead of leaving the editor, your coding agent files it — with the repo name, the
branch, the file paths, the PR link and a one-line "Next: ..." — into the same task list that
will email you about it, message you on Telegram, and show up in tomorrow's morning plan.

The task's `source` column records `'mcp'`, which the product distinguishes from `'ai'` (one
sentence a human reviewed in a preview) and `'agent'` (a conversation the human was present
for). Five creation paths, each with a different amount of human review, recorded.

### The tools

Reads carry `readOnlyHint`; `delete_task` carries `destructiveHint`.

| tool                       | notes                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `get_context`              | name, timezone, local datetime + UTC offset, `morning_time`, tags, channels. **Call first.** |
| `list_tasks`               | `today`/`overdue`/`upcoming`/`someday`/`done`, plus `tag`, `search`, `limit`                 |
| `get_task`                 | full detail; recent completions for a recurring task                                         |
| `create_task`              | `source = 'mcp'`; `project` adds a Coding tag, a repo tag and a `Project:` note line         |
| `update_task`              | partial; `null` clears fields; a changed `due_at` resets the reminder ladder                 |
| `complete_task`            | reuses `_shared/tasks.ts`; rolls a recurring task forward                                    |
| `snooze_task`              | `until` must be in the future                                                                |
| `delete_task`              | destructive; cascades to completions and the ledger                                          |
| `list_tags` / `create_tag` | counts of open tasks; colours from the web app's palette                                     |
| `get_news` / `get_brief`   | the user's curated digest and their day at a glance                                          |
| `save_news_item`           | bookmark / unbookmark                                                                        |

### Why a long-lived token rather than a JWT

`claude mcp add --scope user` is pasted once and expected to work for months. A one-hour
Supabase JWT cannot do that. So authentication is `Authorization: Bearer de_…`, sha256'd
against `api_tokens` — the plaintext exists in exactly one response and nowhere after.
Unknown and revoked tokens give the _same_ message; which it was is not something an
unauthenticated caller needs to learn.

`verify_jwt = false` on this function, because the platform gate understands only Supabase
JWTs and would reject every real caller before the handler ran.

### Ownership is the only guard, so it is not left to each handler

The tools run with the service role, which **bypasses RLS entirely**. The token's `user_id` is
therefore all that separates two accounts. Rather than trusting thirteen handlers to remember
that, every read goes through `mine()` and every single row through `myRow()`
(`supabase/functions/_shared/agent-tools.ts`), both of which pin `user_id` before the caller
can add a filter. An id from another account reads as **"not found"**, never as a row.

Going around the guard requires actively writing `admin.from(...)` instead of merely
forgetting a line — which is the only kind of guard worth having.

**Proven, not asserted.** Against two accounts: token B could not read, update, complete,
snooze, delete or save any of account A's tasks or news items, and A's rows were byte-identical
afterwards. Repeated at the database level after the Phase 8 refactor — seeding
`match_news_items` from A's embedding while asking for B leaked zero of A's rows.

### Rate limiting and audit

- **120 calls per token per hour**, counted over `mcp_tool_calls`. Per _token_ rather than per
  user, so one looping agent stops without taking out the user's other editors — and the token
  is the thing they can revoke.
- Checked **inside** the tool wrapper, so `initialize` and `tools/list` cost nothing. A client
  reconnecting should not spend the user's quota.
- Every call is logged with tool, ok/error, duration and **`surface`**. Two of the product's
  five doors carry no API token, so a row with `token_id` null would be unattributable.
  `surface` is `'mcp' | 'chat' | 'voice' | 'telegram' | 'planner'` — it is the only record of
  what an agent did while nobody was watching.

### Transport decisions

- **`WebStandardStreamableHTTPServerTransport`**, not `StreamableHTTPServerTransport`. The
  latter wraps node's `req`/`res` and cannot run in this runtime; the Web Standards one speaks
  `Request`/`Response` and runs unmodified.
- **Stateless** (`sessionIdGenerator: undefined`), with a fresh `McpServer` per request. Edge
  invocations are ephemeral and a later request may land in a different isolate, so a session
  id would be a promise the platform cannot keep — it would resolve to "session not found" the
  moment an isolate recycled. The bearer token carries all the identity a tool call needs.
- **`enableJsonResponse: true`**: there is nothing to stream when each response is one result.
- Errors are **JSON-RPC shaped**, not this project's usual `{"error": "..."}`. A plain body
  surfaces in the client as a parse failure rather than as the reason the token was rejected.

### Connecting

Settings → Integrations mints a token and hands over the exact command:

```bash
claude mcp add --scope user --transport http daily-edge <function-url> \
  --header "Authorization: Bearer de_..."
```

`--scope user` so it works in every repo, not just the current one. Claude Desktop speaks
stdio, so `npx mcp-remote` bridges it; the header is passed as `Authorization:${AUTH_HEADER}`
with **no space after the colon**, the "Bearer " prefix living in the env var — mcp-remote's
own documented workaround for clients that do not escape spaces inside `args`.

---

## Part 3 — the two directions meeting

The most useful thing about having both is that each verifies the other.

**The product MCP server verified its own refactor.** Phase 8 moved the ownership guard and
every value coercion out of `mcp/tools.ts` into a shared module — 1,300 lines down to 1,084,
in production code the whole product depends on. The safety net was the server itself: call
all 13 tools through the live connection, record the output, refactor, redeploy, call again,
diff. `get_context`, `list_tasks`, a search containing PostgREST filter syntax, and a
create → read → delete round trip all came back byte-identical, with `parseInstant` still
rejecting an offset-less `due_at` and `"coding"` still folding into the existing `Coding` tag.

**The development MCP blocked a bad migration.** `schema-guardian`, which has
`mcp__supabase__execute_sql`, reviewed a cron migration and returned
`VERDICT: do not apply — 1 blocking`. The schedule was written `*/10`, which fires at minute
:00 of _every_ hour — including 01:00 UTC, the exact minute `fanout-ingest-news` starts six
parallel ingest invocations that are all embedding. The repair job's 90 requests would have
competed with ingest's own for the same 100-per-minute window, and the articles that lost would
have been _fresh_ ones, pooled vectorless and therefore permanent. A repair job that causes
the damage it repairs.

It could only know that by querying the live `cron.job` table and reading the function's own
constants. That finding is the clearest argument in this document for giving a review agent
real, read-only access to the thing it is reviewing.

---

## Reproducing the claims

Everything above is checkable, and most of it in one command:

```bash
npm run verify
```

That runs the 13 assertions in `scripts/db-checks.sql`, boots all thirteen functions, and
asks the three questions below, printing PASS/FAIL per claim with the real number. It
reaches the database through `POST /v1/projects/{ref}/database/query` — the endpoint the
hosted Supabase MCP server calls underneath `execute_sql` — so the same checks run from a
shell as from a session. A check it could not run is a **skip, never a pass**.

The queries, for reading by hand or adapting. With the Supabase MCP connected:

```sql
-- the audit trail, by door
select surface, count(*), count(*) filter (where not ok) as failures
from mcp_tool_calls group by surface order by count(*) desc;

-- ownership: ask for user B with user A's embedding, get none of A's rows
with seed as (select user_id, embedding from news_items where embedding is not null limit 1),
     other as (select distinct user_id from news_items
               where user_id <> (select user_id from seed) limit 1)
select count(*) as leaked from seed, other,
  match_news_items(other.user_id, seed.embedding, 50, null, 0) m
where m.id in (select id from news_items where user_id = (select user_id from seed));

-- the schedules, including the two this phase added
select jobname, schedule from cron.job order by jobname;

-- the embedding backlog draining on its own: 0 of 2,651 as of 2026-10-30
select count(*) filter (where embedding is null) as missing, count(*) as total from articles;
```

Alias every column if you run these through `scripts/verify/live-sql.mjs` rather than the
MCP. The Management API answers with JSON objects keyed by column name, so two columns both
called `count` collapse into one and the row comes back a field short with a plausible
number in the wrong place.

And the guard:

```bash
echo '{"tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"drop table tasks"}}' \
  | .claude/hooks/block-destructive-sql.sh; echo "exit=$?"   # exit=2
```
