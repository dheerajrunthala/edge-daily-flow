-- Per-user feature switches, and the ai_events kinds the agent needs.
--
-- The switches exist because the app has grown four notification channels, a news digest,
-- a conversational assistant and a cron planner, and not everyone wants all of it. The
-- important design choice is where the switch is *read*: at the entry point of every
-- function, through one helper, never in the UI. A toggle that only hides a nav item is
-- decoration — the cron would keep running and the planner would keep messaging someone
-- who turned it off.
--
-- Stored as rows rather than a jsonb column so a feature can be queried across users
-- ("who has the planner on") without unpacking json, and so adding one needs no backfill:
-- an absent row means "default", which is resolved in _shared/features.ts.

create table if not exists public.user_features (
  user_id uuid not null references auth.users (id) on delete cascade,
  feature text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, feature),
  constraint user_features_known check (
    feature in (
      'digest', 'topics', 'reminders', 'planner', 'chat', 'voice', 'followups', 'telegram', 'push'
    )
  )
);

alter table public.user_features enable row level security;

-- Owner-managed in full: this is the one table whose entire purpose is for the user to
-- change it, so unlike topics there is nothing to withhold.
drop policy if exists "features are readable by their owner" on public.user_features;
create policy "features are readable by their owner"
  on public.user_features for select to authenticated using (user_id = auth.uid());

drop policy if exists "features are writable by their owner" on public.user_features;
create policy "features are writable by their owner"
  on public.user_features for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "features are updatable by their owner" on public.user_features;
create policy "features are updatable by their owner"
  on public.user_features for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "features are deletable by their owner" on public.user_features;
create policy "features are deletable by their owner"
  on public.user_features for delete to authenticated using (user_id = auth.uid());

revoke all on public.user_features from anon;

-- 'agent' is a conversational Gemini call, counted for its own daily limit. Separate from
-- 'task_parse' because the two have different costs and different limits, and folding
-- them would let a chat session eat the quick-add quota.
alter table public.ai_events drop constraint if exists ai_events_kind_check;
alter table public.ai_events
  add constraint ai_events_kind_check
  check (kind in ('task_parse', 'digest', 'summary', 'embedding', 'brief', 'agent', 'plan'));
