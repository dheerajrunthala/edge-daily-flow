---
name: debug-silent-failure
description: Diagnose something in Daily Edge that did nothing and logged nothing — a cron job with no effect, an Edge Function that answers nobody, a row that was never written, tests that quietly stopped running. Walks the causes in cost order, with the one query that eliminates each. Use before guessing, and before reading application code.
---

# When it did nothing and logged nothing

Almost everything that has gone wrong in this project presented as **silence**, not as an
error. Silence has at least nine distinct causes here, and only one of them is a bug in the
logic you are about to go and read.

So walk them in this order. Each branch is one query and eliminates a whole class.

**Before anything: `select now();`** A log window picked from your laptop's clock is hours
off in a UTC runtime and returns nothing, which looks exactly like the symptom you are
chasing. This has wasted hours twice.

---

## The short version

| the symptom                                      | the first thing to check                            | the cause it finds                                                                                              |
| ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| a scheduled job never had any effect             | `select jobname, schedule, active from cron.job`    | the job was never scheduled. `plan-day` had **no row at all** while its code, its gate and its docs all existed |
| the function answers nobody, logs are empty      | `net._http_response` → `BOOT_ERROR`                 | a missing export. The isolate refuses to start, so there is nothing to log                                      |
| it started, then nothing — no error, no result   | `net._http_response` → `IDLE_TIMEOUT` (150s)        | an unbounded `fetch`. The isolate was killed mid-flight and the error it was about to log died with it          |
| the logs query returns empty strings             | you read `log_attributes['event_message']`          | wrong field. `event_message` is a **top-level column**                                                          |
| every caller gets 401 and the handler never runs | `grep '\[functions\.<name>\]' supabase/config.toml` | an unlisted function defaults to `verify_jwt = true`; the gateway refuses before boot                           |
| 200, and the row is not there                    | read the `error` field in the body                  | the handler refused on purpose and said why                                                                     |
| 200, nothing spent, nothing delivered            | `select * from user_features where user_id = …`     | a feature gate. `planner` **defaults off**                                                                      |
| it works for one user and not another            | the idempotency claim table                         | the slot was already claimed: `brief_sends`, `plan_sends`, `task_notifications`                                 |
| the fix works locally and not in production      | `git grep -l 'shared/<file>' supabase/functions`    | a stale bundle: some functions were not redeployed                                                              |
| the test count went down and nothing is red      | the diff for a new `Deno.` or `npm:` reference      | a test **file** failed to collect                                                                               |
| the row exists in SQL but the app cannot see it  | the table's grants and policies                     | RLS, a column grant, or a missing `anon`/`authenticated` privilege                                              |

---

## 1. Did it run at all?

```sql
select jobid, jobname, schedule, active from cron.job order by jobname;

select jobid, status, return_message, start_time
from cron.job_run_details order by start_time desc limit 20;
```

A documented job with no `cron.job` row is the exact bug that left the autonomous planner
never running: the function was deployed, the feature flag existed, the docs described the
schedule, and no row did. **The docs are not evidence that a job is scheduled.**

`status = 'failed'` with a `return_message` is the easy case. `succeeded` with
`return_message = '1 row'` means the _SQL_ succeeded — `invoke_edge_function` returned a
request id. It says nothing about the function.

Then check whether the schedule you think is running is the one that is:
`scripts/db-checks.sql` assertion 8 compares `cron.job` against the table in
[docs/operations.md](../../../docs/operations.md), so `npm run verify` answers this in one line.

---

## 2. Did the isolate boot?

```sql
select status_code, error_msg, left(coalesce(content, '(in flight)'), 2000) as body
from net._http_response where id = <the pg_net id>;
```

**No row** means still in flight. Conclude nothing from it.

`BOOT_ERROR` or 503 "Function failed to start" means a bad import. The overwhelmingly
common cause is `import { X } from "./m.ts"` where `m.ts` does not export `X`. In the Deno
Edge runtime that is **not a type error** — the isolate refuses to start, pg_net records
`{"code":"BOOT_ERROR"}`, and the function logs are completely empty, so it looks identical
to a function nobody called. `npm run build` cannot see it either: the Deno bundle is
assembled on deploy from `jsr:`/`npm:`/`../_shared/*.ts` specifiers Vite never resolves.

```bash
npm run test:contract     # boots all 13 isolates and asserts each handler answered
```

That is the cheapest possible test for this class, and it writes nothing: every probe
carries a deliberately wrong credential and stops at the handler's first line.

---

## 3. Was it killed?

`IDLE_TIMEOUT`, or 504 "(150s) reached". The platform's wall clock is 150 seconds. A hung
upstream call means the invocation is killed and **nothing that was going to be logged ever
is** — including the error.

So look for a network call with no deadline. Every Gemini call in `_shared/gemini.ts`
carries its own `AbortSignal.timeout`, and that is the reason. Keep it true of anything new.

The nastiest variant of this is a _slow_ call rather than a hung one. On the voice surface a
correct answer took **56 seconds**, measured on the first real device session — all of it
`gemini-flash-latest` timing out at its 25s deadline on every attempt before falling through
to flash-lite, which then answered in about three. The function was never broken; its budget
was. See the `add-voice-surface` skill.

---

## 4. Are you reading the logs wrong?

```sql
select timestamp, event_message from logs
where source = 'function_logs'
order by timestamp desc limit 30
```

Two traps, both of which return zero rows or empty strings:

1. **`log_attributes['event_message']` returns empty strings.** `event_message` is the
   top-level column. This is the most expensive mistake in the file.
