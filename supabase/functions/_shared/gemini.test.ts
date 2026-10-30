// gemini.ts, for the two things in it that are pure — and for the fact that it imports at all.
//
// The import test is not filler. Model names are read from the environment at module load,
// and reading `Deno.env` unguarded there made every test file that transitively imports this
// module fail to *collect*: the suite went from 118 passing to 106 passing with no failure
// naming the twelve that disappeared. A test that merely imports the module is the cheapest
// possible guard against that, and the symptom it catches is otherwise invisible.

import { describe, expect, it } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  GEMINI_BULK_MODEL,
  GEMINI_EMBEDDING_MODEL,
  GEMINI_FALLBACK_MODEL,
  GEMINI_PARSE_MODEL,
  MAX_EMBED_BATCH,
} from "./gemini.ts";

describe("module load outside the Edge runtime", () => {
  it("resolves every model name without a Deno global", () => {
    for (const name of [
      GEMINI_PARSE_MODEL,
      GEMINI_BULK_MODEL,
      GEMINI_FALLBACK_MODEL,
      GEMINI_EMBEDDING_MODEL,
    ]) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("keeps the fallback on a different model from the primary", () => {
    // The whole point of the fallback is a different capacity pool. If a future edit points
    // both at the same alias, the retry policy silently becomes seven attempts at one
    // endpoint instead of five plus two elsewhere.
    expect(GEMINI_FALLBACK_MODEL).not.toBe(GEMINI_PARSE_MODEL);
  });

  // news_items.embedding, articles.embedding and topics.embedding are all vector(768).
  // Changing this without a migration would make every insert fail on dimension mismatch.
  it("pins the embedding dimensions the schema expects", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768);
  });

  // The API accepts 100 sub-requests; 50 keeps the payload comfortably inside it.
  it("keeps the embed batch inside the API's sub-request ceiling", () => {
    expect(MAX_EMBED_BATCH).toBeGreaterThan(0);
    expect(MAX_EMBED_BATCH).toBeLessThanOrEqual(100);
  });
});
