-- Google News answers HTTP 503 to the Edge Function network but 200 to Postgres egress,
-- so the aggregator tier is fetched from the database with pg_net shortly before
-- ingest-news runs, and ingest-news reads the bodies back instead of fetching them.
--
-- net._http_response does not record which URL a response belongs to, only the request
-- id, so prefetch_requests keeps that mapping.

create table if not exists public.prefetch_feeds (
  url text primary key,
  name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.prefetch_requests (
  request_id bigint primary key,
  url text not null,
  requested_at timestamptz not null default now()
);

create index if not exists prefetch_requests_requested_at_idx
  on public.prefetch_requests (requested_at desc);

-- Internal plumbing: RLS on with no policies at all, so only the service role (which
-- bypasses RLS) and the SECURITY DEFINER functions below can touch these.
alter table public.prefetch_feeds enable row level security;
alter table public.prefetch_requests enable row level security;

/**
 * Fire one pg_net GET per aggregator feed. Scheduled ~10 minutes before ingest-news so
 * the responses have landed in net._http_response by the time the function asks.
 *
 * The feed list is written by ingest-news on every run (_shared/feeds.ts stays the single
 * source of truth), so this never needs editing when a feed is added.
 */
create or replace function public.prefetch_aggregator_feeds()
returns integer
language plpgsql
security definer
set search_path = public, net, pg_temp
as $$
declare
  v_url  text;
  v_id   bigint;
  v_done integer := 0;
begin
  delete from public.prefetch_requests where requested_at < now() - interval '1 day';

  for v_url in select url from public.prefetch_feeds loop
    -- Same browser User-Agent the function sends; some publishers 403 anything else.
    select net.http_get(
      url := v_url,
      headers := jsonb_build_object(
        'user-agent',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
          || '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept',
        'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      ),
      timeout_milliseconds := 20000
    ) into v_id;

    insert into public.prefetch_requests (request_id, url) values (v_id, v_url)
      on conflict (request_id) do update set url = excluded.url, requested_at = now();
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

/**
 * The bodies ingest-news reads. One row per URL, newest request wins.
 * Service role only — it exposes arbitrary fetched content.
 */
create or replace function public.get_prefetched_feeds(p_max_age interval default '45 minutes')
returns table (url text, status_code integer, content text)
language sql
security definer
set search_path = public, net, pg_temp
as $$
  select distinct on (r.url) r.url, resp.status_code, resp.content
  from public.prefetch_requests r
  join net._http_response resp on resp.id = r.request_id
  where r.requested_at > now() - p_max_age
  order by r.url, r.requested_at desc;
$$;

/**
 * Fan ingest-news out to one invocation per category, so each run stays far inside the
 * Edge Function wall clock no matter how many feeds a category has.
 */
create or replace function public.fanout_ingest_news()
returns integer
language plpgsql
security definer
set search_path = public, net, pg_temp
as $$
declare
  v_url      text;
  v_secret   text;
  v_category text;
  v_done     integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise exception 'vault is missing project_url or cron_secret';
  end if;

  -- Only categories somebody actually follows, which is the first cost control.
  for v_category in
    select distinct unnest(categories) from public.news_prefs where enabled
  loop
    perform net.http_post(
      url := v_url || '/functions/v1/ingest-news',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('category', v_category),
      timeout_milliseconds := 150000
    );
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, which would also expose these through
-- PostgREST. Take that back and hand out only what is needed.
revoke execute on function public.prefetch_aggregator_feeds() from public;
revoke execute on function public.get_prefetched_feeds(interval) from public;
revoke execute on function public.fanout_ingest_news() from public;
grant execute on function public.get_prefetched_feeds(interval) to service_role;
