# Testing

The strategy as _instructions_ is the `write-tests` skill, which is what an agent loads before
writing a test. This document is the reference: what exists, what it covers, and what it
deliberately does not.

## The two constraints that shape everything

1. **The Edge runtime cannot be run locally.** No Docker here, and the Deno Edge runtime is not
   emulable.
2. **A user JWT cannot be minted outside a browser session**, because the service role key
   lives only in the platform's secret store.

A conventional test pyramid would therefore leave the most dangerous code in the project — the
ownership guard, the cron pipeline, every user-JWT function's happy path — completely untested.
So: **test where being wrong costs most, and verify in production whatever a test cannot
reach.**

## Can this module be tested under vitest?

Not "is it in `src/`". The rule is:

> A module is testable here if **every `npm:`/`jsr:` specifier it reaches is erased at compile
> time.**

`import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"` qualifies — esbuild strips
it. A _value_ import does not. That is why `agent-tools.ts`, `agent-registry.ts`, `features.ts`
and `tasks.ts` all run under vitest despite naming a jsr package, while anything importing
`createClient` cannot. `feeds.ts` and `time.ts` have no imports at all; `gemini.ts` only `fetch`.

Two corollaries learned the hard way:

- The comment in `vitest.config.ts` once claimed the opposite and was actively discouraging
  these tests from being written.
- **Touching a `Deno` global at module load breaks the same rule from the other direction.**
  Reading `Deno.env` in a top-level const made every test file transitively importing
  `gemini.ts` fail to _collect_ — the suite reported 106 passing instead of 118, with nothing
  naming the twelve that vanished. A silent drop is worse than a red test, so the read is
  guarded and `gemini.test.ts` imports the module as its own cheapest regression guard.

The `include` pattern already covers `supabase/functions/_shared/*.test.ts`. Put the test
beside the module.

## The six tiers

| tier                    | where                                        | what only it can test                                            |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| **1 Pure unit**         | `*.test.ts`, vitest                          | parsing, date coercion, grouping, filtering, declaration shaping |
| **2 Mirror-parity**     | both copies imported into one test           | that the browser and Edge copies of duplicated logic agree       |
| **3 SQL assertion**     | `scripts/db-checks.sql` via the Supabase MCP | RLS, policies, column grants, SECURITY DEFINER scoping           |
| **4 Deployed contract** | `scripts/contract/*.ts`                      | boot success, cross-user isolation, rate limits, HMAC rejection  |
| **5 LLM invariant**     | vitest + the agent's own output              | that a model cannot fabricate a citation or exceed its allowlist |
| **6 Production**        | `invoke_edge_function` + read the rows       | that the thing actually ran                                      |

### Tier 2 exists because of a real outage

`dayKey()` took `Date | string` in the browser and `Date` on the server, while half its Edge
callers passed an ISO string straight out of Postgres. `Intl.formatToParts` coerced the string
with `ToNumber`, got `NaN`, and threw `RangeError` — so completing any **all-day recurring task
(i.e. any birthday)** from Telegram or a push button failed. The signature difference was one
word.

So compare **behaviour on the same input**, not text. Run both copies over one shared fixture
table, including `Date` _and_ string inputs, DST boundaries, and Asia/Kolkata's half-hour
offset.

### Tier 5: assert invariants, never prose

You cannot assert what a model will say, so do not try. Assert what it cannot talk its way
past:

- every citation URL **must** exist in the set a tool actually returned (`unknownCitations`)
- every tool call **must** be in the calling surface's allowlist, checked through `runTool` and
  not merely absent from the declaration list
- every `due_at` the agent produces **must** carry a UTC offset
- `build-digests` **must** return indices, never URLs
- no tool may declare an empty `parameters` schema — Gemini _hangs_ on
  `{ type: "object", properties: {} }` rather than rejecting it

A model can produce a mediocre summary and pass. It cannot produce a fabricated link and pass.

### Tier 6: a 200 is not success

1. Invoke through the **production path** — `select public.invoke_edge_function(…)`, never a
   path invented for testing.
2. Read `net._http_response`: `BOOT_ERROR` = a bad import, `IDLE_TIMEOUT` = something hung, a
   null row = still in flight, conclude nothing.
3. Read logs with **`event_message`**, the top-level column; `log_attributes['event_message']`
   returns empty strings and looks exactly like a function that logged nothing. `select now()`
   first — a window guessed from local time is hours off and also looks like silence.
4. **Read back the rows.** `plan-day` once returned 200 having done nothing; only `ai_events`
   and `mcp_tool_calls` revealed it.

Also check **negative evidence**: after a create → delete round trip, query for leftovers;
after an isolation test, confirm the other account's rows are untouched.

## What exists today

