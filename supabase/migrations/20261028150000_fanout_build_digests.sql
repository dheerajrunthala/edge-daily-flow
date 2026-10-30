-- One invocation per user, instead of one loop over all of them.
--
-- build-digests has always iterated users inside a single invocation, and on 2026-10-28 that
-- cost the real user three days of digests. The logs read: booted 01:30:03, spent two minutes
-- retrying Gemini 503s for a leftover QA account, claimed the real user's digest row at
-- 01:32:21, killed by the 150s wall clock at 01:32:33. That is also why the row sat in
-- `pending` and never reached `failed` — nothing survived to write a status.
--
-- Disabling the QA account treated the symptom. The disease is that per-user work shares one
-- wall clock, so the slowest user decides whether anybody else gets a digest. ingest-news
-- solved exactly this with fanout_ingest_news() (20261012065017); this is the same shape for
-- the other half of the pipeline, and it is deliberately a copy rather than an abstraction —
-- two short loops that each read plainly beat one parameterised helper nobody can follow.
--
-- Each user now gets their own 150s budget. A user whose Gemini call hangs costs their own
-- digest and nothing else.
create or replace function public.fanout_build_digests()
returns integer
language plpgsql
security definer
set search_path = public, net, pg_temp
as $$
declare
  v_url     text;
  v_secret  text;
  v_user    uuid;
  v_done    integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise exception 'vault is missing project_url or cron_secret';
  end if;

  -- Only users who actually want a digest, which is the same first cost control
  -- fanout_ingest_news applies to categories.
  for v_user in
    select user_id from public.news_prefs where enabled
  loop
    perform net.http_post(
      url := v_url || '/functions/v1/build-digests',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('user_id', v_user),
      timeout_milliseconds := 150000
    );
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

-- Same lockdown as the rest of the cron plumbing (20261012093000): Supabase grants EXECUTE on
-- every new public function to anon and authenticated by default, and this one reads the cron
-- secret out of Vault. pg_cron is unaffected — its jobs run as the function owner.
revoke execute on function public.fanout_build_digests() from anon, authenticated;
revoke execute on function public.fanout_build_digests() from public;

-- ---------------------------------------------------------------- schedules
--
-- cron.job is not writable by the migration role (permission denied), so schedules are
-- changed through cron.unschedule/cron.schedule by name — the same pattern
-- 20261012072101 and 20261012090000 already use. Unschedule-then-schedule rather than a
-- second job, because keeping both would double every digest build.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'build-digests') then
    perform cron.unschedule('build-digests');
  end if;
  if exists (select 1 from cron.job where jobname = 'build-digests-retry') then
    perform cron.unschedule('build-digests-retry');
  end if;
  if exists (select 1 from cron.job where jobname = 'plan-day') then
    perform cron.unschedule('plan-day');
  end if;
end $$;

select cron.schedule('build-digests', '30 1 * * *', 'select public.fanout_build_digests()');

-- A second attempt ninety minutes later, which costs nothing when the first one worked.
--
-- This is the other half of the lost-digest problem and it needs no new code: buildForUser
-- already returns "already built" for a digest whose status is `ready` and only rebuilds a
-- pending or failed one. So a repeat run is a no-op for every user who succeeded and a
-- retry for every user who did not. Without it a single bad night is unrecoverable — the
-- next day's run builds the next day's digest, and the dead row stays `pending` forever,
-- which is exactly what happened on 2026-10-26 and -27.
--
-- Chosen over an in-function reconciler deliberately: the retry is a property of the
-- schedule, not of the function, and expressing it as a schedule means there is no new
-- branch to get wrong.
select cron.schedule('build-digests-retry', '0 3 * * *', 'select public.fanout_build_digests()');

-- plan-day was never scheduled.
--
-- It was written, deployed, documented in CLAUDE.md's cron table and verified end to end by
-- hand — and then never given a cron row, so the autonomous morning planner has only ever
-- run when somebody invoked it manually. The function already filters to users whose
-- morning_time falls inside the window and is gated on the `planner` feature (which
-- defaults off), so a 15-minute schedule is cheap: for most ticks it is one indexed query
-- returning nobody.
select cron.schedule('plan-day', '*/15 * * * *', 'select public.invoke_edge_function(''plan-day'')');

-- ---------------------------------------------------------------- stop lying about dead digests
--
-- Four digests sit in `pending` for dates already past. Each is a row claimed by an
-- invocation that was then killed, so nothing survived to write a status — and because a
-- build only ever targets *today*, no future run can ever reach them. They will stay
-- `pending` forever while meaning `failed`.
--
-- Corrected rather than deleted: the row is the evidence that a digest was attempted and
-- lost, which is worth keeping. Scoped to past dates only, so today's in-flight build is
-- untouched.
--
-- Two caveats, both deliberate:
--
--   * "today" here is Asia/Kolkata, while each digest's own digest_date is assigned per user
--     via dayKey(now, user.timezone) in build-digests. Every account is currently IST so the
--     two agree, but if a user's zone ever lags Kolkata far enough, a cleanup written this
--     way could mark a genuinely in-flight build failed for them. Do not copy this cutoff
--     into a recurring job without making it per-user.
--   * Excluding today means a row already dead *today* is not repaired by this statement,
--     and build-digests-retry computes its own "today" when it fires, so it will not reach
--     back either. Such a row needs one manual invoke. There is one as of writing.
update public.digests
set status = 'failed',
    error = coalesce(error, 'abandoned: invocation killed before it could record a status '
                            || '(corrected by migration 20261028150000)')
where status = 'pending'
  and digest_date < (now() at time zone 'Asia/Kolkata')::date;
