// build-digests — turn the shared article pool into one personal digest per user.
// Cron, right after ingest-news.
//
// Exactly one Gemini call per user per day. The pool has already been filtered and
// shortlisted by ingest-news, so this call only has to rank what is there against the
// user's news_profile and write "why it matters" for the ones it picks.
//
// The model never supplies a URL, headline or source: it returns indices into the
// candidate list and we copy those fields out of `articles`. That is the rule from
// CLAUDE.md — URLs come only from fetched feed items — enforced structurally rather
// than by validating model output after the fact.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { GEMINI_PARSE_MODEL, generateJson } from "../_shared/gemini.ts";
import {
  CORS_HEADERS,
  HttpError,
  hasCronSecret,
  json,
  logAiEvent,
  serviceClient,
} from "../_shared/supabase.ts";
import { dayKey, isValidTimezone } from "../_shared/time.ts";

const DEFAULT_TZ = "Asia/Kolkata";
/**
 * Candidates per category handed to the ranking call. Keep this equal to
 * MAX_CANDIDATES_PER_CATEGORY in _shared/feeds.ts: the ranking prompt should see exactly
 * what ingest-news shortlisted, no more. Deliberately duplicated rather than imported —
 * this function has no other use for the source map.
 */
const PER_CATEGORY = 40;
/**
 * Candidates a single topic may contribute.
 *
 * Lower than PER_CATEGORY on purpose: a category is a whole section of the brief, while
 * a topic is one reader's narrow interest, and twenty topics at forty apiece would hand
 * the ranking prompt eight hundred candidates and a bill to match.
 */
const PER_TOPIC = 15;
/**
 * The ceiling on everything the ranking prompt sees.
 *
 * Categories alone could never approach it (six categories at forty), but topics are
 * user-controlled and the prompt cost is linear in this number, so the union needs a
 * limit that does not depend on how many interests someone has typed in.
 */
const MAX_CANDIDATES = 260;
/** Excerpt length per candidate in the prompt. Enough to rank on, not enough to be costly. */
const PROMPT_SUMMARY_CHARS = 260;

type ArticleRow = {
  id: string;
  category: string;
  url: string;
  title: string;
  source: string;
  tier: string;
  source_count: number;
  published_at: string | null;
  summary: string | null;
  embedding: string | number[] | null;
  url_resolved: boolean;
};

type UserRow = {
  user_id: string;
  categories: string[];
  headline_count: number;
  timezone: string;
  news_profile: string | null;
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  if (!hasCronSecret(req)) throw new HttpError(401, "Missing or bad x-cron-secret");

  const started = Date.now();
  const admin = serviceClient();
  const body = await readBody(req);

  const users = await targetUsers(admin, body.user_id);
  if (users.length === 0) {
    return json({ ok: true, note: "no enabled users to build for", users: [] });
  }

  const report: Record<string, unknown>[] = [];
  let geminiCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const user of users) {
    try {
      const result = await buildForUser(admin, user, body.force === true);
      geminiCalls += result.calls;
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      report.push({ user_id: user.user_id, ...result.summary });
    } catch (e) {
      // One user's failure must not stop the others: this is unattended cron work.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`build-digests failed for ${user.user_id}`, message);
      await markFailed(admin, user, message);
      report.push({ user_id: user.user_id, status: "failed", error: message });
    }
  }

  const runtime_ms = Date.now() - started;
  console.log(`build-digests done in ${runtime_ms}ms, ${geminiCalls} gemini calls`);
  return json({
    ok: true,
    runtime_ms,
    gemini_calls: geminiCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    users: report,
  });
}

async function readBody(req: Request): Promise<{ user_id?: string; force?: boolean }> {
  try {
    const raw = (await req.json()) as { user_id?: unknown; force?: unknown };
    return {
      user_id: typeof raw?.user_id === "string" ? raw.user_id : undefined,
      force: raw?.force === true,
    };
  } catch {
    return {};
  }
}

/**
 * Enabled users and the profile fields the ranking prompt needs.
 *
 * Two queries rather than one embedded select: news_prefs and profiles both have their
 * FK to auth.users and none to each other, so PostgREST cannot infer a relationship
 * between them and answers `profiles!inner(...)` with PGRST200.
 */
