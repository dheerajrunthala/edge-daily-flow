// Gemini API access. Every model name the project uses lives here.
//
// The API is the /v1beta/interactions endpoint: a flat { model, input, response_format }
// body that answers with { output_text, steps, usage }. Older Gemini code used
// /models/<id>:generateContent with contents/generationConfig — that is not this shape.

/** Parsing and other low-volume, accuracy-sensitive calls. */
export const GEMINI_PARSE_MODEL = "gemini-3.8-flash";

/** Per-article news summarizing — high volume, so the cheap tier. */
export const GEMINI_BULK_MODEL = "gemini-3.5-flash-lite";

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

/**
 * One structured-output call. `schema` is JSON Schema; the model is constrained to it,
 * so the response parses without the usual fenced-code-block cleanup.
 */
export async function generateJson<T>(opts: {
  model?: string;
  system: string;
  input: string;
  schema: Record<string, unknown>;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<{ data: T; usage: Usage }> {
  const res = await fetch(`${API_ROOT}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
    signal: opts.signal ?? null,
    body: JSON.stringify({
      model: opts.model ?? GEMINI_PARSE_MODEL,
      system_instruction: opts.system,
      input: opts.input,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: opts.schema,
      },
      generation_config: { temperature: opts.temperature ?? 0 },
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new GeminiError(`Gemini ${res.status}: ${body.slice(0, 600)}`, res.status);
  }

  let envelope: GeminiEnvelope;
  try {
    envelope = JSON.parse(body) as GeminiEnvelope;
  } catch {
    throw new GeminiError(`Gemini returned non-JSON: ${body.slice(0, 300)}`);
  }

  const text = outputText(envelope);
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
  output_text?: string;
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: Record<string, number | undefined>;
};

/** Prefer output_text; fall back to walking steps so a shape change degrades rather than breaks. */
function outputText(envelope: GeminiEnvelope): string {
  if (typeof envelope.output_text === "string" && envelope.output_text.trim()) {
    return envelope.output_text;
  }
  const parts: string[] = [];
  for (const step of envelope.steps ?? []) {
    for (const part of step.content ?? []) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

function readUsage(envelope: GeminiEnvelope): Usage {
  const u = envelope.usage ?? {};
  const num = (v: number | undefined) => (typeof v === "number" ? v : null);
  return { inputTokens: num(u["total_input_tokens"]), outputTokens: num(u["total_output_tokens"]) };
}
