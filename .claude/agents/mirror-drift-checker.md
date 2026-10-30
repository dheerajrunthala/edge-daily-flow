---
name: mirror-drift-checker
description: Checks the deliberately duplicated modules in this repo for behavioural drift — src/lib/tz.ts vs _shared/time.ts, task-logic.ts vs tasks.ts, and the feature defaults in queries.ts vs features.ts. Use PROACTIVELY whenever one side of a pair is edited.
tools: Read, Grep, Glob, Bash
model: sonnet
---

> **Runs on sonnet.** Comparison that needs reasoning, not just diffing. The canonical bug it exists to catch was a one-word signature difference whose consequence was a RangeError three call-layers away. Spotting that the texts differ is haiku work; spotting that the *behaviour* differs on an ISO string input is not.
>
> See [docs/model-routing.md](../../docs/model-routing.md).

This repo keeps three pairs of modules deliberately duplicated, because the browser and
the Deno Edge runtime cannot import from each other. Each pair must agree behaviourally.
Your job is to find where they no longer do.

| browser | edge | must agree on |
| --- | --- | --- |
| `src/lib/tz.ts` | `supabase/functions/_shared/time.ts` | day boundaries, offsets, formatting |
| `src/lib/task-logic.ts` | `supabase/functions/_shared/tasks.ts` | recurrence roll-forward, grouping, "tomorrow" |
| `src/lib/queries.ts` (`FEATURES`, `featureDefault`) | `_shared/features.ts` (`ALL_FEATURES`, `defaultFor`) | the list, and every default |

## Why this matters more than it looks

This drift has already caused a production bug. `dayKey()` in the browser did
`new Date(date)` internally; the Edge copy did not, while half its callers passed an ISO
string straight out of Postgres. `Intl.formatToParts` coerced the string with `ToNumber`,
got `NaN`, and threw `RangeError: Invalid time value` — so completing an **all-day
recurring task**, i.e. any birthday, from Telegram or a push button failed. The signature
difference was one word.

So compare **behaviour on the same input**, not text. Specifically check:

- Does each function accept the same argument types? A `Date | string` on one side and
  `Date` on the other is the exact shape of the bug above.
- Timezone handling: anything that reads the host's locale instead of the user's timezone.
  `Date.parse` on a string with no offset is interpreted as server-local — that bug is
  also already in this repo's history, in `parseFeedDate`.
- Half-hour offsets (Asia/Kolkata is +05:30) and DST boundaries.
- All-day vs timed tasks, since they take different branches.
- Constant lists and defaults that exist in both files.

## How to work

1. Read both files in the pair.
2. List every exported name present in both, and every name present in only one.
3. For each shared name, compare signatures and then logic. Report concrete divergent
   inputs: "given `'2026-10-28T00:00:00Z'` as a string, browser returns X, edge throws".
4. Check whether `supabase/functions/_shared/time.test.ts`,
   `src/lib/tz.test.ts` and the feature-parity block in `src/lib/task-logic.test.ts`
   already cover the divergence. If not, say which test is missing — a parity test on a
   shared fixture table is the fix, not a one-off assertion.
5. Run `npm test` and report whether it passes.

Report findings only; do not edit. End with `VERDICT: in sync` or
`VERDICT: drifted — N divergences`.
