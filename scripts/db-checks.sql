-- Tier 3 — the database's own guarantees, as assertions.
--
-- Run it with the Supabase MCP: execute_sql(file contents). A PASS IS SILENCE. Every
-- assertion is its own `do $$ … end $$` block so that a failure names itself rather than
-- reporting "something in db-checks.sql".
--
-- This tier exists because RLS, policies, column grants and SECURITY DEFINER scoping are
-- *database* behaviour. No TypeScript test touches them, and the two bug classes they
-- cover have each bitten this project twice. Everything in here was previously verified by
-- hand through a session transcript nobody else could re-run.
--
-- Read-only, with one deliberate exception: assertion 7 has to call a function that
-- writes. It does so inside a PL/pgSQL block with an EXCEPTION clause, which Postgres
-- implements as a savepoint — raising inside it rolls the writes back. Assertion 7b then
-- proves the rollback happened rather than assuming it.
--
-- Expectations are expressed as sets compared with `=`, not as `not exists` on a known-bad
-- list. A set comparison goes red in BOTH directions: it catches a grant that was added
-- and a grant that was lost. That is what makes these assertions able to fail.


-- ───────────────────────────────────────────────────────────── 1. RLS on every table
--
-- Not "most tables". A table added without RLS is readable by every signed-in user of a
-- multi-user app with open signups.
do $$
declare v_missing text;
begin
  select string_agg(tablename, ', ' order by tablename) into v_missing
  from pg_tables
  where schemaname = 'public' and not rowsecurity;

  if v_missing is not null then
    raise exception 'ASSERTION 1 — RLS is off on: %', v_missing;
  end if;
end $$;


-- ───────────────────────────────────────────────────── 2. a policy on every read table
--
-- RLS with no policies denies everything, which is correct for the Google News prefetch
-- plumbing (service role and SECURITY DEFINER functions only) and a silent outage for
-- anything a user is supposed to read.
--
-- Compared as an exact set rather than "every table except these two has a policy": that
-- way adding a third policy-less table fails here, and so does accidentally granting the
-- prefetch tables a policy they were never meant to have.
do $$
declare
  v_expected text[] := array['prefetch_feeds', 'prefetch_requests'];
  v_actual   text[];
begin
  select coalesce(array_agg(t.tablename order by t.tablename), '{}') into v_actual
  from pg_tables t
  where t.schemaname = 'public'
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.tablename
    );

  if v_actual <> v_expected then
    raise exception
      'ASSERTION 2 — tables with RLS on and no policies should be exactly %, found %',
      v_expected, v_actual;
  end if;
end $$;


-- ──────────────────────────────────────────── 3. anon cannot execute the definer RPCs
--
-- These run as their owner and bypass RLS, so EXECUTE is the whole access check. The trap
-- the plan names: `revoke execute on function foo(uuid)` when the function is
-- `foo(uuid, int)` matches nothing and raises nothing — the revoke silently does not
-- happen. So this resolves each name through pg_proc and fails if a name resolves to no
-- function at all, which is what a rename or a signature change looks like.
do $$
declare
  v_expected text[] := array[
    'invoke_edge_function', 'fanout_ingest_news', 'fanout_build_digests',
    'prefetch_aggregator_feeds', 'get_prefetched_feeds', 'link_followups',
    'match_articles', 'match_news_items', 'match_topics_pool'
  ];
  v_name     text;
  v_found    int;
  v_exposed  text;
begin
  foreach v_name in array v_expected loop
    select count(*) into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;

    if v_found = 0 then
      raise exception
        'ASSERTION 3 — no function named public.% exists; a revoke against it matched nothing',
        v_name;
    end if;
  end loop;

  select string_agg(
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
           order by p.proname)
    into v_exposed
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any(v_expected)
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('public', p.oid, 'EXECUTE'));

  if v_exposed is not null then
    raise exception 'ASSERTION 3 — anon/PUBLIC can EXECUTE: %', v_exposed;
  end if;
end $$;

-- 3b. The same question asked the other way round, so that a *newly added* definer
-- function is caught without anyone remembering to extend the list above. Trigger
-- functions are excluded: they are granted to PUBLIC by default and cannot be invoked
-- directly ("trigger functions can only be called as triggers").
do $$
declare v_exposed text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_exposed
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and pg_get_function_result(p.oid) <> 'trigger'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_exposed is not null then
    raise exception
      'ASSERTION 3b — SECURITY DEFINER function(s) anon can EXECUTE: %. Add a revoke, or list it here with a reason.',
      v_exposed;
  end if;
