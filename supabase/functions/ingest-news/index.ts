// ingest-news — build the shared daily article pool. Cron, once a day.
//
// Runs once for everybody: for every category any enabled user follows, fetch that
// category's feeds, filter and merge them down to a shortlist, then summarize and embed
// the shortlist in batches and upsert it into `articles`. build-digests then ranks that
// pool per user. Nothing here is per-user, which is the entire cost model.
//
// Cost control, in order of how much it saves:
//  1. Only categories somebody actually follows are fetched at all.
//  2. The pool is cut to MAX_CANDIDATES_PER_CATEGORY before Gemini sees anything.
//  3. Articles already in `articles` (url is unique) are never summarized twice.
//  4. Summaries go out in batches of SUMMARY_BATCH, embeddings in batches of 50.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { GEMINI_BULK_MODEL, MAX_EMBED_BATCH, embedBatch, generateJson } from "../_shared/gemini.ts";
import {
  CORS_HEADERS,
  HttpError,
  hasCronSecret,
  json,
  logAiEvent,
  serviceClient,
} from "../_shared/supabase.ts";
import {
  type Feed,
  type FeedItem,
  type MergedStory,
  type NewsCategory,
  MAX_CANDIDATES_PER_CATEGORY,
  feedsForCategories,
  fetchFeed,
  isJunk,
  isRecent,
  mergeStories,
  resolveItemUrl,
  shortlist,
} from "../_shared/feeds.ts";
import { dayKey } from "../_shared/time.ts";

/** Articles per summarize call. Big enough to amortize the prompt, small enough to retry. */
const SUMMARY_BATCH = 12;
/** Feeds fetched at once. Feeds are IO-bound, but don't hammer any single host. */
const FETCH_CONCURRENCY = 8;
/** The pool is an Indian-morning artifact, so "today" is IST. */
const POOL_TZ = "Asia/Kolkata";

