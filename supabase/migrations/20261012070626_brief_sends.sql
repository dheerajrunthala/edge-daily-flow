-- One row per brief actually emailed, so send-briefs can run every 15 minutes and stay
-- idempotent: the unique constraint is what stops a retry (or an overlapping cron tick)
-- from sending the same slot twice.

create table if not exists public.brief_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The user's local date, not UTC: "today's brief" means today where they are.
  sent_for date not null,
  -- The news_prefs.email_times entry this send satisfies, 'HH:MM'.
  slot text not null check (slot ~ '^[0-2][0-9]:[0-5][0-9]$'),
  digest_id uuid references public.digests (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, sent_for, slot)
);

create index if not exists brief_sends_user_sent_for_idx
  on public.brief_sends (user_id, sent_for desc);

alter table public.brief_sends enable row level security;

-- Users may read their own send history (the Insights page can show it later); only the
-- service role writes.
drop policy if exists "brief_sends are readable by their owner" on public.brief_sends;
create policy "brief_sends are readable by their owner"
  on public.brief_sends for select to authenticated using (user_id = auth.uid());
