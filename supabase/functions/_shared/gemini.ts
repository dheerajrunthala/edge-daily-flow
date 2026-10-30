// Gemini API access. Every model name the project uses lives here.
//
// Endpoint: POST /v1beta/models/<model>:generateContent, key in the x-goog-api-key
// header, prompt in `contents`, structured output via generationConfig.responseSchema.

/**
 * Model names, overridable by environment variable.
 *
 * The defaults are "-latest" aliases, which track the current release and so never need
 * bumping — at the cost of the model shifting under us, and of sharing capacity with
 * everyone else pointing at the same alias. That second cost is not theoretical: it lost
 * three days of digests in October 2026.
 *
 * Pinning is therefore worth doing, but it is deliberately *not* hard-coded here. A pinned
 * id that does not exist fails every call with a 404, which is a total and silent outage,
 * and the id cannot be verified from a development environment because the API key lives
 * only in the platform's secret store. So the owner pins with
 * `supabase secrets set GEMINI_PARSE_MODEL=...` after checking the id against
 * ListModels — no redeploy, and a bad value is one secret away from being reverted.
 *
 * Reading env at module load rather than per call is fine: a secret change restarts the
 * isolate anyway.
 */
/**
 * Guarded because this runs at module load, and module load happens under vitest too.
 *
 * Reading `Deno.env` unguarded here made every test file that transitively imports this
 * module fail to collect with "Deno is not defined" — agent-registry.test.ts went from
 * passing to not running at all, and the suite reported 106 passing instead of 118 with no
 * failure to explain the twelve that vanished. A silent drop is worse than a red test.
 *
 * This is the same rule write-tests states from the other direction: a module is testable
 * here only if everything it reaches at load time resolves outside the Edge runtime.
 */
const envModel = (name: string, fallback: string): string => {
  const env = typeof Deno !== "undefined" ? Deno.env.get(name) : undefined;
  return env?.trim() || fallback;
};

/** Parsing and other low-volume, accuracy-sensitive calls. */
export const GEMINI_PARSE_MODEL = envModel("GEMINI_PARSE_MODEL", "gemini-flash-latest");

/** Per-article news summarizing — high volume, so the cheap tier. */
export const GEMINI_BULK_MODEL = envModel("GEMINI_BULK_MODEL", "gemini-flash-lite-latest");

/**
 * Where a call goes when the primary model is out of capacity.
 *
 * "gemini-flash-latest" is an alias onto whatever the current Flash release is, which
 * means we share its capacity with everyone else pointing at the same alias — and it
 * answers 503 "this model is currently experiencing high demand" often enough to have
 * failed real digests on 2026-10-24, -25 and -28. The lite tier is a different pool, and
 * a digest ranked by the cheaper model is enormously better than no digest at all.
 */
export const GEMINI_FALLBACK_MODEL = envModel("GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest");

/** News similarity. news_items.embedding is vector(768), so keep these in step. */
/**
 * Embeddings. Pinned already, and it must stay pinned: a vector from one model is not
 * comparable with one from another, so changing this silently invalidates every stored
 * embedding rather than failing. Changing it means re-embedding the pool and every topic.
 */
export const GEMINI_EMBEDDING_MODEL = envModel("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001");
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

/**
 * Attempts against the primary model, then against the fallback.
 *
 * The old policy was three attempts with 0.5s and 1s of backoff — about two seconds of
 * patience for an upstream that is telling us it is overloaded. That is not a retry
 * policy, it is a formality, and it lost three days of digests. Five attempts backing
 * off 1s/2s/4s/8s spends at most ~15s, which is nothing against the 150s wall clock and
 * is long enough for a capacity spike to pass.
 *
 * The fallback gets two attempts rather than five: if the primary is out of capacity and
 * the fallback is too, the answer is to come back later, not to keep paying.
 */
const MAX_ATTEMPTS = 5;
const FALLBACK_ATTEMPTS = 2;

/**
 * Deadline for a single generateContent call.
 *
 * An unbounded fetch inside a runtime with a 150s wall clock is not a long wait, it is a
 * lost error: the platform kills the isolate with IDLE_TIMEOUT and nothing that was going
 * to be logged ever is, so the failure arrives as silence. plan-day's first real run
 * burned all 150s this way and left no trace of which call hung.
 *
 * 40s is far longer than a Flash completion needs and still leaves room for retries and
 * several tool round trips inside one invocation.
 */
const CALL_TIMEOUT_MS = 25_000;

