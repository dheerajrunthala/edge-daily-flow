// ingest-news — build the shared daily article pool. Cron, once a day.
//
// Runs once for everybody: for a category, fetch its feeds, filter and merge them down to
// a shortlist, then summarize and embed the shortlist and upsert it into `articles`.
// build-digests then ranks that pool per user. Nothing here is per-user.
//
// **One category per invocation.** `fanout_ingest_news()` posts here once per category
// that somebody follows, so each run stays far inside the Edge Function wall clock. A
// request with no category processes every category in use under TIME_BUDGET_MS and
// reports anything it had to leave behind — that path is for manual runs.
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
  FEEDS,
  MAX_CANDIDATES_PER_CATEGORY,
  NEWS_CATEGORIES,
  THIN_EXCERPT_CHARS,
  feedsForCategories,
  fetchExcerpt,
  fetchFeed,
  isJunk,
  isNewsCategory,
  isRecent,
  mergeStories,
  parseFeed,
  resolveItemUrl,
  shortlist,
} from "../_shared/feeds.ts";
import { dayKey } from "../_shared/time.ts";

/** Articles per summarize call. Big enough to amortize the prompt, small enough to retry. */
const SUMMARY_BATCH = 12;
/** Feeds fetched at once. Feeds are IO-bound, but don't hammer any single host. */
const FETCH_CONCURRENCY = 8;
/** Article pages fetched at once when enriching thin excerpts. */
const ENRICH_CONCURRENCY = 6;
/**
 * Stop starting new categories past this. The Edge Function wall clock is 150s; a single
 * category has measured at ~20-70s, so this leaves room to finish the one in flight.
 */
const TIME_BUDGET_MS = 110_000;
/** How stale a prefetched body may be. The prefetch cron runs 10 minutes ahead. */
const PREFETCH_MAX_AGE = "45 minutes";
/** The pool is an Indian-morning artifact, so "today" is IST. */
const POOL_TZ = "Asia/Kolkata";
/** Articles the repair pass will look at in one invocation. */
const REPAIR_LIMIT = 50;
/**
 * Articles the embedding repair will do per invocation.
 *
 * Sized to the quota, not to the wall clock. The Gemini free tier allows **100
 * embed_content requests per minute**, and batchEmbedContents counts each *text* as a
 * request rather than each call — so 200 articles is 200 requests and exceeds the limit
 * before the second batch, whatever the backoff. 90 leaves headroom for whatever else is
 * embedding that minute (a topic being previewed, an agent search).
 *
 * The backlog is worked off across invocations instead: re-run until `remaining_null` is 0.
 */
const EMBED_REPAIR_LIMIT = 90;
/** How far back repair scans. Older pool entries are not worth the round trip. */
const REPAIR_SCAN_DAYS = 14;

type Candidate = {
  story: MergedStory;
  /** Text the summarizer reads: the feed excerpt, or a fetched og:description. */
  excerpt: string;
  summary: string | null;
  /** Assigned by the model from the content; the feed's category is only the fallback. */
  category: NewsCategory;
  embedding: number[] | null;
};

type PrefetchedBody = { status_code: number | null; content: string | null };

/**
 * What the summarizer actually needs. Kept separate from Candidate so the repair path,
 * which starts from `articles` rows rather than feed items, uses the same prompt, model
 * and parsing as the ingest path.
 */
type Summarizable = {
  title: string;
  publisher: string;
  /** The category to fall back to if the model's answer is unusable. */
  hint: NewsCategory;
  excerpt: string;
  summary: string | null;
  category: NewsCategory;
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

  if (body.repair === "embeddings") {
    return await repairEmbeddings(admin, body.limit ?? EMBED_REPAIR_LIMIT, started);
  }
  if (body.repair) return await repairSummaries(admin, body.limit ?? REPAIR_LIMIT, started);

  const requested = body.categories ?? (await categoriesInUse(admin));
  if (requested.length === 0) {
    return json({ ok: true, note: "no enabled users follow any category", categories: [] });
  }

  // Keep the prefetch cron's feed list in step with _shared/feeds.ts, which is the single
  // source of truth for what the aggregator tier is.
  await syncPrefetchFeeds(admin);
  const prefetched = await loadPrefetched(admin);

  const stats = {
    feeds_fetched: 0,
    feeds_from_prefetch: 0,
    feeds_empty: 0,
    items_parsed: 0,
    dropped_stale: 0,
    dropped_junk: 0,
    merged_stories: 0,
    shortlisted: 0,
    excerpts_enriched: 0,
    already_pooled: 0,
    recategorized: 0,
    inserted: 0,
    gemini_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  const perCategory: Record<string, unknown>[] = [];
  const skipped: string[] = [];

  for (const category of requested) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped.push(category);
      continue;
    }
    const report = await ingestCategory(admin, category, prefetched, now, fetchedOn, stats);
    if (report) perCategory.push(report);
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
  return json({
    ok: true,
    fetched_on: fetchedOn,
    runtime_ms,
    ...stats,
    categories: perCategory,
    ...(skipped.length > 0 ? { skipped_out_of_time: skipped } : {}),
  });
}

