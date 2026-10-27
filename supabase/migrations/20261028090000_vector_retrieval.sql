-- Phase 8: make the embeddings readable.
--
-- Every article has carried a 768-dim Gemini embedding since Phase 3, and nothing has
-- ever read one: no index, no operator, no RPC. `news_items.related_item_id` has a column
-- and a foreign key, the news card has a "Follow-up" badge and /news has a sheet to open
-- the earlier story — all of it dead, waiting for the nearest-neighbour query described
-- in CLAUDE.md. This migration is that query, plus the indexes to make it cheap.
--
-- `vector` lives in the `extensions` schema on this project, not `public`, so every
-- function below pins `search_path = public, extensions`. Without it the parameter type
-- `vector(768)` does not resolve at definition time.

create extension if not exists vector with schema extensions;

-- ----------------------------------------------------------------- indexes
--
-- HNSW rather than IVFFlat: the pool is ~2k rows today and IVFFlat's lists have to be
-- retuned as a table grows, while HNSW needs no training pass and answers well at this
-- size. Both columns are cosine — the embeddings are normalized and every query below
-- uses `<=>`, so `vector_cosine_ops` is the operator class that the planner can use.
--
-- news_items_embedding_idx already exists in production but appears in no migration
-- file; it was created by hand. Declaring it here puts it back under version control,
-- and `if not exists` makes that a no-op against the live database.
create index if not exists news_items_embedding_idx
  on public.news_items using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists articles_embedding_idx
  on public.articles using hnsw (embedding extensions.vector_cosine_ops);

-- Follow-up linking scans one user's recent items. Without this the nearest-neighbour
-- pass degrades to a filter over every row the HNSW index returns.
create index if not exists news_items_user_created_idx
  on public.news_items (user_id, created_at desc);

-- ----------------------------------------------------------------- the ownership guard
--
-- These are SECURITY DEFINER because they read across RLS, so the scoping has to be
-- inside the body rather than left to the caller — the same reason mcp/tools.ts routes
-- every read through mine()/myRow() instead of trusting each handler to remember.
--
-- `auth.uid()` wins whenever there is one: a signed-in caller can only ever search their
-- own rows, whatever they pass for p_user_id. A service-role caller has no auth.uid(),
-- and for it p_user_id is the identity — that is the Edge Function path. `anon` is
-- revoked at the bottom of this file, so the null-uid branch is not reachable from the
-- publishable key.

