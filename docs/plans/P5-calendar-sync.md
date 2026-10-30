# P5 — Google Calendar, two-way

**Model: sonnet.** The hard part is OAuth plumbing with a known shape, not design.
**Size: ~1 day.** **Depends on:** nothing in code, but reuses the OAuth thinking in
[P4](P4-oauth-alexa.md) — doing P4 first makes this cheaper. Needs a Google Cloud project with
the Calendar API enabled and a consent screen.

Distinct from [P3](P3-calendar-export.md), which is a one-click `.ics` export with no
infrastructure. Do P3 regardless; it is half an hour and solves the common case.

## Why

**The morning planner cannot see when you are free.** `plan-day` reads your tasks and your
digest and proposes an order — which makes it a good prioritiser and not a scheduler. It will
cheerfully suggest you start a two-hour task at 2pm when you have a call at 2:15, because
nothing in the system knows about the call.

Busy blocks are the missing input. That is the whole motivation; task-push is the lesser half.

## Shape

New table `calendar_links` (user_id, refresh_token, calendar_id, scope, connected_at,
last_sync_at). The refresh token is a **credential at rest** — RLS on, no policies, service-role
only, and `revoke all from anon`. Follow `api_tokens`' discipline: the frontend must select
named columns and never `*`, so the token cannot leak into a React Query cache.

- `supabase/functions/calendar-oauth/index.ts` — the consent callback, exchanging the code for a
  refresh token. `verify_jwt = false`, and **add the `config.toml` block**.
- `supabase/functions/calendar-sync/index.ts` (cron secret) — pull today's busy blocks; push
  tasks that have a `due_at` and are not yet pushed.
- `_shared/calendar.ts` — the Google API client, token refresh, and the free/busy query.

Feature-gate it as `calendar` in `user_features` and read it with `isEnabled()` **at the
function's entry point**, not in the UI. See
[../decisions.md](../decisions.md) — a toggle that only hides a nav item is decoration, and this
one costs an API call per user per tick.

## Then the part that matters

Add busy blocks to the planner's context. Either a new read-only tool on the `planner` surface
in `_shared/agent-registry.ts` (`get_busy_blocks`), or inline them into the system prompt in
`functions/plan-day/index.ts`.

**Prefer the tool.** The planner's allowlist is read-only by construction and adding a read tool
preserves that property, whereas growing the prompt makes the agent's inputs invisible to the
`mcp_tool_calls` audit trail.

Then update the prompt so it schedules rather than orders: "you know when they are busy; suggest
times, not just a sequence."

## Traps

- **Token refresh.** A Google refresh token can be revoked by the user at any time. A 400
  `invalid_grant` means re-consent is needed — delete the row and surface it in Settings rather
  than retrying forever. This is the same reasoning as pruning a push subscription on 404/410.
- **Idempotent push.** Store the Google event id against the task, or every sync creates
  duplicates. `brief_sends`' claim-before-you-spend pattern is the house approach.
- **All-day tasks** are `DATE` values in Calendar's API too — the same trap as
  [P3](P3-calendar-export.md).
- **Do not push every task.** A `someday` task with no date has nothing to push, and a recurring
  task would need an RRULE rather than N events.
- **Rate limits.** Google Calendar's quotas are per-project, and `calendar-sync` runs per user;
  the fan-out lesson from `fanout_build_digests` applies.

## Acceptance criteria

- Connect, disconnect, and reconnect all work from Settings; disconnecting deletes the refresh
  token row.
- A revoked Google grant degrades to a clear "reconnect" state, not a retry loop.
- Pushing the same task twice creates one event.
- An all-day task appears on the correct date in IST.
- `plan-day` output demonstrably references a real calendar commitment — this is the acceptance
  criterion that actually matters, and the one to show in a demo.
- The `calendar` feature gate, verified by turning it off and confirming in the function logs
  that the user was skipped.

## Verification

Production path for `calendar-sync`. Read back: the `calendar_links` row, the created event id
on the task, and a `plan-day` run whose text mentions the commitment. Then turn the feature off
and confirm the next run skips the user.