async function ingestCategory(
  admin: SupabaseClient,
  category: NewsCategory,
  prefetched: Map<string, PrefetchedBody>,
  now: Date,
  fetchedOn: string,
  stats: Record<string, number>,
): Promise<Record<string, unknown> | null> {
  const feeds = feedsForCategories([category]);
  if (feeds.length === 0) return null;

  const items = await fetchAll(feeds, prefetched, stats);
  stats.feeds_fetched += feeds.length;
  stats.items_parsed += items.length;

  const recent = items.filter((it) => isRecent(it, now));
  stats.dropped_stale += items.length - recent.length;

  const clean = recent.filter((it) => !isJunk(it));
  stats.dropped_junk += recent.length - clean.length;

  const stories = mergeStories(clean);
  stats.merged_stories += stories.length;

  // Everything above this line is free. Everything below costs money or latency, so the
  // cut happens here and nowhere else.
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
    excerpt: story.item.summary ?? "",
    summary: null,
    category,
    embedding: null,
  }));

  stats.excerpts_enriched += await enrichExcerpts(candidates);

  const rows: Summarizable[] = candidates.map((c) => ({
    title: c.story.item.title,
    publisher: c.story.item.publisher,
    hint: c.story.item.feed.category,
    excerpt: c.excerpt,
    summary: null,
    category,
  }));
  const usage = await summarize(rows, category);
  stats.gemini_calls += usage.calls;
  stats.input_tokens += usage.inputTokens;
  stats.output_tokens += usage.outputTokens;
  candidates.forEach((c, i) => {
    c.summary = rows[i].summary;
    c.category = rows[i].category;
  });
  const moved = candidates.filter((c) => c.category !== category).length;
  stats.recategorized += moved;

  const embedded = await embedAll(
    candidates.map((c) => `${c.story.item.title}\n\n${c.summary ?? ""}`.trim()),
  );
  candidates.forEach((c, i) => (c.embedding = embedded.vectors[i]));
  stats.gemini_calls += embedded.calls;

  const inserted = await upsertArticles(admin, candidates, fetchedOn);
  stats.inserted += inserted;

  console.log(
    `[${category}] parsed=${items.length} recent=${recent.length} clean=${clean.length} ` +
      `stories=${stories.length} shortlist=${picked.length} new=${fresh.length} ` +
      `enriched=${stats.excerpts_enriched} recategorized=${moved} inserted=${inserted}`,
  );
  return {
    category,
    feeds: feeds.length,
    parsed: items.length,
    after_window: recent.length,
    after_junk: clean.length,
    stories: stories.length,
    shortlisted: picked.length,
    new_to_pool: fresh.length,
    recategorized: moved,
    inserted,
  };
}

// ------------------------------------------------------------------- repair

type StaleRow = {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  category: string;
  source: string;
  url_resolved: boolean;
};

/** Punctuation- and case-insensitive, so "Title." counts as equal to "Title". */
function sameText(a: string, b: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b);
}

/**
 * Re-summarize pooled articles whose summary is really just their headline.
 *
 * `summarize` falls back to "excerpt, or failing that the title" whenever the model skips
 * an item or a batch errors, so a title-only summary is the expected scar from a thin feed
 * or a bad batch — not a one-off. This pass finds them, goes to the page for an
 * og:description the way ingest now does up front, and runs the same summarizer over the
 * result. Articles with no usable description are left alone rather than rewritten badly.
 *
 * Invoke with `{"repair": true}`. Safe to re-run: it only ever looks at rows that are
 * still title-only.
 */
