// topics (user JWT) — add, preview and re-embed the things a reader follows.
//
//   {"action":"preview","label":"Kubernetes security"}   what this would have matched,
//                                                        without saving anything
//   {"action":"add","label":"Kubernetes security"}       embed, store, and return the
//                                                        same preview
//   {"action":"reembed"}                                 re-embed this user's topics
//
// Toggling `enabled`, changing `weight` and deleting are plain RLS writes from the
// browser — only creation needs a server, because creating a topic means embedding its
// label and the browser never calls Gemini. A row written without a vector is a topic
// that silently matches nothing, which is why `topics` has no insert policy at all.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { embedBatch } from "../_shared/gemini.ts";
import {
  CORS_HEADERS,
  HttpError,
  countAiEvents,
  json,
  logAiEvent,
  requireUser,
  serviceClient,
} from "../_shared/supabase.ts";

/**
 * How far back a preview looks.
 *
 * A single day is too thin to judge a topic by: the pool holds roughly 150 articles a
 * day, and a niche interest can legitimately match nothing on a Tuesday. Two weeks is
 * enough that an empty preview means "this topic does not match what we ingest" rather
 * than "nothing happened yesterday", which is the difference between a useful answer and
 * a discouraging one.
 */
const PREVIEW_DAYS = 14;

/** Topics a single account may hold. Each one widens every digest's candidate set. */
const MAX_TOPICS = 20;

/**
 * The similarity below which a match is not a match. Measured, and the number is not
 * intuitive — see the long note in the topics migration. gemini-embedding-001 compresses
 * everything into roughly 0.75-0.88, so this is the line between "the pool covers this"
 * and "the pool covers nothing like this", not a relatedness percentage.
 */
const MATCH_FLOOR = 0.8;

/**
 * Embedding calls a user may make per day.
 *
 * Preview is the expensive action, because it embeds on every keystroke-ending the user
 * commits to. This is the same shape of limit parse-task puts on Gemini parses, counted
 * the same way off ai_events.
 */
const EMBED_LIMIT_PER_DAY = 40;

type TopicRow = {
  id: string;
  label: string;
  enabled: boolean;
  weight: number;
  created_at: string;
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");

  const admin = serviceClient();
  const user = await requireUser(req, admin);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "preview";

  if (action === "preview") return json(await preview(admin, user.id, body));
  if (action === "add") return json(await add(admin, user.id, body));
  if (action === "reembed") return json(await reembed(admin, user.id));

  throw new HttpError(400, `Unknown action "${action}"`);
}

/** The label, validated the same way the table's CHECK constraint validates it. */
function cleanLabel(body: Record<string, unknown>): string {
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label.length < 2) throw new HttpError(400, "A topic needs at least 2 characters");
  if (label.length > 120) throw new HttpError(400, "A topic must be 120 characters or fewer");
  return label;
}

/**
 * Embed one topic label.
 *
 * taskType is pinned to SEMANTIC_SIMILARITY, matching what ingest-news uses for articles.
 * This is not a detail to leave to the default: Gemini's RETRIEVAL_QUERY and
 * RETRIEVAL_DOCUMENT types are deliberately asymmetric, so a label embedded as a query
 * against a pool embedded for similarity lands in a different part of the space and the
 * cosine distances stop meaning anything. The failure mode is not an error — it is
 * plausible-looking matches that are quietly wrong.
 */