end $$;


-- ──────────────────────────────────────────────────────────────── 4. column grants hold
--
-- RLS decides which ROWS a user may touch; it cannot express which COLUMNS. Three tables
-- are narrowed by column grant, and the narrowing is the whole guarantee: without it a
-- reader could rewrite the headline and summary the model wrote, or un-revoke their own
-- API token.
--
-- Only these three are asserted. The other owner-managed tables are deliberately
-- table-wide — editing the whole row is the point of a task or a profile.
do $$
declare
  v_expected text[];
  v_actual   text[];
  r record;
begin
  for r in
    select * from (values
      ('news_items', array['is_saved', 'read_at']),
      ('api_tokens', array['revoked_at']),
      ('topics',     array['enabled', 'weight'])
    ) as t(tbl, cols)
  loop
    v_expected := (select array_agg(c order by c) from unnest(r.cols) as c);

    select coalesce(array_agg(column_name::text order by column_name), '{}') into v_actual
    from information_schema.column_privileges
    where table_schema = 'public' and table_name = r.tbl
      and grantee = 'authenticated' and privilege_type = 'UPDATE';

    if v_actual <> v_expected then
      raise exception
        'ASSERTION 4 — authenticated UPDATE on %: expected exactly %, found %',
        r.tbl, v_expected, v_actual;
    end if;
  end loop;
end $$;

-- 4b. api_tokens.token_hash must not be SELECT-able. The plaintext token exists in exactly
-- one HTTP response, ever; the hash is what a stolen row would have to replay. This is
-- also why the frontend must select named columns and never `*`.
do $$
declare v_leaky text;
begin
  select string_agg(grantee || ':' || privilege_type, ', ') into v_leaky
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'api_tokens'
    and column_name = 'token_hash'
    and grantee in ('anon', 'authenticated');

  if v_leaky is not null then
    raise exception 'ASSERTION 4b — api_tokens.token_hash is reachable: %', v_leaky;
  end if;
end $$;

-- 4c. anon holds nothing at all on the tables whose migrations revoked it. Signups are
-- open, so anon is reachable by anyone on the internet with the publishable key.
do $$
declare v_granted text;
begin
  select string_agg(distinct table_name || '.' || privilege_type, ', ') into v_granted
  from information_schema.column_privileges
  where table_schema = 'public' and grantee = 'anon'
    and table_name in ('api_tokens', 'topics', 'user_features', 'plan_sends');

  if v_granted is not null then
    raise exception 'ASSERTION 4c — anon holds privileges on: %', v_granted;
  end if;
end $$;


-- ─────────────────────────────────────────── 5. match_news_items cannot cross accounts
--
-- The single most important assertion in this file. Every agent surface runs on the
-- service role, which bypasses RLS entirely, so `where n.user_id = v_user` inside this
-- function is the only thing standing between two accounts.
--
-- The accounts are resolved by data rather than hardcoded, so the assertion does not rot
-- when a test account is disabled. It asserts the result is NON-EMPTY first: "none of A's
-- rows came back" is also true of a function that returns nothing at all, and that version
-- of the test cannot fail.
do $$
declare
  v_a uuid; v_b uuid;
  v_probe vector(768);
  v_total int; v_leaked int;
begin
  select user_id into v_a
  from news_items where embedding is not null
  group by user_id order by count(*) desc limit 1;

  select user_id into v_b
  from news_items where embedding is not null and user_id <> v_a
  group by user_id order by count(*) desc limit 1;

  if v_a is null or v_b is null then
    raise exception
      'ASSERTION 5 — needs two accounts with embedded news_items; found a=%, b=%. Not skipped silently.',
      v_a, v_b;
  end if;

  -- A real vector from A's own rows, so it matches at least one of A's items perfectly.
  select embedding into v_probe
  from news_items where user_id = v_a and embedding is not null limit 1;

  select count(*), count(*) filter (where m.id in (
           select id from news_items where user_id = v_a))
    into v_total, v_leaked
  from public.match_news_items(v_b, v_probe, 100, null, 0.0) m;

  if v_total = 0 then
    raise exception
      'ASSERTION 5 — match_news_items returned nothing for account %; the no-leak check would pass vacuously',
      v_b;
  end if;

  if v_leaked > 0 then
    raise exception
      'ASSERTION 5 — match_news_items leaked % of account %''s rows to account % (% rows returned)',
      v_leaked, v_a, v_b, v_total;
  end if;