async function repairSummaries(
  admin: SupabaseClient,
  limit: number,
  started: number,
): Promise<Response> {
  const since = new Date(Date.now() - REPAIR_SCAN_DAYS * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("articles")
    .select("id, url, title, summary, category, source, url_resolved")
    .gte("fetched_on", since)
    .order("fetched_on", { ascending: false })
    .limit(2000);
  if (error) throw error;

  // The normalised comparison cannot be expressed in PostgREST, so filter here.
  const stale = ((data ?? []) as StaleRow[])
    .filter((r) => !r.summary?.trim() || sameText(r.summary, r.title))
    .slice(0, limit);

  if (stale.length === 0) {
    return json({ ok: true, repaired: 0, note: "no title-only summaries found" });
  }

  // Same enrichment the ingest path uses, including the skip rules and 60-char floor.
  const excerpts: (string | null)[] = [];
  for (let i = 0; i < stale.length; i += ENRICH_CONCURRENCY) {
    const batch = stale.slice(i, i + ENRICH_CONCURRENCY);
    excerpts.push(...(await Promise.all(batch.map((r) => fetchExcerpt(r.url, r.url_resolved)))));
  }

  const usable = stale
    .map((row, i) => ({ row, excerpt: excerpts[i] }))
    .filter((x): x is { row: StaleRow; excerpt: string } => x.excerpt !== null);

  const rows: Summarizable[] = usable.map(({ row, excerpt }) => ({
    title: row.title,
    publisher: row.source,
    hint: isNewsCategory(row.category) ? row.category : "Global Tech",
    excerpt,
    summary: null,
    category: isNewsCategory(row.category) ? row.category : "Global Tech",
  }));

  const usage = await summarize(rows, "repair");

  // The summary changed, so the vector computed from it is stale too.
  const embedded = await embedAll(
    rows.map((r, i) => `${usable[i].row.title}\n\n${r.summary ?? ""}`.trim()),
  );

  let repaired = 0;
  let recategorized = 0;
  let itemsUpdated = 0;

  for (let i = 0; i < usable.length; i++) {
    const { row } = usable[i];
    const next = rows[i];
    // Still title-only after all that? Then the page had nothing to add either.
    if (!next.summary || sameText(next.summary, row.title)) continue;

    const { error: updateError } = await admin
      .from("articles")
      .update({
        summary: next.summary,
        category: next.category,
        embedding: embedded.vectors[i],
      })
      .eq("id", row.id);
    if (updateError) {
      console.error(`repair failed for ${row.id}`, updateError.message);
      continue;
    }
    repaired++;
    if (next.category !== row.category) recategorized++;

    // Carry the fix into any digest that already copied the old summary. Only rows that
    // are still title-only are touched, so an edited or newer copy is left alone.
    const { data: items } = await admin
      .from("news_items")
      .select("id, summary, headline")
      .eq("url", row.url);
    for (const item of (items ?? []) as { id: string; summary: string; headline: string }[]) {
      if (!sameText(item.summary, item.headline)) continue;
      const { error: itemError } = await admin
        .from("news_items")
        .update({ summary: next.summary })
        .eq("id", item.id);
      if (!itemError) itemsUpdated++;
    }
  }

  if (usage.calls > 0) {
    await logAiEvent(admin, {
      userId: null,
      kind: "summary",
      itemsProcessed: repaired,
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
    });
  }

  const runtime_ms = Date.now() - started;
  console.log(`repair: ${repaired}/${stale.length} re-summarized in ${runtime_ms}ms`);
  return json({
    ok: true,
    runtime_ms,
    found_stale: stale.length,
    had_description: usable.length,
    repaired,
    recategorized,
    news_items_updated: itemsUpdated,
    gemini_calls: usage.calls + embedded.calls,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    skipped_no_description: stale.length - usable.length,
  });
}

/**
 * Give a vector to pooled articles that never got one.
 *
 * These exist because embedding is allowed to fail softly: embedAll() logs a failed batch
 * and pools the article anyway, on the reasoning that a story without follow-up linking is
 * better than no story. That reasoning is right, but the consequence was not thought
 * through — upsertArticles uses ignoreDuplicates on a unique url, so an article pooled
 * without a vector is skipped on every subsequent run and stays vectorless **forever**. It
 * is invisible to topic matching and to follow-up linking for as long as it is in the pool.
 *
 * On 2026-10-28 that was 797 of 2,651 articles, going back to 2026-10-13 — 30% of the
 * archive, which is 30% of what every topic query can possibly match.
 *
 * Unlike the summary repair this makes no judgement about which rows deserve attention: a
 * null embedding is unambiguous. It also deliberately does not re-summarize, so the two
 * passes stay independent and either can be re-run alone. Safe to re-run; `limit` exists so
 * a backlog can be worked off across several invocations without risking the wall clock.
 */
async function repairEmbeddings(
  admin: SupabaseClient,
  limit: number,
  started: number,
): Promise<Response> {
  const { data, error } = await admin
    .from("articles")
    .select("id, title, summary")
    .is("embedding", null)
    // Oldest first, so repeated runs make monotonic progress through the backlog rather
    // than re-reading whatever happens to sort first.
    .order("fetched_on", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 500)));
  if (error) throw error;

  const rows = (data ?? []) as { id: string; title: string; summary: string | null }[];
  if (rows.length === 0) {
    return json({ ok: true, repaired: 0, note: "every pooled article already has a vector" });
  }

  // The same text shape ingest uses for a fresh article, so a repaired vector sits in the
  // same space as one embedded on the day. Getting this wrong would be invisible — the
  // vectors would simply be subtly worse neighbours.
  const texts = rows.map((r) => `${r.title}\n\n${r.summary ?? ""}`.trim());
  const { vectors, calls } = await embedAll(texts);

  let repaired = 0;
  let stillMissing = 0;
  for (const [i, row] of rows.entries()) {
    const vector = vectors[i];
    if (!vector) {
      stillMissing++;
      continue;
    }
    const { error: updateError } = await admin
      .from("articles")
      .update({ embedding: vector })
      .eq("id", row.id);
    if (updateError) {
      console.error(`embedding repair failed for ${row.id}`, updateError.message);
      stillMissing++;
      continue;
    }
    repaired++;
  }

  if (repaired > 0) {
    await logAiEvent(admin, {
      userId: null,
      kind: "embedding",
      itemsProcessed: repaired,
    });
  }

  const { count: remaining } = await admin
    .from("articles")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);

  const runtime_ms = Date.now() - started;
  console.log(
    `embedding repair: ${repaired}/${rows.length} in ${runtime_ms}ms, ${remaining ?? "?"} still null`,
  );
  return json({
    ok: true,
    repaired,
    attempted: rows.length,
    still_missing_in_batch: stillMissing,
    remaining_null: remaining ?? null,
    gemini_calls: calls,
    runtime_ms,
  });
}

