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

**122 automated tests across 9 files**, `npm test` in ~1.5s.

| file                             | focus                                                       | cases |
| -------------------------------- | ----------------------------------------------------------- | ----- |
| `_shared/feeds.test.ts`          | feed parsing, URL repair, junk filter, cross-source merging | 57    |
| `src/lib/task-logic.test.ts`     | grouping, recurrence, on-time rate, feature parity (tier 2) | 28    |
| `_shared/agent-registry.test.ts` | surface allowlists, citation checking (tier 5)              | 11    |
| `_shared/time.test.ts`           | the `dayKey` regression and timezone helpers                | 8     |
| `src/lib/task-view.test.ts`      | filter/sort/search state                                    | 5     |
| `src/lib/tz.test.ts`             | browser timezone helpers                                    | 4     |
| `_shared/gemini.test.ts`         | module-load safety, model constants                         | 4     |
| `_shared/features.test.ts`       | default resolution                                          | 3     |
| `src/test/app-routing.test.tsx`  | routing smoke                                               | 1     |

The 57 `feeds.test.ts` cases are the interesting ones: 941 lines of the gnarliest code in the
project had **zero** tests, while [gotchas.md](gotchas.md) and
[news-pipeline.md](news-pipeline.md) carried a list that reads as a test plan. Each case is a
real malformation from a live feed, and the prose became executable.

**Fixture discipline:** use real captured input. A hand-written fixture tests your idea of the
malformation, not the malformation. The SEBI date `"09 Oct, 2026 +0530"`, Google News' opaque
`CBMi…` ids, Hugging Face's boilerplate `og:description` — none of these are things anyone
would invent.

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
- the `voice` and `telegram` registry surfaces
- the web-push action buttons end to end, and 404/410 expiry pruning
- tiers 3 and 4 exist as a strategy and as manual runs, not yet as committed scripts — see
  [plans/P1-codify-tests.md](plans/P1-codify-tests.md)

An honest gap is worth more than an inflated count.
