-- Phase 8: what you follow becomes a vector query.
--
-- Until now "what news do I want" was six strings from a hard-coded enum in
-- _shared/feeds.ts. That enum is the shape of the *feed list*, not the shape of anyone's
-- interests — a reader who wants Kubernetes security or Formula 1 has no way to say so,
-- and adding each new interest meant finding feeds for it, which is why the list never
-- grew.
--
-- A topic is a sentence the user writes, embedded once, and matched against the shared
-- article pool by cosine similarity. That costs one embed call per topic *ever* and zero
-- per digest: the pool is already built and already embedded, so the cost model in
-- CLAUDE.md — "never run the full Gemini pipeline per user" — survives intact. It also
-- turns a documented wart into the design. CLAUDE.md notes that "a category's pool can
-- contain articles that arrived via another category's feeds"; once retrieval is a vector
-- query, the pool is just a pool and which feed surfaced a story stops mattering.
--
-- Topics do not replace categories, they union with them. A user with no topics gets
-- exactly today's digest.

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- What the user typed. Matched by meaning, so it reads like a phrase, not a keyword.
  label text not null check (length(btrim(label)) between 2 and 120),
  -- Null only in the window between insert and the embed call; a topic without a vector
  -- matches nothing, which is why the browser is not allowed to create one (see grants).
  embedding extensions.vector(768),
  enabled boolean not null default true,
  -- Multiplies the topic's similarity when candidates from several topics are merged, so
  -- a reader can say "I care about this one more" without it swamping the rest.
  weight real not null default 1.0 check (weight > 0 and weight <= 3),
  created_at timestamptz not null default now()
);

-- Case-insensitive, because "kubernetes security" and "Kubernetes Security" are one
-- interest and two rows would double that topic's weight in the merge.
create unique index if not exists topics_user_label_idx
  on public.topics (user_id, lower(btrim(label)));

create index if not exists topics_user_enabled_idx
  on public.topics (user_id) where enabled;

create index if not exists topics_embedding_idx
  on public.topics using hnsw (embedding extensions.vector_cosine_ops);

alter table public.topics enable row level security;

drop policy if exists "topics are readable by their owner" on public.topics;
create policy "topics are readable by their owner"
  on public.topics for select to authenticated using (user_id = auth.uid());

drop policy if exists "topics are updatable by their owner" on public.topics;
create policy "topics are updatable by their owner"
  on public.topics for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "topics are deletable by their owner" on public.topics;
create policy "topics are deletable by their owner"
  on public.topics for delete to authenticated using (user_id = auth.uid());

-- No insert policy. Creating a topic means embedding its label, the browser never calls
-- Gemini, and a row written without a vector is a topic that silently matches nothing —
-- so inserts go through the `topics` Edge Function on the service role.
--
-- Updates are narrowed to the two fields that do not invalidate the vector, the same way
-- news_items grants `authenticated` only is_saved and read_at and api_tokens only
-- revoked_at. Editing the label would have to re-embed, so it is a delete and re-add.
revoke update on public.topics from authenticated, anon;
grant update (enabled, weight) on public.topics to authenticated;
revoke all on public.topics from anon;

-- ----------------------------------------------------------------- topic retrieval
--
-- One call returns the day's pool for every enabled topic at once, already weighted and
-- deduplicated. Doing it per-topic from the Edge Function would be N round trips and
-- would leave the caller to merge rows that the database can merge for free — and the
-- weighted-max is the whole point: an article matched by two topics is more wanted, not
-- counted twice.
--
-- The 0.80 floor is measured, and the number is not intuitive. gemini-embedding-001 at
-- 768 dimensions puts *everything* in a narrow band — across seven probe labels against
-- the live pool, every similarity landed between 0.75 and 0.88. A floor of 0.5, which
-- reads like "at least half related", matches the entire archive.
--
-- What separates cleanly is coverage. Labels the pool genuinely carries peaked at:
--
--   open source developer tooling releases   0.8758
--   RBI monetary policy and interest rates   0.8498
--   Kubernetes security                      0.8448
--   semiconductor manufacturing in India     0.8401
--
-- and labels it carries nothing about peaked at:
--
--   Formula 1 racing                         0.7906
--   Indian cricket team                      0.7817
--   cricket match results                    0.7735
--
-- 0.80 sits in that gap, so a topic we have no feeds for returns nothing at all rather
-- than returning the four least-unrelated stories in the pool and pretending. That
-- matters more than precision inside a matched topic: the Gemini ranking pass downstream
-- re-sorts whatever comes back, but it cannot tell that every candidate it was handed is
-- noise. 0.82 was rejected — it cuts "semiconductor manufacturing in India" from 12
-- matches to 3, and that topic is well covered.
create or replace function public.match_topics_pool(
  p_user_id uuid,
  p_since date,
  p_per_topic integer default 40,
  p_min_similarity double precision default 0.80
)
returns table (
  id uuid,
  category text,
  url text,
  title text,
  source text,
  tier text,
  source_count integer,
  published_at timestamptz,
  summary text,
  url_resolved boolean,
  embedding extensions.vector(768),
  score double precision,
  matched_topics text[]
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
    raise exception 'match_topics_pool requires a user';
  end if;

  return query
  with hits as (
    select
      a.id, a.category, a.url, a.title, a.source, a.tier, a.source_count,
      a.published_at, a.summary, a.url_resolved, a.embedding,
      t.label,
      (1 - (a.embedding <=> t.embedding)) * t.weight as weighted
    from public.topics t
    cross join lateral (
      select a.* from public.articles a
      where a.embedding is not null
        and a.fetched_on >= p_since
        and 1 - (a.embedding <=> t.embedding) >= p_min_similarity
      order by a.embedding <=> t.embedding
      limit greatest(1, least(p_per_topic, 200))
    ) a
    where t.user_id = v_user and t.enabled and t.embedding is not null
  )
  select
    h.id, h.category, h.url, h.title, h.source, h.tier, h.source_count,
    h.published_at, h.summary, h.url_resolved, h.embedding,
    max(h.weighted) as score,
    array_agg(distinct h.label) as matched_topics
  from hits h
  group by h.id, h.category, h.url, h.title, h.source, h.tier, h.source_count,
           h.published_at, h.summary, h.url_resolved, h.embedding
  order by score desc;
end;
$$;

revoke execute on function public.match_topics_pool(uuid, date, integer, double precision) from anon;