2. **A window guessed from local time.** Bound it from the database's `now()`, not yours.

---

## 5. Did the gate reject it before the handler?

```bash
grep -A2 "\[functions\.<name>\]" supabase/config.toml
```

An Edge Function with no block in `config.toml` gets `verify_jwt = true`. For anything
authenticated by something other than a Supabase JWT — cron (`x-cron-secret`), Telegram
(`x-telegram-bot-api-secret-token`), the MCP server and Alexa (a `de_` token), `push-action`
(an HMAC token in the payload) — that rejects **the only caller that is supposed to reach
it**, at the gateway, before the isolate starts. `push-action` was one deploy away from it.

The tell is that the refusal is not in your words:

```
401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}   ← gateway
401 {"error":"Invalid or expired token"}                                              ← requireUser()
```

`npm run verify` asserts every function has a block.

---

## 6. Did it return 200 and refuse on purpose?

Read the `error` field in the body before anything else — the handler's refusals are written
for a human. Then the three that produce a cheerful 200 and no effect:

**A feature gate.** Every function calls `isEnabled()` at its entry point, and `planner`
defaults **off**. A run before the `planner` row existed spent nothing and said "no users
due for a plan", which is correct and looks like a bug.

```sql
select feature, enabled from user_features where user_id = '<id>' order by feature;
```

An absent row means the default, which is _on_ for everything except `planner`.

**An idempotency claim already taken.** `send-briefs` claims `brief_sends` _before_ sending,
`plan-day` claims `plan_sends`, `check-reminders` claims `task_notifications` per channel. A
second invocation for the same slot is a deliberate no-op. A failed send **releases** the
claim — if you find a claim with nothing delivered, the release is what to look at.

**Quiet hours.** They live inside `notify.ts`, so the function does its work and the
delivery is suppressed. Check `notification_prefs`.

---

## 7. Is only _some_ of production running your fix?

```bash
git grep -l 'shared/<the file you changed>' supabase/functions
```

Every function listed there bundles that module and needs redeploying. This is rule 3 in
CLAUDE.md and it has been broken twice, the second time in the very session that wrote the
rule: `_shared/gemini.ts` changed and **five of the seven** functions bundling it were
redeployed, so `ingest-news`, `parse-task` and `telegram-webhook` ran the old retry policy
for two days. The visible symptom was an embedding gap that _widened_ after the fix landed.

A deployed function can be diffed against the repo with
`mcp__supabase__get_edge_function`.

---

## 8. Did the tests stop running rather than start failing?

A **silent drop is worse than a red test.** Reading `Deno.env` in a top-level `const` in
`gemini.ts` made every test file that transitively imported it fail to _collect_ — the suite
reported 106 passing instead of 118, with no failure naming the twelve that vanished.

So check the count, not the colour:

```bash
npm test 2>&1 | grep -E "Test Files|Tests "
```

240 tests across 13 files, as of this writing, and `npm run verify` prints the number so a
drop is visible. The rule that governs it: a module is testable here only if **every
`npm:`/`jsr:` specifier it reaches is erased at compile time**, and touching a `Deno` global
at module load breaks the same rule from the other direction. See the `write-tests` skill.

---

## 9. Is the row there, but invisible to the caller?

RLS and grants are database behaviour and no TypeScript test touches them.

```sql
-- what can this role actually do?
select grantee, privilege_type from information_schema.column_privileges
where table_name = '<table>' and grantee in ('anon','authenticated');

select polname, cmd, qual from pg_policies where tablename = '<table>';
```

Three specific shapes to know:

- **RLS on with no policies denies everything.** Correct for `prefetch_feeds` /
  `prefetch_requests`; a silent outage for anything a user reads.
- **A column grant, not RLS, is what narrows three tables.** RLS decides which _rows_; it
  cannot express which _columns_. If an update silently does nothing, check the column
  grant.
- **`revoke execute … from anon` does not close a function.** Postgres grants EXECUTE to
  **PUBLIC** on every new function and `anon` inherits it, so revoking by name leaves the
  function reachable with nothing but the publishable key. This was live on three vector
  RPCs and one write. Revoke from `public, anon` and verify with
  `get_advisors(type: "security")`, not with the migration comment.
- The mirror image, and a useful signal rather than a bug: `supabase_read_only_user` holds
  no EXECUTE on the definer RPCs either, so a read-only connection calling one gets
  `42501: permission denied for function match_news_items`. That is the revoke working.

---

## 10. Only now read the logic

If all nine branches are clear, the bug is in the code — and the first place to look is a
**mirrored pair**, because the browser and Deno copies cannot import from each other and
drift silently:

`src/lib/tz.ts` ↔ `_shared/time.ts` · `task-logic.ts` ↔ `_shared/tasks.ts` ·
`queries.ts` (`FEATURES`) ↔ `_shared/features.ts`

The canonical case was a one-word signature difference — `Date | string` versus `Date` —
whose consequence was a `RangeError` three call layers away, breaking completion of any
all-day recurring task (i.e. any birthday) from Telegram or a push button. Run the
**`mirror-drift-checker`** subagent; it compares behaviour on the same input rather than
text.

---

## Write down what you found

If it cost more than an hour, it belongs in [docs/gotchas.md](../../../docs/gotchas.md) — that
file is why this skill has a decision tree instead of a shrug. If it was a wrong constant,
the number and how it was measured go in [docs/decisions.md](../../../docs/decisions.md). If it
is now checkable, add the assertion to `scripts/db-checks.sql` or a probe to
`scripts/contract/boot-smoke.ts` so `npm run verify` catches it next time instead of a
person.