async function embedLabel(admin: SupabaseClient, userId: string, label: string) {
  const used = await countAiEvents(admin, userId, "embedding", startOfToday());
  if (used >= EMBED_LIMIT_PER_DAY) {
    throw new HttpError(429, `Daily topic limit reached (${EMBED_LIMIT_PER_DAY}). Try tomorrow.`);
  }

  const [vector] = await embedBatch([label], { taskType: "SEMANTIC_SIMILARITY" });
  await logAiEvent(admin, { userId, kind: "embedding", itemsProcessed: 1 });
  return vector;
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function sinceDate(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * What a label would have matched over the last fortnight, without storing it.
 *
 * This exists because a topic is a guess until you see it hit something. "Kubernetes
 * security" and "k8s CVEs" are the same intent to a person and not quite the same point
 * in embedding space, and the only honest way to tell a reader which one to keep is to
 * show them the articles.
 */
async function preview(admin: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const label = cleanLabel(body);
  const vector = await embedLabel(admin, userId, label);
  return previewFor(admin, vector, label);
}

async function add(admin: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const label = cleanLabel(body);

  const { count, error: countError } = await admin
    .from("topics")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_TOPICS) {
    throw new HttpError(400, `You can follow up to ${MAX_TOPICS} topics. Remove one first.`);
  }

  const vector = await embedLabel(admin, userId, label);

  const { data, error } = await admin
    .from("topics")
    .insert({ user_id: userId, label, embedding: vector })
    .select("id, label, enabled, weight, created_at")
    .single();

  // The unique index is on lower(btrim(label)), so "Coding" and "coding" collide here
  // rather than becoming two rows that each pull the same articles into the digest.
  if (error) {
    if (error.code === "23505") throw new HttpError(409, `You already follow "${label}"`);
    throw error;
  }

  return { topic: data as TopicRow, ...(await previewFor(admin, vector, label)) };
}

/**
 * What a label matches over the last fortnight.
 *
 * Returns everything above the floor *and* the best score below it, because "no matches"
 * and "no matches, and the closest thing we carry is a stock-market story at 0.77" are
 * different messages to a reader. The second one means the pool has no feeds for this
 * interest, which is worth saying out loud rather than leaving them to retype the label
 * in different words forever.
 */
async function previewFor(admin: SupabaseClient, vector: number[], label: string) {
  const { data, error } = await admin.rpc("match_articles", {
    p_query_embedding: vector,
    p_match_count: 12,
    p_since: sinceDate(PREVIEW_DAYS),
    p_categories: null,
    p_min_similarity: 0,
  });
  if (error) throw error;

  const rows = (data ?? []) as {
    title: string;
    source: string;
    category: string;
    similarity: number;
  }[];
  const above = rows.filter((m) => m.similarity >= MATCH_FLOOR);
  const best = rows.length > 0 ? Number(rows[0].similarity.toFixed(4)) : 0;

  return {
    label,
    days: PREVIEW_DAYS,
    covered: above.length > 0,
    best_similarity: best,
    matches: above.slice(0, 8).map((m) => ({
      title: m.title,
      source: m.source,
      category: m.category,
      similarity: Number(m.similarity.toFixed(4)),
    })),
  };
}

/**
 * Re-embed every topic this user holds.
 *
 * Needed exactly once: when the embedding model changes. A vector produced by one model
 * is not comparable with one produced by another, so a model bump without this leaves
 * old topics matching noise while new ones work — the kind of half-broken that is hard
 * to notice from the outside.
 */
async function reembed(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin
    .from("topics")
    .select("id, label")
    .eq("user_id", userId)
    .order("created_at");
  if (error) throw error;

  const rows = (data ?? []) as { id: string; label: string }[];
  if (rows.length === 0) return { reembedded: 0 };

  const used = await countAiEvents(admin, userId, "embedding", startOfToday());
  if (used + rows.length > EMBED_LIMIT_PER_DAY) {
    throw new HttpError(429, "Daily embedding limit would be exceeded. Try tomorrow.");
  }

  const vectors = await embedBatch(
    rows.map((r) => r.label),
    { taskType: "SEMANTIC_SIMILARITY" },
  );
  await logAiEvent(admin, { userId, kind: "embedding", itemsProcessed: rows.length });

  for (const [i, row] of rows.entries()) {
    const { error: updateError } = await admin
      .from("topics")
      .update({ embedding: vectors[i] })
      .eq("id", row.id)
      .eq("user_id", userId);
    if (updateError) throw updateError;
  }

  return { reembedded: rows.length };
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error(err);
    return json({ error: err instanceof Error ? err.message : "topics failed" }, 500);
  }
});