async function readBody(req: Request): Promise<{
  categories?: NewsCategory[];
  repair?: true | "embeddings";
  limit?: number;
}> {
  try {
    const raw = (await req.json()) as {
      category?: unknown;
      categories?: unknown;
      repair?: unknown;
      limit?: unknown;
    };
    // `true` still means the summary repair, so every existing caller and every note in
    // CLAUDE.md keeps working; "embeddings" is the new pass.
    if (raw?.repair === true || raw?.repair === "embeddings") {
      const limit = Number(raw.limit);
      return {
        repair: raw.repair === "embeddings" ? "embeddings" : true,
        limit: Number.isFinite(limit) ? limit : undefined,
      };
    }
    // `category` is what fanout_ingest_news() sends; `categories` is for manual runs.
    if (isNewsCategory(raw?.category)) return { categories: [raw.category] };
    if (Array.isArray(raw?.categories)) {
      const list = raw.categories.filter(isNewsCategory);
      if (list.length > 0) return { categories: list };
    }
  } catch {
    // No body: process everything in use, under the time budget.
  }
  return {};
}

/** Every category at least one enabled user follows. */
async function categoriesInUse(admin: SupabaseClient): Promise<NewsCategory[]> {
  const { data, error } = await admin.from("news_prefs").select("categories").eq("enabled", true);
  if (error) throw error;
  const seen = new Set<string>();
  for (const row of data ?? []) for (const c of (row.categories ?? []) as string[]) seen.add(c);
  return [...seen].filter(isNewsCategory);
}

// ----------------------------------------------------------- aggregator prefetch

/**
 * Publish the aggregator feed list for the prefetch cron to read, and drop URLs that are
 * no longer in feeds.ts so it doesn't keep fetching a feed we removed.
 */
