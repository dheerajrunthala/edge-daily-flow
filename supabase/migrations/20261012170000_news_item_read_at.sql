-- Read tracking. Opening a story's link is the signal — nothing else is honest, since
-- the app can't know whether a card scrolled past was actually read.
--
-- The column is on news_items (per user) rather than on the shared articles pool: two
-- users reading the same story is two different facts.
alter table public.news_items
  add column if not exists read_at timestamptz;

-- Users may update their own is_saved; read_at joins it. Everything else about an item
-- is the pipeline's to write, which is why this is a column grant and not a blanket one.
grant update (is_saved, read_at) on public.news_items to authenticated;

-- The News page filters "hide read" and counts unread per section against this.
create index if not exists news_items_user_read_idx
  on public.news_items (user_id, read_at);
