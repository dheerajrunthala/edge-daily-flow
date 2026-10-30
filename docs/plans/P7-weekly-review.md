# P7 — The weekly review email

**Model: sonnet.** **Size: ~0.5h.** **Depends on: nothing.**

## Why

Daily Edge tells you about today, every day, and never about the week. The data for a
retrospective is all already there and never read: `task_completions` has every completion with
its occurrence, `news_items.read_at` records what was actually opened rather than merely
delivered, and `ai_events` has what the AI did on your behalf.

The honest framing for the email: what you finished, what slipped and is still open, and the
few stories you actually read.

## Shape

`supabase/functions/weekly-review/index.ts` (cron secret), Sunday evening in the user's
timezone, scheduled with `cron.schedule`.

Reuse rather than rebuild:

- **Idempotency**: a `review_sends` table on the `brief_sends` pattern — claimed _before_ the
  Gemini call, released if the send fails. Without the release, one SMTP hiccup marks the week
  done and the user silently gets nothing. See [../decisions.md](../decisions.md#reliability).
- **Email**: `_shared/email.ts`. Inline styles only — Gmail strips `<style>` — and always a
  plain-text part. Footer link to `${APP_URL}/settings`.
- **Prose**: one `generateWithTools` call, or `generateJson` if no tools are needed. Prefer
  `generateJson`: there is nothing to look up that the function cannot query itself, and a tool
  loop that has no decisions to make is just latency.
- **Gate**: a `weekly_review` feature in `user_features`, read with `isEnabled()` at the entry
  point. Default **off** — like `planner`, this is a thing that messages you unasked, and that
  should be opted into rather than discovered.

## Content

- completions this week vs last, from `task_completions`
- **still open and overdue**, which is the part a retrospective must not flatter
- tasks created, by `source` — the five creation paths
- stories read (`read_at is not null`) out of stories delivered, with the three most-opened
- one line of prose. Resist more: a weekly email that takes five minutes to read does not get
  read twice.

## Traps

- **"This week" is per-user.** Use `dayKey(now, user.timezone)` and the week boundary in _their_
  zone. A UTC week boundary is wrong by 5.5 hours for every current user, which can move a
  Sunday-night completion into the wrong week.
- An account with **nothing to report** should get no email, not an empty one.
- `ai_events.user_id` is **nullable** — ingest-news is shared work with no owning user, so a
  per-user aggregate must not assume otherwise.

## Acceptance criteria

- Running twice sends once.
- A failed send releases the claim, so the next tick retries.
- A new account with no history gets no email.
- Week boundaries correct in Asia/Kolkata.
- The email renders in Gmail with a plain-text alternative.

## Verification

`select public.invoke_edge_function('weekly-review', '{"user_id":"…","force":true}')`, read the
`review_sends` row and the delivered mail. Then invoke again and confirm it reports already
sent without a second email.
