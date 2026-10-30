-- The planner's idempotency record.
--
-- Same pattern as brief_sends and task_notifications, for the same reason: plan-day runs
-- on a 15-minute cron and the fire window is slightly wider than the interval, so a user
-- whose morning_time falls between ticks is not skipped. That overlap is deliberate, and
-- this unique constraint is what stops it sending twice.
--
-- The row is claimed *before* the Gemini call and deleted again if the send fails, so a
-- crash leaves no claim behind — the rule send-briefs follows, because one SMTP hiccup
-- marking the day done means the user silently gets nothing.
create table if not exists public.plan_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_for date not null,
  created_at timestamptz not null default now(),
  unique (user_id, sent_for)
);

alter table public.plan_sends enable row level security;

-- Owner-readable so the app can say "today's plan was sent at ...". Only the service role
-- writes, like every other ledger in this project.
drop policy if exists "plan sends are readable by their owner" on public.plan_sends;
create policy "plan sends are readable by their owner"
  on public.plan_sends for select to authenticated using (user_id = auth.uid());

revoke all on public.plan_sends from anon;