**240 automated tests across 13 files**, `npm test` in ~2s. `npm run verify` prints the
total, so a silent collection drop shows up as a changed number rather than as nothing.

| file                             | focus                                                        | cases |
| -------------------------------- | ------------------------------------------------------------ | ----- |
| `_shared/feeds.test.ts`          | feed parsing, URL repair, junk filter, cross-source merging  | 57    |
| `src/lib/voice-routing.test.ts`  | which utterances take the model-free fast path; slot reading | 49    |
| `src/lib/alexa-redirect.test.ts` | the `/authorize` `redirect_uri` allowlist, host **and** path | 28    |
| `src/lib/task-logic.test.ts`     | grouping, recurrence, on-time rate, feature parity (tier 2)  | 28    |
| `src/lib/insights.test.ts`       | Insights aggregation, over real rows trimmed from 2026-10-30 | 21    |
| `src/lib/calendar.test.ts`       | the `.ics` export and the Google Calendar URL                | 20    |
| `_shared/agent-registry.test.ts` | surface allowlists, citation checking (tier 5)               | 12    |
| `_shared/time.test.ts`           | the `dayKey` regression and timezone helpers                 | 8     |
| `src/lib/task-view.test.ts`      | filter/sort/search state                                     | 5     |
| `src/lib/tz.test.ts`             | browser timezone helpers                                     | 4     |
| `_shared/gemini.test.ts`         | module-load safety, model constants                          | 4     |
| `_shared/features.test.ts`       | default resolution                                           | 3     |
| `src/test/app-routing.test.tsx`  | routing smoke                                                | 1     |

Two of those files are a different shape and worth knowing about.
`voice-routing.test.ts` and `alexa-redirect.test.ts` hold their **own copy** of a rule whose
implementation vitest cannot import — `alexa-skill/index.ts` imports the Supabase client as a
value, and `authorize.tsx` is a route module pulling in AppShell and the router. Each ends
with a block asserting the real source text still contains the rule under test, which is what
stops the tests passing against a copy the implementation has moved on from. They are the
fourth and fifth of the five places CLAUDE.md rule 5 lists.

The 57 `feeds.test.ts` cases are the interesting ones: 941 lines of the gnarliest code in the
project had **zero** tests, while [gotchas.md](gotchas.md) and
[news-pipeline.md](news-pipeline.md) carried a list that reads as a test plan. Each case is a
real malformation from a live feed, and the prose became executable.

**Fixture discipline:** use real captured input. A hand-written fixture tests your idea of the
malformation, not the malformation. The SEBI date `"09 Oct, 2026 +0530"`, Google News' opaque
`CBMi…` ids, Hugging Face's boilerplate `og:description` — none of these are things anyone
would invent.

## Tiers 3 and 4: the committed scripts

These were a _practice_ before — every one of them had been run, by hand, through the
Supabase MCP, in a session transcript nobody else could re-run. A reviewer cannot re-run a
transcript and a regression cannot be caught by one.

| script                              | tier | run it with                                         |
| ----------------------------------- | ---- | --------------------------------------------------- |
| `scripts/db-checks.sql`             | 3    | `npm run verify`, or the Supabase MCP `execute_sql` |
| `scripts/contract/boot-smoke.ts`    | 4    | `npm run verify`, or `npm run test:contract`        |
| `scripts/contract/mcp-isolation.ts` | 4    | `npm run test:isolation` + two tokens               |

All three, plus the local checks, run from one command — `npm run verify`
(`scripts/verify-claims.sh`), which prints PASS/FAIL per claim with the real numbers. It
reports a check it could not run as a **skip, never a pass**: with no
`SUPABASE_ACCESS_TOKEN` the live rows say so on the line, and the exit code counts failures
only. `db-checks.sql` reaches the database through
`POST /v1/projects/{ref}/database/query`, the endpoint the hosted Supabase MCP server calls
underneath `execute_sql` — same transport, no session needed. `scripts/verify/live-sql.mjs`
re-checks the destructive-SQL deny list before sending, because that HTTPS path is a second
door into production with the PreToolUse hook nowhere near it.

`npm test` stays the fast unit suite. Contract tests hit the network and are not in the
inner loop.

### `db-checks.sql` — 13 assertion blocks, and a pass is silence

RLS on every table · exactly two policy-less tables · no `anon`/`PUBLIC` EXECUTE on the
definer RPCs (plus a sweep that catches a _newly added_ one) · the three column-grant
narrowings exactly · `api_tokens.token_hash` unreachable · `anon` holding nothing on the
four locked tables · **`match_news_items` not crossing accounts** · HNSW indexes with
`vector_cosine_ops` · `link_followups` writing nothing below 0.90 · the cron schedule
matching [operations.md](operations.md) · no quota-spending job sharing a minute with
`repair-embeddings`.