async function syncPrefetchFeeds(admin: SupabaseClient): Promise<void> {
  const wanted = FEEDS.filter((f) => f.tier === "aggregator");
  const { error } = await admin.from("prefetch_feeds").upsert(
    wanted.map((f) => ({ url: f.url, name: f.name, updated_at: new Date().toISOString() })),
    { onConflict: "url" },
  );
  if (error) throw error;

  const keep = new Set(wanted.map((f) => f.url));
  const { data: existing } = await admin.from("prefetch_feeds").select("url");
  const stale = (existing ?? []).map((r: { url: string }) => r.url).filter((u) => !keep.has(u));
  if (stale.length > 0) await admin.from("prefetch_feeds").delete().in("url", stale);
}

/**
 * Bodies fetched by Postgres a few minutes ago, keyed by URL.
 *
 * This exists because Google News answers HTTP 503 to the Edge Function network while
 * returning 200 to Postgres egress for the identical URL — an IP-range block, not
 * anything retrying can fix. A miss is not fatal: fetchAll falls back to a direct fetch.
 */
async function loadPrefetched(admin: SupabaseClient): Promise<Map<string, PrefetchedBody>> {
  const { data, error } = await admin.rpc("get_prefetched_feeds", {
    p_max_age: PREFETCH_MAX_AGE,
  });
  if (error) {
    console.error("get_prefetched_feeds failed, falling back to direct fetches", error.message);
    return new Map();
  }
  const map = new Map<string, PrefetchedBody>();
  for (const row of (data ?? []) as {
    url: string;
    status_code: number | null;
    content: string | null;
  }[]) {
    map.set(row.url, { status_code: row.status_code, content: row.content });
  }
  return map;
}

/** Fetch feeds with bounded concurrency, preferring a prefetched body. */
async function fetchAll(
  feeds: Feed[],
  prefetched: Map<string, PrefetchedBody>,
  stats: Record<string, number>,
): Promise<FeedItem[]> {
  const out: FeedItem[] = [];
  for (let i = 0; i < feeds.length; i += FETCH_CONCURRENCY) {
    const batch = feeds.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (feed) => {
        const pre = prefetched.get(feed.url);
        if (pre?.status_code === 200 && pre.content) {
          stats.feeds_from_prefetch++;
          return parseFeed(pre.content, feed);
        }
        if (pre && pre.status_code !== 200) {
          console.warn(`prefetch for ${feed.name} was HTTP ${pre.status_code}, fetching directly`);
        }
        return await fetchFeed(feed);
      }),
    );
    results.forEach((items, n) => {
      if (items.length === 0) {
        stats.feeds_empty++;
        console.warn(`feed ${batch[n].name}: no items`);
      }
      out.push(...items);
    });
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

/**
 * Several feeds ship a headline and nothing else — Hugging Face, the GitHub release
 * feeds, RBI. Summarizing from a headline alone produces a summary that restates the
 * headline, so go and read the page's og:description first. Returns how many were
 * actually improved.
 */
async function enrichExcerpts(candidates: Candidate[]): Promise<number> {
  const thin = candidates.filter((c) => c.excerpt.trim().length < THIN_EXCERPT_CHARS);
  let enriched = 0;
  for (let i = 0; i < thin.length; i += ENRICH_CONCURRENCY) {
    const batch = thin.slice(i, i + ENRICH_CONCURRENCY);
    const found = await Promise.all(
      batch.map((c) => fetchExcerpt(c.story.item.url, c.story.item.resolved)),
    );
    found.forEach((excerpt, n) => {
      if (excerpt && excerpt.length > batch[n].excerpt.length) {
        batch[n].excerpt = excerpt;
        enriched++;
      }
    });
  }
  return enriched;
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summaries: {
      type: "array",
      items: {
        type: "object",
        propertyOrdering: ["index", "category", "summary"],
        properties: {
          index: { type: "integer", description: "The [n] of the article being summarized." },
          category: {
            type: "string",
            enum: [...NEWS_CATEGORIES],
            description: "Which section this article actually belongs in, judged on content.",
          },
          summary: {
            type: "string",
            description: "Two sentences, factual, no preamble, no opinion.",
          },
        },
        required: ["index", "category", "summary"],
      },
    },
  },
  required: ["summaries"],
};

