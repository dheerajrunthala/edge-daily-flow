---
name: write-tests
description: Write or extend tests for Daily Edge — which modules can be tested under vitest and the import rule that decides it, the six tiers and what each is for, fixture discipline, how to test model output without asserting prose, and why a 200 is never success. Use when adding tests, when deciding whether something is testable, or when a change needs a regression guard.
---

# Writing tests here

Two constraints shape everything: the Deno Edge runtime cannot be run locally, and a user JWT
cannot be minted from a development session. A conventional test pyramid would therefore leave
the most dangerous code in the project — the ownership guard, the cron pipeline — completely
untested. Six tiers instead, and the rule is **test where being wrong costs most, and verify in
production whatever a test cannot reach.**

## First: can this module be tested under vitest at all?

The answer is not "is it in `src/`". It is:

> A module is testable here if **every `npm:` / `jsr:` specifier it reaches is erased at
> compile time.**

`import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"` qualifies — esbuild strips
it. A _value_ import does not. That single distinction is why `agent-tools.ts`,
`agent-registry.ts`, `features.ts` and `tasks.ts` all run under vitest despite naming a jsr
package, while anything importing `createClient` cannot.

`feeds.ts` and `time.ts` have no imports at all; `gemini.ts` only `fetch`.

This was discovered late, and the comment in `vitest.config.ts` previously claimed the
opposite — it said the rest of `_shared` "will not resolve" and was actively discouraging the
tests from being written. If vitest cannot resolve a specifier, **that** is what went wrong;
check the import kind before concluding the module is untestable.

The `include` pattern already covers `supabase/functions/_shared/*.test.ts`. Put the test
beside the module.

## The six tiers

**1. Pure unit (vitest).** Anything satisfying the rule above. This is where parsing, date
coercion, grouping, filtering and declaration-shaping belong.

**2. Mirror-parity.** Three module pairs are deliberately duplicated because the browser and
the Edge runtime cannot import from each other:

| browser                                             | edge                  |
| --------------------------------------------------- | --------------------- |
| `src/lib/tz.ts`                                     | `_shared/time.ts`     |
| `src/lib/task-logic.ts`                             | `_shared/tasks.ts`    |
| `src/lib/queries.ts` (`FEATURES`, `featureDefault`) | `_shared/features.ts` |

Import **both** copies into one test and run them over the same fixture table. This tier exists
because the drift has already caused an outage: `dayKey()` took `Date | string` in the browser
and `Date` on the server, so completing any all-day recurring task from Telegram threw
`RangeError`. The signature difference was one word. Compare behaviour, not text.

**3. SQL assertions** — `scripts/db-checks.sql`, plain `do $$ … raise exception` blocks run
through the Supabase MCP. This is the only tier that can test RLS, policies, column grants and
SECURITY DEFINER scoping, because those are database behaviour and no TypeScript test touches
them.

**4. Deployed contract** — `scripts/contract/*.ts` against live functions. Reserved for what
needs the real runtime: boot success, cross-user isolation, rate limits, HMAC rejection.

**5. LLM invariants.** See below.

**6. Production verification.** See "a 200 is not success".

## Fixture discipline

**Use real captured input.** A hand-written fixture tests your idea of the malformation, not
the malformation. The SEBI date `"09 Oct, 2026 +0530"`, Google News' `CBMi…` opaque ids, the
doubled SEBI origin, Hugging Face's boilerplate `og:description` — all of these are strange in
ways nobody would invent.

When you find a new malformation in a live feed, capture it and add the case. That is how the
`feeds.ts` suite grew to 57, and each case corresponds to a line in CLAUDE.md's gotchas.

## Testing model output without asserting prose

You cannot assert what a model will say, so do not try. Assert **invariants it cannot talk its
way past**:

- every citation URL in an answer **must** exist in the set a tool actually returned
  (`unknownCitations`) — this is the hallucinated-link detector;
- every tool call **must** be in the calling surface's allowlist, checked through `runTool` and
  not merely absent from the declaration list;
- every `due_at` the agent produces **must** carry a UTC offset;
- `build-digests` **must** return indices, never URLs;
- no tool may declare an empty `parameters` schema — Gemini _hangs_ on
  `{ type: "object", properties: {} }` rather than rejecting it.

A model can produce a mediocre summary and pass. It cannot produce a fabricated link and pass.
For helpfulness, keep a small golden set (question → expected tool sequence) and score it with
a judge — but never let the judge be the correctness gate.

## A threshold is measured, not chosen

Two in this schema were wrong when intuited, and both were plausible:

- 0.85 for follow-up linking was the **median** nearest-neighbour distance, so it would have
  badged half the feed.
- 0.60 for topic matching matched the **entire archive**, because this embedding model
  compresses everything into 0.75–0.88.

So: run the distribution, **read the actual pairs by band** (the counts alone will mislead
you), pick the gap, and put the numbers in the migration comment so nobody re-derives them.

## A 200 is not success

Nothing is done on a green test alone. For anything cron-driven or agentic:

1. invoke through the **production path** — `select public.invoke_edge_function(…)`, not a new
   one you invented for testing;
2. read `net._http_response` for the returned id (`BOOT_ERROR` = bad import, `IDLE_TIMEOUT` =
   something hung);
3. read the logs with `event_message`, the top-level column — `log_attributes['event_message']`
   returns empty strings and looks exactly like a function that logged nothing;
4. **read back the rows.** `plan-day` returned 200 and had done nothing; only `ai_events` and
   `mcp_tool_calls` revealed it.

Also check **negative evidence**: after a create → delete round trip, query for leftovers;
after an isolation test, confirm the other account's rows are untouched.

## Counting for the record

`npm test` prints the number. Report automated tests and runnable scripts separately from
manual production checks, and **write down what is not covered** — the roadmap names the
unexercised paths on purpose. An honest gap is worth more than an inflated count.
