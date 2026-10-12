-- All five scheduled jobs. Times are UTC; the pipeline is built around an Indian
-- morning, so 01:00 UTC is 06:30 IST.
--
--   00:50  prefetch-aggregator-feeds  pg_net fetches the aggregator feeds (Google News
--          blocks the Edge Function network), leaving bodies in net._http_response
--   01:00  fanout-ingest-news         one ingest-news invocation per followed category
--   01:30  build-digests              one Gemini call per user over the shared pool
--   */15   send-briefs                emails whoever's email_time is in this window
--   */15   check-reminders            emails task reminders that have come due

/**
 * Invoke an Edge Function the way cron must: URL and shared secret from Vault, never
 * inlined into a job definition (cron.job is readable by the postgres role).
 */
create or replace function public.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, net, pg_temp
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise exception 'vault is missing project_url or cron_secret';
  end if;

  return net.http_post(
    url := v_url || '/functions/v1/' || p_name,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    body := p_body,
    -- Comfortably above the Edge Function wall clock, so pg_net is never the thing
    -- that gives up first.
    timeout_milliseconds := 180000
  );
end;
$$;

revoke execute on function public.invoke_edge_function(text, jsonb) from public;

-- Unschedule first so this migration can be re-run safely.
do $$
declare
  v_job text;
begin
  foreach v_job in array array[
    'prefetch-aggregator-feeds',
    'fanout-ingest-news',
    'build-digests',
    'send-briefs',
    'check-reminders'
  ] loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;
end;
$$;

-- 10 minutes ahead of ingest, so every body has landed by the time the function asks.
select cron.schedule(
  'prefetch-aggregator-feeds', '50 0 * * *',
  $$select public.prefetch_aggregator_feeds()$$
);

select cron.schedule(
  'fanout-ingest-news', '0 1 * * *',
  $$select public.fanout_ingest_news()$$
);

select cron.schedule(
  'build-digests', '30 1 * * *',
  $$select public.invoke_edge_function('build-digests')$$
);

select cron.schedule(
  'send-briefs', '*/15 * * * *',
  $$select public.invoke_edge_function('send-briefs')$$
);

select cron.schedule(
  'check-reminders', '*/15 * * * *',
  $$select public.invoke_edge_function('check-reminders')$$
);