Two things in it are worth knowing before editing it:

**Expectations are sets compared with `=`, never `not exists` over a known-bad list.** A
set comparison goes red in _both_ directions, so it catches a grant that was added and a
grant that was lost. `not exists` only ever catches the first.

**Assertion 7b calls a function that writes.** `link_followups` cannot be tested
read-only, so the writes happen inside a PL/pgSQL block with an `EXCEPTION` clause —
Postgres implements that as a savepoint, and raising inside it rolls the writes back while
leaving the variables intact. The block then re-counts the production rows and fails loudly
if the rollback did not happen. Every red test in this file used the same pattern to create
genuinely broken state (a table without RLS, an unscoped copy of `match_news_items`, an
index with the wrong operator class) and roll it back.

### `boot-smoke.ts` — and why a 401 is not proof of boot

Thirteen probes, one per function. A missing export is a **boot failure**, not a type error: the isolate refuses to start,
pg_net records `BOOT_ERROR`, and the function logs are empty — indistinguishable from a
function nobody called. `npm run build` cannot see it, because the Deno bundle is assembled
on deploy from specifiers Vite never resolves.

The plan for this script said to probe the user-JWT functions with no credential and treat
a 401 as a pass. Measured, that is wrong:

```
POST /parse-task  (no Authorization)
  → 401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}
```

That is the **platform gateway**. With `verify_jwt = true` the isolate is never started, so
the response is identical whether the bundle is healthy or broken — the test cannot fail.
Sending the publishable anon key gets past the gate and reaches the handler, which answers
in its own words (`{"error":"Invalid or expired token"}`, i.e. `requireUser()`).

So every probe asserts on a **handler-authored body**, not a status code, and treats a
gateway refusal as a failure with that explanation. The cron functions are probed with a
deliberately wrong `x-cron-secret` for the same reason and one more: invoking them for real
through `invoke_edge_function` would _run the jobs_, spending Gemini quota on every smoke
run. A wrong secret boots the identical bundle and stops at the handler's first line.

### `mcp-isolation.ts` — negative evidence is the point

Every MCP tool runs with the service role, and the service role bypasses RLS entirely. The
only thing between two accounts is `.eq("user_id", ctx.userId)` inside `mine()`/`myRow()`.

Asserting that token B got an error is **half** a test — an implementation that refuses the
read and performs the write anyway passes it. So A's rows are snapshotted through token A,
attacked through token B across all six mutating tools including `delete_task`, then
re-read through token A and compared byte for byte. The comparison is the assertion.

It also refuses to pass vacuously: if the two tokens resolve to the same account, or if
account A has no task to attack, that is a failure rather than a silent skip.

One finding from writing it: the 120/hour rate limit surfaces as a **JSON-RPC tool error on
an HTTP 200**, not an HTTP 429. `checkRateLimit()` is called inside the registered-tool
wrapper, after auth, so the SDK turns its `HttpError` into `isError` content; the
429 → `-32000` mapping in `mcp/index.ts` only covers failures raised in `handle()`, which
is authentication. The assertion checks the behaviour, not the guess.

## Verified in production rather than in a test

Each of these has evidence in the database or the git log:

- the refactored MCP server byte-identical to its pre-refactor output across `get_context`,
  `list_tasks`, a search containing PostgREST filter syntax, and create → read → delete
- cross-user isolation: seeding `match_news_items` from account A's embedding while asking for
  B leaked **0** of A's rows
- `link_followups` over 30 digests: 14 links, every one correct, every one pointing earlier
- `fanout_build_digests()` adding **zero** Gemini calls over an already-`ready` digest
- `plan-day` calling three tools in one turn, falling through to the fallback model, and
  delivering on email + telegram + push
- the feature gate: with no `planner` row, the run spent nothing
- the destructive-SQL hook, 13 cases, both directions

## Not covered, stated plainly

- the `agent` happy path from a browser session — **owner-assigned**, since no session can be
  minted here
- dictation on a real microphone
- the `telegram` registry surface. The `voice` surface **is** now exercised: 8 tool calls
  recorded against `surface = 'voice'`, 0 failed — though from the skill's own invocations,
  not from a real Echo, which stays owner-assigned
- the web-push action buttons end to end, and 404/410 expiry pruning
- the `--rate-limit` block of `mcp-isolation.ts`, which is opt-in: running it spends an
  account's whole hourly budget, so it is not part of a normal run
- `mcp-isolation.ts` itself has not been run against production — it needs a second
  account's `de_…` token, which is **owner-assigned**. It is committed runnable and exits
  **2** (not run) rather than 0 when the tokens are absent, so it cannot read as a pass

An honest gap is worth more than an inflated count.
