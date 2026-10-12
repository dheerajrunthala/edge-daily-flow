-- Phase 3: the shared daily article pool, plus the two columns the pipeline needs.
--
-- `articles` is deliberately NOT per-user: every enabled user's categories are ingested
-- once, summarized once and embedded once, and `build-digests` then ranks that pool per
-- user. That is the whole cost model for multi-user news.

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  -- Unique across all time: an article is summarized and embedded exactly once, ever.
  url text not null unique,
  title text not null,
  -- Publisher ("reuters.com"), which differs from the feed that surfaced it.
  source text not null,
  feed_name text not null,
  tier text not null check (tier in ('primary', 'trusted', 'aggregator')),
  -- Distinct newsrooms that carried this story, from the cross-source merge.
  source_count integer not null default 1 check (source_count >= 1),
  published_at timestamptz,
  summary text,
  embedding vector(768),
  -- False when the link is still a Google News redirect we could not unwrap.
  url_resolved boolean not null default true,
  fetched_on date not null,
  created_at timestamptz not null default now()
);

-- The ingest + ranking access path: "today's pool for these categories".
create index if not exists articles_category_fetched_on_idx
  on public.articles (category, fetched_on desc);
create index if not exists articles_fetched_on_idx on public.articles (fetched_on desc);

alter table public.articles enable row level security;

-- Shared read-only reference data. Only the service role writes to it.
drop policy if exists "articles are readable by authenticated users" on public.articles;
create policy "articles are readable by authenticated users"
  on public.articles for select to authenticated using (true);

-- Carried over from articles so the UI can flag an unresolved aggregator link.
alter table public.news_items
  add column if not exists url_resolved boolean not null default true;

-- ingest-news is shared work with no owning user, but it still makes Gemini calls and
-- CLAUDE.md requires every one of them to be logged. Those rows get a null user_id,
-- which no RLS policy matches, so they stay invisible to users and out of their
-- per-user rate limits while remaining visible to the service role.
alter table public.ai_events alter column user_id drop not null;