type Candidate = {
  story: MergedStory;
  summary: string | null;
  embedding: number[] | null;
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  // Shared, expensive and unauthenticated-by-nature work: cron secret only, no user path.
  if (!hasCronSecret(req)) throw new HttpError(401, "Missing or bad x-cron-secret");

  const started = Date.now();
  const admin = serviceClient();
  const body = await readBody(req);
  const now = new Date();
  const fetchedOn = dayKey(now, POOL_TZ);

  const categories = body.categories ?? (await categoriesInUse(admin));
  if (categories.length === 0) {
    return json({ ok: true, note: "no enabled users follow any category", categories: [] });
  }

  const stats = {
    feeds_fetched: 0,
    items_parsed: 0,
    dropped_stale: 0,
    dropped_junk: 0,
    merged_stories: 0,
    shortlisted: 0,
    already_pooled: 0,
    inserted: 0,
    gemini_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  const perCategory: Record<string, unknown>[] = [];

  for (const category of categories) {
    const feeds = feedsForCategories([category]);
    if (feeds.length === 0) continue;

    const items = await fetchAll(feeds);
    stats.feeds_fetched += feeds.length;
    stats.items_parsed += items.length;

    const recent = items.filter((it) => isRecent(it, now));
    stats.dropped_stale += items.length - recent.length;

    const clean = recent.filter((it) => !isJunk(it));
    stats.dropped_junk += recent.length - clean.length;

    const stories = mergeStories(clean);
    stats.merged_stories += stories.length;

    // Everything above this line is free. Everything below costs money, so the cut
    // happens here and nowhere else.
    const picked = shortlist(stories, now, MAX_CANDIDATES_PER_CATEGORY);
    stats.shortlisted += picked.length;

    // Resolve only what survived the cut — resolution is an HTTP call per story.
    const resolved: MergedStory[] = await Promise.all(
      picked.map(async (s) => ({ ...s, item: await resolveItemUrl(s.item) })),
    );

    const fresh = await dropAlreadyPooled(admin, resolved);
    stats.already_pooled += resolved.length - fresh.length;

    const candidates: Candidate[] = fresh.map((story) => ({
      story,
      summary: null,
      embedding: null,
    }));

    const summaryUsage = await summarize(candidates, category);
    stats.gemini_calls += summaryUsage.calls;
    stats.input_tokens += summaryUsage.inputTokens;
    stats.output_tokens += summaryUsage.outputTokens;

    const embedCalls = await embed(candidates);
    stats.gemini_calls += embedCalls;

    const inserted = await upsertArticles(admin, candidates, category, fetchedOn);
    stats.inserted += inserted;

    perCategory.push({
      category,
      feeds: feeds.length,
      parsed: items.length,
      after_window: recent.length,
      after_junk: clean.length,
      stories: stories.length,
      shortlisted: picked.length,
      new_to_pool: fresh.length,
      inserted,
    });
    console.log(
      `[${category}] parsed=${items.length} recent=${recent.length} clean=${clean.length} ` +
        `stories=${stories.length} shortlist=${picked.length} new=${fresh.length} inserted=${inserted}`,
    );
  }

  // Shared work, so no owning user. These rows carry a null user_id by design.
  if (stats.gemini_calls > 0) {
    await logAiEvent(admin, {
      userId: null,
      kind: "summary",
      itemsProcessed: stats.inserted,
      inputTokens: stats.input_tokens || null,
      outputTokens: stats.output_tokens || null,
    });
  }

  const runtime_ms = Date.now() - started;
  console.log(`ingest-news done in ${runtime_ms}ms`, JSON.stringify(stats));
  return json({ ok: true, fetched_on: fetchedOn, runtime_ms, ...stats, categories: perCategory });
}

async function readBody(req: Request): Promise<{ categories?: NewsCategory[] }> {
  try {
    const raw = (await req.json()) as { categories?: unknown };
    if (Array.isArray(raw?.categories)) {
      return { categories: raw.categories.filter((c): c is NewsCategory => typeof c === "string") };
    }
  } catch {
    // No body is the normal cron case.
  }
  return {};
}

/** Every category at least one enabled user follows. */
async function categoriesInUse(admin: SupabaseClient): Promise<NewsCategory[]> {
  const { data, error } = await admin.from("news_prefs").select("categories").eq("enabled", true);
  if (error) throw error;
  const seen = new Set<string>();
  for (const row of data ?? []) for (const c of (row.categories ?? []) as string[]) seen.add(c);
  return [...seen] as NewsCategory[];
}

/** Fetch feeds with bounded concurrency. */
async function fetchAll(feeds: Feed[]): Promise<FeedItem[]> {
  const out: FeedItem[] = [];
  for (let i = 0; i < feeds.length; i += FETCH_CONCURRENCY) {
    const batch = feeds.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchFeed));
    for (const items of results) out.push(...items);
  }
  return out;
}

/**
 * Drop stories whose URL is already in the pool. `articles.url` is unique across all
 * time, so this is what stops a slow-moving primary source (72h window) from being
 * re-summarized on three consecutive days.
 */
async function dropAlreadyPooled(
  admin: SupabaseClient,
  stories: MergedStory[],
): Promise<MergedStory[]> {
  if (stories.length === 0) return [];
  const urls = stories.map((s) => s.item.url);
  const { data, error } = await admin.from("articles").select("url").in("url", urls);
  if (error) throw error;
  const known = new Set((data ?? []).map((r: { url: string }) => r.url));
  return stories.filter((s) => !known.has(s.item.url));
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summaries: {
      type: "array",
      items: {
        type: "object",
        propertyOrdering: ["index", "summary"],
        properties: {
          index: { type: "integer", description: "The [n] of the article being summarized." },
          summary: {
            type: "string",
            description: "Two sentences, factual, no preamble, no opinion.",
          },
        },
        required: ["index", "summary"],
      },
    },
  },
  required: ["summaries"],
};

