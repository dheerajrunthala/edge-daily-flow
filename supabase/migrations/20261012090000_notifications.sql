-- Phase 5 — Notifications. Task reminders stop being a single email and become an
-- escalation across channels, with a per-occurrence ledger so a per-minute cron can
-- re-run all day without ever sending the same stage twice.
--
--   notification_prefs   which channels, when to stay quiet, how often to nag
--   task_notifications   the ledger: one row per (occurrence, stage, channel)
--   tasks.snoozed_until  "not now" — suppresses every stage before that instant
--   telegram_links       chat_id <-> user, established by a one-time /start code

-- ---------------------------------------------------------------- channels

do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_channel') then
    create type public.notification_channel as enum ('email', 'push', 'telegram');
  end if;
end;
$$;

create table if not exists public.notification_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- An array rather than a boolean per channel: every consumer wants "which channels",
  -- and the enum keeps a typo out of the column.
  channels public.notification_channel[] not null default '{email}',
  -- Quiet hours are wall-clock in profiles.timezone. start = end means "no quiet hours";
  -- a window that wraps midnight (22:00 -> 07:00) is the normal case, not an edge case.
  quiet_start time not null default '22:00',
  quiet_end time not null default '07:00',
  -- How often to re-ping an overdue task. Floors at a minute so a bad value cannot
  -- turn the per-minute cron into a send loop.
  nag_interval interval not null default '15 minutes'
    check (nag_interval >= interval '1 minute' and nag_interval <= interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;

drop policy if exists "notification_prefs are owner-managed" on public.notification_prefs;
create policy "notification_prefs are owner-managed"
  on public.notification_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists notification_prefs_touch on public.notification_prefs;
create trigger notification_prefs_touch before update on public.notification_prefs
  for each row execute function public.set_updated_at();

-- Everyone already signed up gets the defaults, so check-reminders never has to treat a
-- missing row as a special case for an existing user.
insert into public.notification_prefs (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------- the ledger

create table if not exists public.task_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  -- The occurrence this notification was about, copied from tasks.due_at at send time.
  -- A recurring task rolling forward therefore starts a fresh escalation for free.
  due_at timestamptz not null,
  -- 'lead' is the user's own remind_before; the rest are the fixed escalation plus
  -- 'nag:<k>', k being how many nag_intervals past due the ping was.
  stage text not null check (stage ~ '^(lead|1h|15m|due|nag:[0-9]{1,4})$'),
  channel public.notification_channel not null,
  -- false = the stage was accounted for but deliberately not sent: it came due while the
  -- function was down and a newer stage superseded it. Keeps the row (so it never fires
  -- late) without claiming an email went out.
  delivered boolean not null default true,
  sent_at timestamptz not null default now(),
  -- The whole point of the table: claimed before the send, so two overlapping ticks
  -- cannot both notify, and deleted again if the send fails so the next tick retries.
  unique (task_id, due_at, stage, channel)
);

create index if not exists task_notifications_user_sent_idx
  on public.task_notifications (user_id, sent_at desc);

alter table public.task_notifications enable row level security;

-- Read-only to the owner (Insights can show it later); only the service role writes.
drop policy if exists "task_notifications are readable by their owner" on public.task_notifications;
create policy "task_notifications are readable by their owner"
  on public.task_notifications for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- snooze

-- "Not now." Every stage whose fire time is before this instant is skipped outright and
-- never recorded, so when the snooze expires the escalation resumes at the current nag
-- rather than replaying the ones it slept through.
alter table public.tasks add column if not exists snoozed_until timestamptz;

-- ---------------------------------------------------------------- telegram

create table if not exists public.telegram_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Null until the user sends /start <code> to the bot.
  chat_id bigint unique,
  -- One-time link code. Nulled the moment it is used, so a leaked deep link is dead.
  code text unique,
  code_expires_at timestamptz,
  linked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.telegram_links enable row level security;

-- The owner may see their own link (the Settings page shows connected/not), but may not
-- write it: codes are minted by request_telegram_link() and consumed by the webhook.
drop policy if exists "telegram_links are readable by their owner" on public.telegram_links;
create policy "telegram_links are readable by their owner"
  on public.telegram_links for select to authenticated using (user_id = auth.uid());

drop trigger if exists telegram_links_touch on public.telegram_links;
create trigger telegram_links_touch before update on public.telegram_links
  for each row execute function public.set_updated_at();

/**
 * Mint a fresh link code for the calling user and return it with its expiry. The browser
 * never invents the code — it only learns the one the database generated, which is what
 * the deep link t.me/<bot>?start=<code> carries.
 *
 * base64 is translated into Telegram's allowed start-payload alphabet ([A-Za-z0-9_-]).
 */
create or replace function public.request_telegram_link()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_exp  timestamptz := now() + interval '15 minutes';
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  v_code := translate(encode(gen_random_bytes(16), 'base64'), '+/=', 'xyz');

  insert into public.telegram_links (user_id, code, code_expires_at)
  values (v_user, v_code, v_exp)
  on conflict (user_id) do update
    -- Deliberately leaves chat_id alone: asking for a new code while already linked is
    -- re-linking, not unlinking.
    set code = excluded.code,
        code_expires_at = excluded.code_expires_at,
        updated_at = now();

  return query select v_code, v_exp;
end;
$$;

revoke execute on function public.request_telegram_link() from public;
grant execute on function public.request_telegram_link() to authenticated;

/** Disconnect Telegram: drop the link and stop trying to deliver on that channel. */
create or replace function public.unlink_telegram()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  delete from public.telegram_links where user_id = v_user;

  update public.notification_prefs
     set channels = array_remove(channels, 'telegram'::public.notification_channel)
   where user_id = v_user;
end;
$$;

revoke execute on function public.unlink_telegram() from public;
grant execute on function public.unlink_telegram() to authenticated;

-- ---------------------------------------------------------------- signup

-- Seed notification_prefs alongside the profile, news_prefs and default tags.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  insert into public.news_prefs (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.notification_prefs (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.tags (user_id, name, color) values
    (new.id, 'Office',   'blue'),
    (new.id, 'Personal', 'green'),
    (new.id, 'Birthday', 'rose'),
    (new.id, 'Finance',  'amber'),
    (new.id, 'Health',   'cyan'),
    (new.id, 'Learning', 'violet')
  on conflict (user_id, name) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------- cron

-- Escalation needs minute resolution: "15 minutes before" cannot be delivered by a job
-- that only wakes up on the quarter hour. The ledger is what makes this safe to run 1440
-- times a day — a tick with nothing due does one indexed query and returns.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'check-reminders') then
    perform cron.unschedule('check-reminders');
  end if;
end;
$$;

select cron.schedule(
  'check-reminders', '* * * * *',
  $$select public.invoke_edge_function('check-reminders')$$
);
