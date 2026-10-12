// Gemini API access. Every model name the project uses lives here.
//
// Endpoint: POST /v1beta/models/<model>:generateContent, key in the x-goog-api-key
// header, prompt in `contents`, structured output via generationConfig.responseSchema.

/**
 * Parsing and other low-volume, accuracy-sensitive calls.
 * The "-latest" alias tracks the current Flash release, so this does not need bumping
 * every time Google ships one — at the cost of the model shifting under us over time.
 */
export const GEMINI_PARSE_MODEL = "gemini-flash-latest";

/** Per-article news summarizing — high volume, so the cheap tier. */
export const GEMINI_BULK_MODEL = "gemini-flash-lite-latest";

/** News similarity. news_items.embedding is vector(768), so keep these in step. */
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export type Usage = { inputTokens: number | null; outputTokens: number | null };

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

function apiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new GeminiError("GEMINI_API_KEY is not set on this project");
  return key;
}

/** Transient upstream conditions: capacity (503), quota bursts (429), and 5xx blips. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One structured-output call. `schema` must use the subset generateContent accepts:
 * type, format, description, nullable, enum, items, properties, required,
 * propertyOrdering, minItems/maxItems. `additionalProperties` is rejected with a 400.
 *
 * Retries retryable statuses with exponential backoff and jitter. "high demand" 503s from
 * the shared Flash capacity are common enough that one attempt is not good enough, and the
 * news pipeline will call this unattended from cron.
 */
export async function generateJson<T>(opts: {
  model?: string;
  system: string;
  input: string;
  schema: Record<string, unknown>;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<{ data: T; usage: Usage }> {
  const model = opts.model ?? GEMINI_PARSE_MODEL;
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: [{ text: opts.input }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0,
      responseMimeType: "application/json",
      responseSchema: opts.schema,
    },
  });

  let res!: Response;
  let body = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(`${API_ROOT}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
      signal: opts.signal ?? null,
      body: payload,
    });
    body = await res.text();
    if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    // 0.5s, then 1s, each with up to 250ms of jitter so parallel callers don't sync up.
    const backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    console.warn(`gemini ${res.status}, retrying in ${backoff}ms (attempt ${attempt})`);
    await sleep(backoff);
  }

  if (!res.ok) {
    throw new GeminiError(`Gemini ${res.status}: ${body.slice(0, 600)}`, res.status);
  }

  let envelope: GeminiEnvelope;
  try {
    envelope = JSON.parse(body) as GeminiEnvelope;
  } catch {
    throw new GeminiError(`Gemini returned non-JSON: ${body.slice(0, 300)}`);
  }

  // A safety block or a truncated answer both arrive as HTTP 200, so check explicitly
  // rather than letting JSON.parse fail on a half-written object.
  const blocked = envelope.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(`Gemini blocked the prompt: ${blocked}`);

  const candidate = envelope.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && finish !== "STOP") {
    throw new GeminiError(`Gemini stopped early: ${finish}`);
  }

  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new GeminiError("Gemini returned no output text");

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`Gemini output was not valid JSON: ${text.slice(0, 300)}`);
  }

  return { data, usage: readUsage(envelope) };
}

type GeminiEnvelope = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

function readUsage(envelope: GeminiEnvelope): Usage {
  const u = envelope.usageMetadata ?? {};
  const num = (v: number | undefined) => (typeof v === "number" ? v : null);
  return { inputTokens: num(u.promptTokenCount), outputTokens: num(u.candidatesTokenCount) };
}

/**
 * Embed many texts in one request. `batchEmbedContents` takes up to 100 sub-requests,
 * and the whole point of using it is that the news pipeline embeds a few hundred
 * articles a day — one HTTP call per 50 instead of one per article.
 *
 * outputDimensionality must stay at EMBEDDING_DIMENSIONS: articles.embedding and
 * news_items.embedding are both vector(768).
 *
 * Returns one vector per input, in input order. Throws if the API returns a different
 * count, since a silent misalignment would attach the wrong vector to an article.
 */
export async function embedBatch(
  texts: string[],
  opts: { taskType?: "SEMANTIC_SIMILARITY" | "RETRIEVAL_DOCUMENT"; signal?: AbortSignal } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > MAX_EMBED_BATCH) {
    throw new GeminiError(`embedBatch got ${texts.length} texts, max is ${MAX_EMBED_BATCH}`);
  }

  const model = `models/${GEMINI_EMBEDDING_MODEL}`;
  const payload = JSON.stringify({
    requests: texts.map((text) => ({
      model,
      content: { parts: [{ text: text.slice(0, EMBED_MAX_CHARS) }] },
      taskType: opts.taskType ?? "SEMANTIC_SIMILARITY",
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })),
  });

  let res!: Response;
  let body = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(`${API_ROOT}/${model}:batchEmbedContents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
      signal: opts.signal ?? null,
      body: payload,
    });
    body = await res.text();
    if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    const backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    console.warn(`embed ${res.status}, retrying in ${backoff}ms (attempt ${attempt})`);
    await sleep(backoff);
  }
  if (!res.ok) {
    throw new GeminiError(`Gemini embed ${res.status}: ${body.slice(0, 600)}`, res.status);
  }

  let parsed: { embeddings?: { values?: number[] }[] };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new GeminiError(`Gemini embed returned non-JSON: ${body.slice(0, 300)}`);
  }

  const vectors = (parsed.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== texts.length) {
    throw new GeminiError(`Gemini embed returned ${vectors.length} vectors for ${texts.length}`);
  }
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIMENSIONS) {
      throw new GeminiError(`Gemini embed returned a ${v.length}-dim vector`);
    }
  }
  return vectors;
}

/** API limit is 100 sub-requests; 50 keeps the payload comfortably inside it. */
export const MAX_EMBED_BATCH = 50;

/** Plenty for a headline plus a lead paragraph, and keeps the request small. */
const EMBED_MAX_CHARS = 2000;