end $$;


-- ───────────────────────────────────────────── 6. HNSW indexes, right operator class
--
-- A vector index built with the wrong operator class is not an error: the planner simply
-- ignores it and every similarity query becomes a sequential scan over the whole table.
-- All three queries here use cosine distance (`<=>`), so all three need vector_cosine_ops.
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select * from (values
      ('articles', 'embedding'), ('news_items', 'embedding'), ('topics', 'embedding')
    ) as t(tbl, col)
  loop
    select pg_get_indexdef(i.indexrelid) into v_def
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    where i.indrelid = ('public.' || r.tbl)::regclass
      and am.amname = 'hnsw'
      and pg_get_indexdef(i.indexrelid) like '%' || r.col || ' vector_cosine_ops%'
    limit 1;

    if v_def is null then
      raise exception
        'ASSERTION 6 — no HNSW index with vector_cosine_ops on %.%; similarity queries will seq-scan',
        r.tbl, r.col;
    end if;
  end loop;
end $$;


-- ──────────────────────────────────── 7. link_followups writes nothing below 0.90
--
-- 0.90 is a measured constant, not a chosen one: 0.85 was the MEDIAN nearest cross-digest
-- neighbour over 316 items, so it would have badged half the feed as a follow-up. See
-- docs/decisions.md.
--
-- 7a is read-only and the real invariant: every link that exists in production is above
-- the threshold and points strictly backwards in time.
do $$
declare v_bad int; v_forward int;
begin
  select count(*) filter (where 1 - (n.embedding <=> p.embedding) < 0.90),
         count(*) filter (where p.created_at >= n.created_at)
    into v_bad, v_forward
  from news_items n
  join news_items p on p.id = n.related_item_id
  where n.embedding is not null and p.embedding is not null;

  if v_bad > 0 then
    raise exception 'ASSERTION 7a — % follow-up link(s) sit below 0.90 similarity', v_bad;
  end if;
  if v_forward > 0 then
    raise exception 'ASSERTION 7a — % follow-up link(s) point forwards in time, not earlier', v_forward;
  end if;
end $$;

-- 7b is behavioural, and the only block here that calls a function that writes.
--
-- The read-only check above cannot distinguish "the threshold gates the write" from "no
-- sub-0.90 pair happened to exist". So: clear one digest's links, run the function at
-- 0.90, and check what it wrote; then run it again at 0.50 and count what it writes when
-- the gate is opened. If the second number is not strictly larger, there were no sub-0.90
-- pairs available and 7b proved nothing — which is itself a failure, not a pass.
--
-- Every write happens inside a block with an EXCEPTION clause. Postgres implements that as
-- a savepoint, so raising at the end rolls back all of it; PL/pgSQL variables are not
-- transactional, so the numbers survive the rollback. Verified separately: the production
-- link count was identical before and after.
do $$
declare
  v_user uuid; v_digest uuid;
  v_at_90 int; v_at_50 int; v_below int;
  v_links_before int; v_links_after int;
