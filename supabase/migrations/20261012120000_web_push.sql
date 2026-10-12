-- Phase 6 — browser notifications. Two halves, independent of each other:
--
--   push_subscriptions   one row per browser that granted permission, so the `push`
--                        channel in notification_channel finally has somewhere to send
--   realtime             task_notifications joins the realtime publication, so an open
--                        tab learns about its own ledger rows as they are written
--
-- The ledger stays the single source of truth for "was this notified": in-app toasts are
-- a *view* of rows check-reminders already claimed, not a second delivery path that could
-- disagree with it.

-- ---------------------------------------------------------------- subscriptions

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The push service's URL for this browser. Unique across all users and the natural
  -- key: re-subscribing the same browser must update a row, never add a second one.
  endpoint text not null unique,
  -- RFC 8291 client keys, base64url exactly as PushSubscription.toJSON() reports them.
  p256dh text not null,
  auth text not null,
  -- Only so the Settings list can say "Chrome on macOS" instead of a 200-char URL.
  user_agent text,
  created_at timestamptz not null default now(),
  -- Stamped on every successful send; a subscription that has not been used in months is
  -- usually a browser profile that no longer exists.
  last_used_at timestamptz
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- The owner may list their devices and revoke one. Inserts go through push-subscribe with
-- the service role: the endpoint and keys are only meaningful if they round-trip through a
-- server that can actually encrypt to them, and validating that is the function's job.
drop policy if exists "push_subscriptions are readable by their owner" on public.push_subscriptions;
create policy "push_subscriptions are readable by their owner"
  on public.push_subscriptions for select to authenticated using (user_id = auth.uid());

drop policy if exists "push_subscriptions are revocable by their owner" on public.push_subscriptions;
create policy "push_subscriptions are revocable by their owner"
  on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- realtime

-- An open tab subscribes to its own task_notifications inserts. Realtime applies the
-- table's RLS to the subscriber's JWT, and the only policy here is
-- "user_id = auth.uid()" for select, so a channel cannot be talked into streaming
-- someone else's reminders.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'task_notifications'
  ) then
    alter publication supabase_realtime add table public.task_notifications;
  end if;
end;
$$;