async function targetUsers(admin: SupabaseClient, onlyUser?: string): Promise<UserRow[]> {
  let query = admin
    .from("news_prefs")
    .select("user_id, categories, headline_count")
    .eq("enabled", true);
  if (onlyUser) query = query.eq("user_id", onlyUser);

  const { data: prefs, error } = await query;
  if (error) throw error;
  if (!prefs || prefs.length === 0) return [];

  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id, timezone, news_profile")
    .in(
      "id",
      prefs.map((p: { user_id: string }) => p.user_id),
    );
  if (profileError) throw profileError;

  const byId = new Map(
    (profiles ?? []).map(
      (p: { id: string; timezone: string | null; news_profile: string | null }) => [p.id, p],
    ),
  );

  return prefs.map((row: Record<string, unknown>) => {
    const profile = byId.get(row.user_id as string);
    const tz =
      profile?.timezone && isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TZ;
    return {
      user_id: row.user_id as string,
      categories: (row.categories ?? []) as string[],
      headline_count: (row.headline_count as number) ?? 20,
      timezone: tz,
      news_profile: profile?.news_profile ?? null,
    };
  });
}

async function buildForUser(admin: SupabaseClient, user: UserRow, force: boolean) {
  const today = dayKey(new Date(), user.timezone);

  const { data: existing } = await admin
    .from("digests")
    .select("id, status, items_count")
    .eq("user_id", user.user_id)
    .eq("digest_date", today)
    .maybeSingle();

  if (existing && existing.status === "ready" && !force) {
    return {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      summary: { status: "skipped", reason: "already built", items: existing.items_count },
    };
  }

  // Claim the day's digest before spending anything, so a crash leaves a visible
  // pending/failed row rather than silence.
  const digestId = await upsertDigest(admin, user, today, existing?.id);

  const candidates = await poolForUser(admin, user, today);
  if (candidates.length === 0) {
    await admin
      .from("digests")
      .update({ status: "failed", error: "no articles in today's pool", items_count: 0 })
      .eq("id", digestId);
    return {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      summary: { status: "failed", reason: "empty pool" },
    };
  }

  const wanted = Math.min(user.headline_count, candidates.length);
  const { data, usage } = await generateJson<RankResponse>({
    model: GEMINI_PARSE_MODEL,
    system: rankSystem(wanted),
    input: rankInput(user, candidates),
    schema: RANK_SCHEMA as unknown as Record<string, unknown>,
  });

  const picks = normalizePicks(data, candidates, wanted);
  if (picks.length === 0) throw new Error("ranking returned no usable picks");

  await writeItems(admin, user, digestId, picks, candidates);

  const linked = await linkFollowups(admin, user.user_id, digestId);

  const atAGlance = (data?.at_a_glance ?? "").trim().slice(0, 1200) || null;
  await admin
    .from("digests")
    .update({
      status: "ready",
      summary: atAGlance,
      items_count: picks.length,
      sources_scanned: candidates.length,
      error: null,
    })
    .eq("id", digestId);

  await logAiEvent(admin, {
    userId: user.user_id,
    kind: "digest",
    itemsProcessed: picks.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  console.log(
    `[${user.user_id}] ranked ${candidates.length} candidates -> ${picks.length} items for ${today}` +
      `, ${linked} follow-up${linked === 1 ? "" : "s"} linked`,
  );
  return {
    calls: 1,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    summary: {
      status: "ready",
      digest_id: digestId,
      candidates: candidates.length,
      items: picks.length,
      followups: linked,
    },
  };
}

/**
 * Point each of today's items at the earlier item it continues, where there is one.
 *
 * This is the only place the embeddings copied into news_items are ever read. It runs
 * after writeItems because it needs today's rows to already carry their vectors, and it
 * is deliberately not allowed to fail the digest: a missing "Follow-up" badge is a worse
 * outcome than a missing digest only if you have never seen a user open the app to find
 * nothing there. The ranking already cost a Gemini call by this point.
 */
async function linkFollowups(
  admin: SupabaseClient,
  userId: string,
  digestId: string,
): Promise<number> {
  const { data, error } = await admin.rpc("link_followups", {
    p_user_id: userId,
    p_digest_id: digestId,
  });
  if (error) {
    console.error(`[${userId}] follow-up linking failed: ${error.message}`);
    return 0;
  }
  return typeof data === "number" ? data : 0;
}

async function upsertDigest(
  admin: SupabaseClient,
  user: UserRow,
  today: string,
  existingId?: string,
): Promise<string> {
  if (existingId) {
    const { error } = await admin
      .from("digests")
      .update({ status: "pending", error: null })
      .eq("id", existingId);
    if (error) throw error;
    // Rebuilding the day: drop the previous items so we don't stack duplicates.
    await admin.from("news_items").delete().eq("digest_id", existingId);
    return existingId;
  }
  const { data, error } = await admin
    .from("digests")
    .insert({ user_id: user.user_id, digest_date: today, status: "pending" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/**
 * Today's pool for the user's categories, capped per category so one busy category
 * cannot crowd out the rest of the prompt.
 */
/**
 * Today's candidates for one reader: their categories, plus whatever their topics match.
 *
 * The two halves answer different questions. A category is "which feeds do we even
 * fetch for this person" and is capped per category so every section of the brief gets
 * a fair hearing. A topic is "find me this regardless of which feed carried it" — a
 * vector query over the same already-embedded pool, which costs nothing extra per day
 * and is the only way a reader can follow something we have no dedicated feed for.
 *
 * They union rather than replace. A user with no topics gets exactly the old digest,
 * which is what makes this safe to ship to existing accounts.
 */
async function poolForUser(
  admin: SupabaseClient,
  user: UserRow,
  today: string,
): Promise<ArticleRow[]> {
  const byId = new Map<string, ArticleRow>();

  for (const category of user.categories) {
    const { data, error } = await admin
      .from("articles")
      .select(
        "id, category, url, title, source, tier, source_count, published_at, summary, embedding, url_resolved",
      )
      .eq("category", category)
      .eq("fetched_on", today)
      .order("source_count", { ascending: false })
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(PER_CATEGORY);
    if (error) throw error;
    for (const row of (data ?? []) as ArticleRow[]) byId.set(row.id, row);
  }

  const fromTopics = await topicCandidates(admin, user, today);
  // Topics are added after categories and keyed by id, so a story both reach is carried
  // once. Which copy wins does not matter — they are the same row out of the same pool.
  for (const row of fromTopics) byId.set(row.id, row);

  const all = [...byId.values()];
  if (all.length <= MAX_CANDIDATES) return all;

  // Over the ceiling, keep the most corroborated stories: source_count is the one signal
  // here the model cannot read off a headline, and it is what ingest-news already uses
  // to decide a story is big.
  return all.sort((a, b) => (b.source_count ?? 1) - (a.source_count ?? 1)).slice(0, MAX_CANDIDATES);
}

/**
 * The topic half, or nothing at all.
 *
 * Deliberately swallows its own failure. Topics are additive — a digest built from
 * categories alone is the product as it shipped for three weeks — so a broken RPC should
 * narrow someone's brief, not replace it with a `failed` row and an empty page.
 */
async function topicCandidates(
  admin: SupabaseClient,
  user: UserRow,
  today: string,
): Promise<ArticleRow[]> {
  const { data, error } = await admin.rpc("match_topics_pool", {
    p_user_id: user.user_id,
    p_since: today,
    p_per_topic: PER_TOPIC,
  });
  if (error) {
    console.error(`[${user.user_id}] topic retrieval failed: ${error.message}`);
    return [];
  }

  const rows = (data ?? []) as (ArticleRow & { matched_topics: string[] })[];
  if (rows.length > 0) {
    console.log(`[${user.user_id}] topics contributed ${rows.length} candidates`);
  }
  return rows;
}

const RANK_SCHEMA = {
  type: "object",
  properties: {
    at_a_glance: {
      type: "string",
      description: "2-3 sentences on the day overall, for this reader. No list, no headings.",
    },
    picks: {
      type: "array",
      items: {
        type: "object",
        propertyOrdering: ["index", "importance", "why_it_matters"],
        properties: {
          index: { type: "integer", description: "The [n] of the chosen candidate." },
          importance: { type: "integer", description: "1-10, 10 = most important to this reader." },
          why_it_matters: {
            type: "string",
            description: "One sentence, specific to this reader. Not a restatement of the summary.",
          },
        },
        required: ["index", "importance", "why_it_matters"],
      },
    },
  },
  required: ["at_a_glance", "picks"],
};

type RankResponse = {
  at_a_glance?: string;
  picks?: { index: number; importance: number; why_it_matters: string }[];
};

function rankSystem(wanted: number): string {
  return `You are the editor of a daily news brief for one specific reader.

Pick the ${wanted} most valuable stories from the numbered candidates and rank them, most
important first. Return them in that order.

Each candidate carries two signals you must use:
- tier: "primary" means the organisation itself is speaking (a regulator, an AI lab, a
  release feed) — treat it as authoritative and prefer it over coverage of the same news.
  "trusted" is a newsroom. "aggregator" has no editorial control, so weigh it on content.
- source_count: how many independent newsrooms carried the story. A high count means the
  story is corroborated and widely considered important. It says nothing about quality,
  so never pick a thin story just because the count is high.

Selection rules:
- Relevance to the reader's profile comes first, importance second, freshness third.
- Cover the reader's interests rather than ${wanted} variations of one story. If several
  candidates are the same event, pick the best one and drop the rest.
- Prefer substance over announcements of announcements, opinion, and listicles.
- importance is 1-10 and should genuinely vary across your picks.
- why_it_matters is one sentence saying why THIS reader should care — a consequence, a
  risk, or what it changes. Never restate the headline.
- at_a_glance is 2-3 sentences on what today adds up to for this reader.
- Use only the information given. Never invent a fact, a number, or a story.`;
}

function rankInput(user: UserRow, candidates: ArticleRow[]): string {
  const profile = user.news_profile?.trim() || "A software engineer in India.";
  const lines = candidates.map((a, i) => {
    const published = a.published_at
      ? new Date(a.published_at).toISOString().slice(0, 16)
      : "unknown";
    const summary = (a.summary ?? "").replace(/\s+/g, " ").slice(0, PROMPT_SUMMARY_CHARS);
    return (
      `[${i}] ${a.title}\n` +
      `    category=${a.category} tier=${a.tier} source_count=${a.source_count} ` +
      `source=${a.source} published=${published}\n` +
      `    ${summary}`
    );
  });
  return [
    `Reader profile: ${profile}`,
    `Reader's categories: ${user.categories.join(", ")}`,
    `Headlines wanted: ${Math.min(user.headline_count, candidates.length)}`,
    "",
    `Candidates (${candidates.length}):`,
    lines.join("\n"),
  ].join("\n");
}

/** Keep only in-range, unique indices, in the model's order, capped at `wanted`. */
function normalizePicks(
  data: RankResponse,
  candidates: ArticleRow[],
  wanted: number,
): { index: number; importance: number; why: string }[] {
  const seen = new Set<number>();
  const out: { index: number; importance: number; why: string }[] = [];
  for (const pick of data?.picks ?? []) {
    const i = Number(pick?.index);
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
    seen.add(i);
    const importance = Math.min(10, Math.max(1, Math.round(Number(pick?.importance) || 5)));
    out.push({
      index: i,
      importance,
      why: (pick?.why_it_matters ?? "").trim().slice(0, 500),
    });
    if (out.length >= wanted) break;
  }
  return out;
}

async function writeItems(
  admin: SupabaseClient,
  user: UserRow,
  digestId: string,
  picks: { index: number; importance: number; why: string }[],
  candidates: ArticleRow[],
): Promise<void> {
  const rows = picks.map((pick, rank) => {
    const a = candidates[pick.index];
    return {
      digest_id: digestId,
      user_id: user.user_id,
      category: a.category,
      // Copied from the pool, never from the model.
      headline: a.title.slice(0, 500),
      summary: a.summary ?? a.title,
      why_it_matters: pick.why || null,
      url: a.url,
      source: a.source,
      published_at: a.published_at,
      importance: pick.importance,
      rank: rank + 1,
      embedding: a.embedding,
      url_resolved: a.url_resolved,
    };
  });
  const { error } = await admin.from("news_items").insert(rows);
  if (error) throw error;
}

async function markFailed(admin: SupabaseClient, user: UserRow, message: string): Promise<void> {
  const today = dayKey(new Date(), user.timezone);
  await admin
    .from("digests")
    .update({ status: "failed", error: message.slice(0, 500) })
    .eq("user_id", user.user_id)
    .eq("digest_date", today);
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error("build-digests failed", err);
    return json({ error: err instanceof Error ? err.message : "build-digests failed" }, 500);
  }
});
