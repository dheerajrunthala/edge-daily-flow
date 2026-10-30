# Gotchas

Every item here cost at least an hour to find, and most of them presented as **silence** rather than an error. Read this before debugging anything that "just does nothing".

Feed-specific gotchas live in [news-pipeline.md](news-pipeline.md).

### Edge runtime gotchas (not feed-specific)

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
- **Touching `Deno` at module load makes a module untestable.** Reading `Deno.env` in a
  top-level const in `gemini.ts` made every test file that transitively imports it fail to
  _collect_ — the suite reported 106 passing instead of 118, with no failure naming the twelve
  that vanished. A silent drop is worse than a red test, so the env read is guarded with
  `typeof Deno !== "undefined"` and `gemini.test.ts` now imports the module as its own
  cheapest possible regression guard.
- **An unbounded `fetch` loses the error.** The wall clock is 150s; a hung upstream call means
  the platform kills the invocation with `IDLE_TIMEOUT` and nothing that was going to be
  logged ever is. Every Gemini call carries its own deadline for this reason — keep that true
  of any new network call.
- **Read logs with `event_message`, the top-level column.** `log_attributes['event_message']`
  returns empty strings, which looks exactly like a function that logged nothing. And run
  `select now()` before choosing a window: one guessed from local time is hours off and
  returns nothing, which also looks like silence.

## `revoke execute ... from anon` does not close a function

Postgres grants EXECUTE on every new function to **PUBLIC**, and `anon` inherits that. So
revoking from `anon` by name leaves the PUBLIC grant intact and the function still reachable
over PostgREST with nothing but the publishable key.

This was live. Three vector RPCs and one _write_ were open to anonymous callers while the
migration comments claimed otherwise — and `match_news_items` resolves its owner as
`coalesce(auth.uid(), p_user_id)`, so with no JWT an anonymous caller passing someone else's
user id read that user's news items. The coalesce was written assuming the revoke made the
null branch unreachable; it did not.

Always revoke from **both**:

```sql
revoke execute on function public.f(args) from public, anon;
```

And verify with the advisor rather than the migration comment:

```
mcp__supabase__get_advisors(type: "security")
```

```sql
-- the standing check
select p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.prosecdef
order by anon desc;
```

`handle_new_user` is the one acceptable `anon = true`: it returns `trigger`, and Postgres
refuses a direct call ("trigger functions can only be called as triggers") — verified on this
project. It is left alone rather than revoked, because nothing is reachable and the signup
trigger is not worth risking.