const SUMMARY_SYSTEM = `You summarize news articles for a daily brief read by an Indian software engineer.

For each numbered article you are given, write a summary of at most two sentences.
Rules:
- Use only the information in the title and excerpt provided. Never add facts, numbers or
  names that are not there. If the excerpt is thin, write one short sentence from the title.
- Lead with what happened, not with the publication or the fact that it was reported.
- Plain declarative English. No hype, no "this article discusses", no questions, no emoji.
- Keep concrete specifics: company names, amounts, versions, regulators, dates.
Return one entry per article, with the article's index.`;

/** Fill in `summary` on each candidate, in batches. Mutates the candidates. */
async function summarize(
  candidates: Candidate[],
  category: string,
): Promise<{ calls: number; inputTokens: number; outputTokens: number }> {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < candidates.length; i += SUMMARY_BATCH) {
    const batch = candidates.slice(i, i + SUMMARY_BATCH);
    const input = batch
      .map((c, n) => {
        const s = c.story.item;
        const excerpt = s.summary ? s.summary.slice(0, 700) : "(no excerpt available)";
        return `[${n}] title: ${s.title}\n    source: ${s.publisher}\n    excerpt: ${excerpt}`;
      })
      .join("\n\n");

    try {
      const { data, usage } = await generateJson<{
        summaries: { index: number; summary: string }[];
      }>({
        model: GEMINI_BULK_MODEL,
        system: SUMMARY_SYSTEM,
        input: `Category: ${category}\n\n${input}`,
        schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
      });
      calls++;
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;

      for (const row of data?.summaries ?? []) {
        const target = batch[row.index];
        if (target && typeof row.summary === "string" && row.summary.trim()) {
          target.summary = row.summary.trim().slice(0, 1000);
        }
      }
    } catch (e) {
      // A failed batch is not fatal: those articles fall back to the feed's own excerpt
      // below, and the pool is still usable today.
      console.error(`summarize batch failed (${category})`, e instanceof Error ? e.message : e);
      calls++;
    }
  }

  // Anything the model skipped or a failed batch left behind keeps the feed excerpt.
  for (const c of candidates) {
    if (!c.summary) {
      const fallback = c.story.item.summary?.trim();
      c.summary = fallback ? fallback.slice(0, 1000) : c.story.item.title;
    }
  }
  return { calls, inputTokens, outputTokens };
}

/** Fill in `embedding` on each candidate, in batches. Returns the call count. */
async function embed(candidates: Candidate[]): Promise<number> {
  let calls = 0;
  for (let i = 0; i < candidates.length; i += MAX_EMBED_BATCH) {
    const batch = candidates.slice(i, i + MAX_EMBED_BATCH);
    // Title plus summary is what follow-up matching compares, so embed both.
    const texts = batch.map((c) => `${c.story.item.title}\n\n${c.summary ?? ""}`.trim());
    try {
      const vectors = await embedBatch(texts);
      calls++;
      batch.forEach((c, n) => (c.embedding = vectors[n] ?? null));
    } catch (e) {
      // No embedding means no follow-up linking for these items. Still worth pooling.
      console.error("embed batch failed", e instanceof Error ? e.message : e);
      calls++;
    }
  }
  return calls;
}

async function upsertArticles(
  admin: SupabaseClient,
  candidates: Candidate[],
  category: string,
  fetchedOn: string,
): Promise<number> {
  if (candidates.length === 0) return 0;

  const rows = candidates.map((c) => ({
    category,
    url: c.story.item.url,
    title: c.story.item.title.slice(0, 500),
    source: c.story.item.publisher,
    feed_name: c.story.item.feed.name,
    tier: c.story.tier,
    source_count: c.story.sourceCount,
    published_at: c.story.item.publishedAt?.toISOString() ?? null,
    summary: c.summary,
    embedding: c.embedding,
    url_resolved: c.story.item.resolved,
    fetched_on: fetchedOn,
  }));

  // ignoreDuplicates: a URL already pooled keeps its original summary and embedding
  // rather than paying to overwrite them with an identical one.
  const { data, error } = await admin
    .from("articles")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError)
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    console.error("ingest-news failed", err);
    return json({ error: err instanceof Error ? err.message : "ingest-news failed" }, 500);
  }
});
