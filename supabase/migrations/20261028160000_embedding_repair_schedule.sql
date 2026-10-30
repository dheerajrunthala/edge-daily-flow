-- Make the embedding repair continuous, so a lost vector stops being permanent.
--
-- The free Gemini tier allows **100 embed_content requests per minute**, and
-- batchEmbedContents counts each *text* as a request rather than each call. A day's pool is
-- 130-150 articles fanned out across six categories that all start at once, so the limit is
-- exceeded every morning and embedAll() quite correctly pools the article anyway — a story
-- without follow-up linking beats no story.
--
-- The part that was wrong is what happened next: upsertArticles uses ignoreDuplicates on a
-- unique url, so an article pooled without a vector is skipped on every later run and stays
-- vectorless **forever**, invisible to topic matching and follow-up linking. That had
-- accumulated to 797 of 2,651 articles — 30% of the archive, and therefore 30% of what any
-- topic query could ever match.
--
-- One manual repair pass proved the quota theory precisely: asked to fix 200, it fixed
-- exactly 100 and was refused the rest. So the answer is not a bigger batch or a longer
-- backoff, it is a small pass that runs often:
--
--   90 articles per run, every 10 minutes = 540/hour, all of it inside the quota.
--
-- That clears the 697-article backlog in about an hour and then costs one indexed query
-- returning no rows, forever. Which is the real win — it is not a backfill, it is the reason
-- "pooled without a vector" is no longer a permanent state. Any future quota refusal is
-- repaired within ten minutes instead of never.
--
-- The schedule is `7,17,27,37,47,57` and deliberately **not** `*/10`.
--
-- `*/10` fires at minute :00 of every hour — including 01:00 UTC, the exact minute
-- fanout-ingest-news starts one ingest invocation per category, all of them embedding at
-- once. This job's 90 requests would then compete with ingest's own for the same 100/minute
-- window, and the articles that lost would be *fresh* ones, pooled vectorless and therefore
-- permanent. A repair job that causes the damage it repairs is worse than no repair job.
--
-- The odd offsets go further than avoiding :00: they share a minute with **no** other job in
-- this project (prefetch :50, ingest :00, digests :30, retry :00, send-briefs and plan-day
-- every :00/:15/:30/:45). That is deliberate. Minutes :15 and :45 would in fact have been
-- safe — send-briefs makes no Gemini call at all and the planner's read-only allowlist never
-- embeds — but a schedule that is safe *because of a correct argument about what each other
-- job does* stops being safe the moment one of them changes. This one needs no argument.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'repair-embeddings') then
    perform cron.unschedule('repair-embeddings');
  end if;
end $$;

select cron.schedule(
  'repair-embeddings',
  '7,17,27,37,47,57 * * * *',
  $job$select public.invoke_edge_function('ingest-news', '{"repair":"embeddings"}'::jsonb)$job$
);