begin
  select count(*) into v_links_before from news_items where related_item_id is not null;

  select d.user_id, d.id into v_user, v_digest
  from digests d
  join news_items n on n.digest_id = d.id
  group by d.id, d.user_id, d.digest_date
  having count(n.embedding) >= 10
  order by d.digest_date desc
  limit 1;

  if v_digest is null then
    raise exception
      'ASSERTION 7b — no digest with 10+ embedded items to exercise link_followups against. Not skipped silently.';
  end if;

  begin
    update news_items set related_item_id = null where digest_id = v_digest;
    v_at_90 := public.link_followups(v_user, v_digest, 14, 0.90);

    select count(*) into v_below
    from news_items n
    join news_items p on p.id = n.related_item_id
    where n.digest_id = v_digest and 1 - (n.embedding <=> p.embedding) < 0.90;

    update news_items set related_item_id = null where digest_id = v_digest;
    v_at_50 := public.link_followups(v_user, v_digest, 14, 0.50);

    -- Roll the savepoint back. '22000' is caught immediately below and nowhere else.
    raise exception using errcode = '22000', message = 'p1_db_checks_rollback';
  exception when sqlstate '22000' then
    null;
  end;

  if v_below > 0 then
    raise exception
      'ASSERTION 7b — link_followups at 0.90 wrote % link(s) below 0.90 on digest %',
      v_below, v_digest;
  end if;

  if v_at_50 <= v_at_90 then
    raise exception
      'ASSERTION 7b — inconclusive: digest % yields % link(s) at 0.90 and % at 0.50. With no sub-0.90 pair available this assertion cannot fail, so it is not allowed to pass.',
      v_digest, v_at_90, v_at_50;
  end if;

  -- Negative evidence: the skill's rule. An isolation or round-trip test that does not
  -- re-read the rows has not checked that nothing was left behind.
  select count(*) into v_links_after from news_items where related_item_id is not null;
  if v_links_after <> v_links_before then
    raise exception
      'ASSERTION 7b — the savepoint did not roll back: % links before, % after. PRODUCTION DATA HAS BEEN CHANGED.',
      v_links_before, v_links_after;
  end if;
end $$;


-- ──────────────────────────────────────────────────────── 8. the cron schedule is real
--
-- A documented job that was never scheduled is the quietest failure in the project: the
-- schedule lives in the database, the documentation lives in the repo, and nothing makes
-- them agree. Asserted as an exact set in both directions — a job present but
-- undocumented fails here too.
do $$
declare
  v_expected text[];
  v_actual   text[];
begin
  select array_agg(j order by j) into v_expected from unnest(array[
    'prefetch-aggregator-feeds|50 0 * * *',
    'fanout-ingest-news|0 1 * * *',
    'build-digests|30 1 * * *',
    'build-digests-retry|0 3 * * *',
    'send-briefs|*/15 * * * *',
    'plan-day|*/15 * * * *',
    'check-reminders|* * * * *',
    'repair-embeddings|7,17,27,37,47,57 * * * *'
  ]) as j;

  select array_agg(jobname || '|' || schedule order by jobname || '|' || schedule)
    into v_actual
  from cron.job where active;

  if v_actual <> v_expected then
    raise exception
      'ASSERTION 8 — active cron jobs do not match docs/operations.md. expected: % | found: %',
      v_expected, v_actual;
  end if;
end $$;

-- 8b. No job that spends Gemini quota may share a minute with repair-embeddings.
--
-- `*/10` would have fired at :00 of every hour — including 01:00 UTC, when
-- fanout-ingest-news starts one invocation per category, all of them embedding at once.
-- The repair's 90 requests would lose the race against the free tier's 100/minute, and the
-- articles that lost would be FRESH ones: pooled vectorless, and therefore permanent. A
-- repair job causing the damage it repairs.
--
-- check-reminders is the one documented exception. It runs every minute, so it shares a
-- minute with everything by construction, and it makes no Gemini call — it is one indexed
-- query. docs/decisions.md claims the repair offsets "share a minute with no other job",
-- which is true only of the jobs that spend quota.
do $$
declare
  v_repair int[] := array[7, 17, 27, 37, 47, 57];
  v_exempt text[] := array['repair-embeddings', 'check-reminders'];
  r record;
  v_clash text := null;
begin
  for r in select jobname, schedule from cron.job where active and jobname <> all(v_exempt)
  loop
    -- Expand the minute field of a 5-field cron expression into the minutes it fires on.
    declare
      v_field text := split_part(r.schedule, ' ', 1);
      v_minutes int[];
    begin
      if v_field = '*' then
        v_minutes := (select array_agg(m) from generate_series(0, 59) as m);
      elsif v_field like '*/%' then
        v_minutes := (select array_agg(m) from generate_series(0, 59) as m
                      where m % split_part(v_field, '/', 2)::int = 0);
      else
        v_minutes := (select array_agg(trim(t)::int) from unnest(string_to_array(v_field, ',')) as t);
      end if;

      if v_minutes && v_repair then
        v_clash := coalesce(v_clash || ', ', '') || r.jobname || ' (' || r.schedule || ')';
      end if;
    end;
  end loop;

  if v_clash is not null then
    raise exception
      'ASSERTION 8b — job(s) share a minute with repair-embeddings and may race it for the embedding quota: %',
      v_clash;
  end if;
end $$;