create or replace function public.match_news_items(
  p_user_id uuid,
  p_query_embedding extensions.vector(768),
  p_match_count integer default 10,
  p_since timestamptz default null,
  p_min_similarity double precision default 0.0
)
returns table (
  id uuid,
  digest_id uuid,
  category text,
  headline text,
  summary text,
  why_it_matters text,
  url text,
  source text,
  published_at timestamptz,
  url_resolved boolean,
  is_saved boolean,
  read_at timestamptz,
  similarity double precision
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_user is null then
    raise exception 'match_news_items requires a user';
  end if;

  return query
  select
    n.id, n.digest_id, n.category, n.headline, n.summary, n.why_it_matters,
    n.url, n.source, n.published_at, n.url_resolved, n.is_saved, n.read_at,
    1 - (n.embedding <=> p_query_embedding) as similarity
  from public.news_items n
  where n.user_id = v_user
    and n.embedding is not null
    and (p_since is null or n.created_at >= p_since)
    and 1 - (n.embedding <=> p_query_embedding) >= p_min_similarity
  order by n.embedding <=> p_query_embedding
  limit greatest(1, least(p_match_count, 100));
end;
$$;

-- The shared pool. `articles` is already readable by any authenticated user (Phase 3),
-- so there is nothing to scope here — but the date window and the similarity floor are
-- what keep a topic query from dragging the whole archive back.
create or replace function public.match_articles(
  p_query_embedding extensions.vector(768),
  p_match_count integer default 20,
  p_since date default null,
  p_categories text[] default null,
  p_min_similarity double precision default 0.0
)
returns table (
  id uuid,
  category text,
  url text,
  title text,
  source text,
  feed_name text,
  tier text,
  source_count integer,
  published_at timestamptz,
  summary text,
  url_resolved boolean,
  fetched_on date,
  similarity double precision
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  return query
  select
    a.id, a.category, a.url, a.title, a.source, a.feed_name, a.tier,
    a.source_count, a.published_at, a.summary, a.url_resolved, a.fetched_on,
    1 - (a.embedding <=> p_query_embedding) as similarity
  from public.articles a
  where a.embedding is not null
    and (p_since is null or a.fetched_on >= p_since)
    and (p_categories is null or a.category = any(p_categories))
    and 1 - (a.embedding <=> p_query_embedding) >= p_min_similarity
  order by a.embedding <=> p_query_embedding
  limit greatest(1, least(p_match_count, 200));
end;
$$;

-- ----------------------------------------------------------------- follow-up linking
--
-- For each item in a digest, the nearest *earlier* item the same user already saw.
--
-- Two things here were measured against the live pool rather than assumed, because the
-- 0.85 threshold CLAUDE.md proposed turns out to be almost exactly the median:
--
--   * Over 316 embedded items, the nearest cross-digest neighbour had a median
--     similarity of 0.8494. At a 0.85 floor, 157 of 316 items (50%) would earn a
--     "Follow-up" badge — a badge on half the feed, which is a badge on nothing.
--     Reading the pairs by band: 0.82-0.89 is "same category, unrelated story"
--     (Toothsi's raise matched against Even Healthcare's), while everything at 0.90 and
--     above was genuinely one thread — the Tessolve raise carried by two newsrooms, the
--     SEBI order against Avadhut Sathe, the CoreWeave debt story, the rupee's week, the
--     SME IPO rule changes. 0.90 keeps those and drops the noise: 35 of 316, about 11%.
--
--   * The link has to point backwards. `digest_id <> digest_id` alone is symmetric, so
--     an item would happily cite tomorrow's coverage as the story it follows up on, and
--     both cards would point at each other. `prior.created_at < n.created_at` is what
--     makes "follow-up" mean what the badge says — items from an earlier digest were
--     written earlier, so the row's own timestamp is enough and needs no join.
--
-- The digest_id comparison stays as well: two items inside one digest are near-duplicates
-- often enough, and that is an upstream merge failure, not a follow-up.
create or replace function public.link_followups(
  p_user_id uuid,
  p_digest_id uuid,
  p_days integer default 14,
  p_min_similarity double precision default 0.90
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_linked integer := 0;
begin
  with candidates as (
    select
      n.id,
      (
        select prior.id
        from public.news_items prior
        where prior.user_id = p_user_id
          and prior.digest_id <> n.digest_id
          and prior.created_at < n.created_at
          and prior.embedding is not null
          and prior.created_at >= now() - make_interval(days => p_days)
          and 1 - (prior.embedding <=> n.embedding) >= p_min_similarity
        order by prior.embedding <=> n.embedding
        limit 1
      ) as prior_id
    from public.news_items n
    where n.user_id = p_user_id
      and n.digest_id = p_digest_id
      and n.embedding is not null
  )
  update public.news_items n
  set related_item_id = c.prior_id
  from candidates c
  where n.id = c.id and c.prior_id is not null;

  get diagnostics v_linked = row_count;
  return v_linked;
end;
$$;

-- ----------------------------------------------------------------- grants
--
-- Supabase grants EXECUTE on every new public function to anon and authenticated by
-- default, the hole closed for the cron plumbing in 20261012093000. Same treatment here:
-- the two search functions are meant to be reachable from a signed-in browser and are
-- safe there because they resolve the user from auth.uid(); link_followups writes, runs
-- only inside build-digests, and has no business being callable over PostgREST at all.
revoke execute on function public.match_news_items(uuid, extensions.vector, integer, timestamptz, double precision) from anon;
revoke execute on function public.match_articles(extensions.vector, integer, date, text[], double precision) from anon;
revoke execute on function public.link_followups(uuid, uuid, integer, double precision) from anon, authenticated;