/**
 * Total time postGenerate may spend on one logical call, across every retry and both
 * models.
 *
 * Needed because the per-call deadline alone does not bound the whole: five attempts at
 * 25s is 125s, which plus the tool round trips overruns the runtime's 150s wall clock and
 * loses the error again. Retrying past this budget cannot help anyone — the caller is
 * already out of time.
 */
const TOTAL_BUDGET_MS = 90_000;

/** Caller's signal, plus our own deadline — whichever trips first wins. */
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the API itself says to wait, if it said.
 *
 * A quota 429 is categorically different from a capacity 503, and it took a production
 * investigation to see it. The free tier caps embed_content at **100 requests per minute**,
 * and batchEmbedContents counts each text as a request rather than each call — so a day's
 * pool of ~150 articles across six simultaneously fanned-out categories exceeds it every
 * morning. That is why 797 of 2,651 pooled articles had no vector.
 *
 * Exponential backoff cannot fix a per-minute quota: 1+2+4+8s is 15 seconds of patience for
 * a window that resets in up to 60. The response says exactly how long to wait — both in
 * `RetryInfo.retryDelay` and in prose ("Please retry in 49.215166941s") — so the only
 * sensible policy is to believe it.
 *
 * Capped, because an unbounded wait inside a 150s runtime is the same lost error as an
 * unbounded fetch.
 */
const MAX_HONOURED_RETRY_MS = 55_000;