const SUMMARY_SYSTEM = `You summarize and file news articles for a daily brief read by an Indian software engineer.

For each numbered article, return a summary and the category it belongs in.

Summary — at most two sentences:
- Use only the information in the title and excerpt provided. Never add facts, numbers or
  names that are not there. If the excerpt is thin, write one short sentence from the title.
- Lead with what happened, not with the publication or the fact that it was reported.
- Plain declarative English. No hype, no "this article discusses", no questions, no emoji.
- Keep concrete specifics: company names, amounts, versions, regulators, dates.

Category — judge it from the content, not from where it was published. You are given the
feed's own category as a hint, and it is often wrong: an Indian business feed carries
global chip earnings, and a markets feed carries startup funding rounds.
- "AI": AI/ML research, models, AI products and the companies building them.
- "Software Development": programming, tooling, releases, infrastructure, engineering practice.
- "Indian Stock Market": Indian equities, indices, IPOs, RBI/SEBI action, bonds, the rupee.
- "Indian Startups & Tech": Indian startups, their funding, and Indian tech companies.
- "Global Tech": technology companies and products outside India, consumer tech, chips.
- "Policy & Regulation": law, regulation and government action on technology.
Pick the single best fit. When a story fits two, prefer the one a reader would look for it
under: an Indian company's funding round is "Indian Startups & Tech" even if it moves a
share price, and an AI model release is "AI" even if announced by a global tech company.`;

/** Fill in `summary` and `category` on each row, in batches. Mutates them. */
async function summarize(
  rows: Summarizable[],
  label: string,
): Promise<{ calls: number; inputTokens: number; outputTokens: number }> {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < rows.length; i += SUMMARY_BATCH) {
    const batch = rows.slice(i, i + SUMMARY_BATCH);
    const input = batch
      .map((row, n) => {
        const excerpt = row.excerpt.trim() || "(no excerpt available)";
        return (
          `[${n}] title: ${row.title}\n` +
          `    source: ${row.publisher}\n` +
          `    feed_category_hint: ${row.hint}\n` +
          `    excerpt: ${excerpt.slice(0, 700)}`
        );
      })
      .join("\n\n");

    try {
      const { data, usage } = await generateJson<{
        summaries: { index: number; category?: string; summary: string }[];
      }>({
        model: GEMINI_BULK_MODEL,
        system: SUMMARY_SYSTEM,
        input: `Feed category being ingested: ${label}\n\n${input}`,
        schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
      });
      calls++;
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;

      for (const row of data?.summaries ?? []) {
        const target = batch[row.index];
        if (!target) continue;
        if (typeof row.summary === "string" && row.summary.trim()) {
          target.summary = row.summary.trim().slice(0, 1000);
        }
        // Anything outside the list keeps the feed's category.
        if (isNewsCategory(row.category)) target.category = row.category;
      }
    } catch (e) {
      // A failed batch is not fatal: those articles keep the feed excerpt and the feed's
      // category, and the pool is still usable today.
      console.error(`summarize batch failed (${label})`, e instanceof Error ? e.message : e);
      calls++;
    }
  }

  // Anything the model skipped or a failed batch left behind keeps its excerpt.
  for (const row of rows) {
    if (!row.summary) row.summary = row.excerpt.trim().slice(0, 1000) || row.title;
  }
  return { calls, inputTokens, outputTokens };
}

/**
 * Embed in batches. Returns one vector (or null) per input text, in order. Callers pass
 * title + summary, which is what follow-up matching compares.
 */
async function embedAll(texts: string[]): Promise<{ vectors: (number[] | null)[]; calls: number }> {
  const vectors: (number[] | null)[] = new Array(texts.length).fill(null);
  let calls = 0;
  for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH) {
    const slice = texts.slice(i, i + MAX_EMBED_BATCH);
    try {
      const got = await embedBatch(slice);
      calls++;
      got.forEach((v, n) => (vectors[i + n] = v));
    } catch (e) {
      // No embedding means no follow-up linking for these items. Still worth pooling.
      console.error("embed batch failed", e instanceof Error ? e.message : e);
      calls++;
    }
  }
  return { vectors, calls };
}

async function upsertArticles(
  admin: SupabaseClient,
  candidates: Candidate[],
  fetchedOn: string,
): Promise<number> {
  if (candidates.length === 0) return 0;

  const rows = candidates.map((c) => ({
    // The model's call, not the feed's.
    category: c.category,
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