function retryAfterMs(body: string): number | null {
  // The structured form Google sends alongside the message.
  const structured = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  const prose = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(body);
  const seconds = Number(structured?.[1] ?? prose?.[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // A second of slack: retrying at the exact boundary loses the race often enough to matter.
  return Math.min(Math.ceil(seconds * 1000) + 1_000, MAX_HONOURED_RETRY_MS);
}

/**
 * POST one generateContent request, with the retry and the three failure modes that
 * arrive as HTTP 200.
 *
 * Extracted so the tool-calling loop below gets the same treatment rather than its own
 * slightly different copy — it runs unattended from cron too, and a "high demand" 503 on
 * turn four of six should not lose the three tool calls already made.
 */
async function postGenerate(
  model: string,
  payload: string,
  signal?: AbortSignal,
  fallbackModel?: string,
): Promise<GeminiEnvelope> {
  const plan: { model: string; attempts: number }[] = [{ model, attempts: MAX_ATTEMPTS }];
  if (fallbackModel && fallbackModel !== model) {
    plan.push({ model: fallbackModel, attempts: FALLBACK_ATTEMPTS });
  }

  let lastStatus = 0;
  let lastBody = "";
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > TOTAL_BUDGET_MS;

  for (const [planIndex, step] of plan.entries()) {
    for (let attempt = 1; attempt <= step.attempts; attempt++) {
      if (outOfTime()) {
        console.warn(`gemini: out of retry budget after ${Date.now() - startedAt}ms`);
        throw new GeminiError(
          `Gemini did not answer within ${TOTAL_BUDGET_MS}ms (last status ${lastStatus || "none"})`,
          lastStatus || 504,
        );
      }
      let res: Response;
      let body: string;
      try {
        res = await fetch(`${API_ROOT}/models/${step.model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
          signal: withDeadline(signal, CALL_TIMEOUT_MS),
          body: payload,
        });
        body = await res.text();
      } catch (err) {
        // A timeout here is worth naming, because the alternative is the platform killing
        // the whole invocation and the logs showing nothing at all.
        const reason = err instanceof Error ? err.name : String(err);
        console.warn(`gemini ${step.model} aborted after ${CALL_TIMEOUT_MS}ms (${reason})`);
        lastStatus = 504;
        lastBody = `request aborted: ${reason}`;
        // Abandon this model rather than retrying it. A request that hangs to the
        // deadline is different information from a 503: the 503 is the endpoint telling
        // us it is busy and will likely be free in a second, while a hang means the
        // request went in and nothing came back. Spending the remaining four attempts —
        // 100s of a 150s wall clock — rediscovering that leaves no budget to try the
        // other model, which is the thing most likely to actually work.
        break;
      }

      if (res.ok) {
        if (planIndex > 0) {
          console.warn(`gemini: answered by fallback model ${step.model}`);
        }
        return readEnvelope(body);
      }

      lastStatus = res.status;
      lastBody = body;

      // Not transient: another attempt and another model will both fail the same way.
      if (!RETRYABLE.has(res.status)) {
        throw new GeminiError(`Gemini ${res.status}: ${body.slice(0, 600)}`, res.status);
      }

      if (attempt < step.attempts) {
        // Prefer the wait the API asked for; otherwise 1s, 2s, 4s, 8s with up to 500ms of
        // jitter so parallel callers — the per-category ingest fan-out, say — do not retry
        // in lockstep and re-create the spike they are backing off from.
        const asked = retryAfterMs(body);
        const backoff = asked ?? 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(
          `gemini ${res.status} on ${step.model}, retrying in ${backoff}ms (attempt ${attempt}/${step.attempts})${asked ? " [as asked]" : ""}`,
        );
        await sleep(backoff);
      }
    }
    if (planIndex < plan.length - 1) {
      console.warn(`gemini: ${step.model} out of capacity after ${step.attempts}, trying fallback`);
    }
  }

  throw new GeminiError(`Gemini ${lastStatus}: ${lastBody.slice(0, 600)}`, lastStatus);
}

/** Parse and check a 200 body. A block or a truncated answer both arrive as HTTP 200. */
function readEnvelope(body: string): GeminiEnvelope {
  let envelope: GeminiEnvelope;
  try {
    envelope = JSON.parse(body) as GeminiEnvelope;
  } catch {
    throw new GeminiError(`Gemini returned non-JSON: ${body.slice(0, 300)}`);
  }

  const blocked = envelope.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(`Gemini blocked the prompt: ${blocked}`);

  const finish = envelope.candidates?.[0]?.finishReason;
  // MALFORMED_FUNCTION_CALL is its own finish reason and means the model tried to call a
  // tool and produced arguments that did not parse. Naming it is worth the line: the
  // generic "stopped early" sends you looking at length limits instead of the schema.
  if (finish && finish !== "STOP") {
    throw new GeminiError(`Gemini stopped early: ${finish}`);
  }

  return envelope;
}

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
  /** Model to try when the primary is out of capacity. Pass null to disable. */
  fallbackModel?: string | null;
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

  const envelope = await postGenerate(
    model,
    payload,
    opts.signal,
    opts.fallbackModel === null ? undefined : (opts.fallbackModel ?? GEMINI_FALLBACK_MODEL),
  );
  const candidate = envelope.candidates?.[0];

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

type GeminiPart = {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
};

type GeminiEnvelope = {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
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
      signal: withDeadline(opts.signal, CALL_TIMEOUT_MS),
      body: payload,
    });
    body = await res.text();
    if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    // This is the path that actually hits the free-tier quota, so the API's own retryDelay
    // matters more here than anywhere else: the limit is 100 embed requests per minute and
    // batchEmbedContents counts each *text*, not each call. An article pooled without a
    // vector stays vectorless forever — ignoreDuplicates on a unique url means it is never
    // reconsidered — so losing a batch here is permanent, not transient.
    const asked = retryAfterMs(body);
    const backoff = asked ?? 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
    console.warn(
      `embed ${res.status}, retrying in ${backoff}ms (attempt ${attempt}/${MAX_ATTEMPTS})${asked ? " [as asked]" : ""}`,
    );
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

// ----------------------------------------------------------------- tool calling

/**
 * One tool, as Gemini needs to be told about it.
 *
 * `parameters` uses the same OpenAPI subset `generateJson`'s schema does — type, format,
 * description, nullable, enum, items, properties, required. `additionalProperties` is
 * rejected with a 400, which is the usual way a hand-written schema fails here.
 */
export type ToolDeclaration = {
  name: string;
  description: string;
  /**
   * Omitted entirely for a function that takes no arguments.
   *
   * Not a style choice. Declaring `{ type: "object", properties: {} }` for a
   * no-argument tool makes generateContent hang — not 400, not 503: the request simply
   * never returns, and the platform eventually kills the invocation with IDLE_TIMEOUT.
   * That cost two debugging rounds on plan-day, whose allowlist includes the one tool
   * with no parameters. sanitizeDeclarations() below strips an empty schema defensively
   * so this cannot come back through a caller that did not read this comment.
   */
  parameters?: Record<string, unknown>;
};

/** What the model actually did, in order. The caller logs this and shows it to the user. */
export type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  durationMs: number;
};

/**
 * The ceiling on round trips with the model.
 *
 * Six is enough for "look up the user's context, search the news, read a task, answer"
 * with room to recover from one bad call, and small enough that a model which has
 * decided to call `list_tasks` forever costs six calls rather than a budget. The loop
 * ends by asking for a final answer with the tools removed, so hitting the cap still
 * produces a reply instead of an error.
 */
const MAX_TOOL_TURNS = 6;

/**
 * Run a tool-calling conversation to a final text answer.
 *
 * The shape is deliberately the same as generateJson's — system instruction, retries,
 * usage accounting — with one addition: `execute` is called for every functionCall the
 * model emits, and whatever it returns (or throws) goes back as a functionResponse.
 *
 * A thrown tool error is reported to the model rather than propagated. That is the whole
 * reason the loop exists: "no task with that id in this account" is information the model
 * can act on by searching instead, and turning it into a 500 would make every typo fatal.
 * Errors still land in the returned trace, so the caller can see what went wrong even
 * when the user got a graceful answer.
 */
export async function generateWithTools(opts: {
  model?: string;
  system: string;
  messages: { role: "user" | "model"; text: string }[];
  tools: ToolDeclaration[];
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxTurns?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Model to try when the primary is out of capacity. Pass null to disable. */
  fallbackModel?: string | null;
}): Promise<{ text: string; usage: Usage; calls: ToolCallRecord[]; turns: number }> {
  const model = opts.model ?? GEMINI_PARSE_MODEL;
  const maxTurns = Math.max(1, Math.min(opts.maxTurns ?? MAX_TOOL_TURNS, MAX_TOOL_TURNS));

  const tools = sanitizeDeclarations(opts.tools);

  const contents: { role: string; parts: unknown[] }[] = opts.messages.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const calls: ToolCallRecord[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  const addUsage = (u: Usage) => {
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;
    // The last turn drops the tools entirely. Leaving them in and ignoring the response
    // would waste the call; removing them is what forces a prose answer out of a model
    // that would otherwise keep reaching for one more lookup.
    const lastTurn = turn === maxTurns - 1;

    const envelope = await postGenerate(
      model,
      JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents,
        ...(lastTurn
          ? {}
          : {
              tools: [{ functionDeclarations: opts.tools }],
              toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            }),
        generationConfig: { temperature: opts.temperature ?? 0.2 },
      }),
      opts.signal,
      opts.fallbackModel === null ? undefined : (opts.fallbackModel ?? GEMINI_FALLBACK_MODEL),
    );
    addUsage(readUsage(envelope));

    const parts = envelope.candidates?.[0]?.content?.parts ?? [];
    const wanted = parts.filter((p) => p.functionCall?.name);
    console.log(
      `agent turn ${turns}/${maxTurns}: ${wanted.length ? wanted.map((p) => p.functionCall?.name).join(", ") : "final answer"}`,
    );

    if (wanted.length === 0) {
      const text = parts
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      if (!text) throw new GeminiError("Gemini returned neither a tool call nor any text");
      return { text, usage: { inputTokens, outputTokens }, calls, turns };
    }

    // Echo the model's turn back verbatim. Gemini rejects a functionResponse that is not
    // preceded by the functionCall it answers, so this is not optional bookkeeping.
    contents.push({ role: "model", parts });

    // Several calls can arrive in one turn. Run them in order rather than in parallel:
    // they share one database and one user, and "complete this task, then list what is
    // left" has to see its own write.
    const responses: unknown[] = [];
    for (const part of wanted) {
      const name = part.functionCall?.name ?? "";
      const args = (part.functionCall?.args ?? {}) as Record<string, unknown>;
      const started = Date.now();
      try {
        const result = await opts.execute(name, args);
        calls.push({ name, args, ok: true, durationMs: Date.now() - started });
        responses.push({ functionResponse: { name, response: { result } } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        calls.push({ name, args, ok: false, error: message, durationMs: Date.now() - started });
        responses.push({ functionResponse: { name, response: { error: message } } });
      }
    }

    contents.push({ role: "user", parts: responses });
  }

  throw new GeminiError("Tool loop ended without a final answer");
}

/**
 * Drop a `parameters` schema that declares no properties.
 *
 * generateContent hangs on `{ type: "object", properties: {} }` rather than rejecting it,
 * so this is the difference between a working tool loop and an invocation killed by the
 * platform with nothing in the logs. Done here rather than only at the declaration site
 * because the symptom is so far removed from the cause.
 */
function sanitizeDeclarations(tools: ToolDeclaration[]): ToolDeclaration[] {
  return tools.map((t) => {
    const props = (t.parameters?.properties ?? {}) as Record<string, unknown>;
    if (!t.parameters || Object.keys(props).length === 0) {
      const { parameters: _drop, ...rest } = t;
      return rest;
    }
    return t;
  });
}
