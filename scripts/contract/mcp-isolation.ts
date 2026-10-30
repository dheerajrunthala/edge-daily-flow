// Tier 4 — can account B touch account A's rows through the MCP server?
//
//   DAILY_EDGE_TOKEN_A=de_… DAILY_EDGE_TOKEN_B=de_… \
//     node --experimental-strip-types scripts/contract/mcp-isolation.ts
//
//   optional: DAILY_EDGE_TOKEN_B_REVOKED=de_…   (a revoked token from account B)
//             --rate-limit                      (see the warning on that block)
//
// ─────────────────────────────────────────────────────────────────────────────────────
// Why this is the most important script in the repo
//
// Every MCP tool runs with the SERVICE ROLE, and the service role bypasses RLS entirely.
// So none of the database's guarantees apply here. The only thing between two accounts is
// one clause — `.eq("user_id", ctx.userId)` inside mine()/myRow() in
// _shared/agent-tools.ts. A tool body that forgets it is a cross-account data leak that
// no type checker, no RLS policy and no unit test can see.
//
// It has been verified by hand, in a session transcript nobody can re-run. This is that
// check, committed.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// Negative evidence is the point
//
// Asserting that token B got an error is HALF a test. An implementation that refuses the
// read and performs the write anyway passes it. So every attack is bracketed: A's rows are
// snapshotted through token A, attacked through token B, then re-read through token A and
// compared byte for byte. The comparison, not the error message, is the assertion.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// Credentials
//
// Two accounts and two `de_…` tokens, supplied as environment variables. They are NOT in
// this repo and must not be: an API token is a real credential (rule 8), and the plaintext
// of one exists in exactly one HTTP response and nowhere after — api_tokens stores only a
// sha256. Mint them in Settings → Integrations, one per account.
//
// This script does not create accounts or tokens, by instruction. It exits 2 — distinct
// from a test failure — when the tokens are absent, so "not run" can never be mistaken for
// "passed".

const SUPABASE_URL = (
  process.env.SUPABASE_URL ?? "https://uhhphhkpxxofspbfynmo.supabase.co"
).replace(/\/$/, "");
const MCP_URL = `${SUPABASE_URL}/functions/v1/mcp`;

const TOKEN_A = process.env.DAILY_EDGE_TOKEN_A;
const TOKEN_B = process.env.DAILY_EDGE_TOKEN_B;
const TOKEN_B_REVOKED = process.env.DAILY_EDGE_TOKEN_B_REVOKED;
const RUN_RATE_LIMIT = process.argv.includes("--rate-limit");

// The message _shared/api-tokens.ts gives an unknown token. An unknown token and a revoked
// one deliberately produce the SAME message: which one it was is not something an
// unauthenticated caller needs to learn.
const REJECTION = "Unknown or revoked API token. Create a new one in Settings.";
// The message myTask()/save_news_item give for an id in another account.
const NOT_IN_ACCOUNT = "in this account";
const RATE_LIMIT_PER_HOUR = 120;

if (!TOKEN_A || !TOKEN_B) {
  console.error(
    [
      "mcp-isolation.ts was not run: CREDENTIALS REQUIRED.",
      "",
      "  DAILY_EDGE_TOKEN_A  a de_… token for account A (the account whose rows are the target)",
      "  DAILY_EDGE_TOKEN_B  a de_… token for a DIFFERENT account B (the attacker)",
      "",
      "Mint each in Settings → Integrations while signed in as that account. They are",
      "deliberately not in the repo: api_tokens stores only a sha256, and the plaintext",
      "exists in exactly one HTTP response.",
      "",
      "Exiting 2 (not run), not 1 (failed) — an un-run check must never read as a pass.",
    ].join("\n"),
  );
  process.exit(2);
}

// ───────────────────────────────────────────────────────────────── the protocol layer

let rpcId = 0;

type RpcOutcome = {
  status: number;
  /** A JSON-RPC envelope-level error, e.g. the 401 from requireApiToken. */
  rpcError?: { code: number; message: string };
  /** A tool-level failure: the handler threw and the SDK turned it into isError content. */
  isError?: boolean;
  /** The tool's text content, parsed from JSON when it is JSON. */
  text?: string;
  json?: unknown;
};

/**
 * One JSON-RPC call against the server.
 *
 * The server is stateless on purpose (`sessionIdGenerator: undefined`, a fresh McpServer
 * per request) because Edge invocations are ephemeral and a later request may land in a
 * different isolate. So there is no handshake to keep and no session id to send — each
 * call carries its own bearer token, which is all the identity a tool call needs.
 *
 * `Accept` must list both types: the Streamable HTTP spec requires it, and the transport
 * rejects a request that offers only one. The server sets enableJsonResponse, so in
 * practice the body comes back as JSON — but an SSE frame is parsed too rather than
 * assumed away.
 */
async function rpc(token: string, method: string, params?: unknown): Promise<RpcOutcome> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? {} }),
    signal: AbortSignal.timeout(60_000),
  });

  const raw = await res.text();
  const payload = parseBody(raw);
  if (payload === undefined) {
    return { status: res.status, text: raw.slice(0, 400) };
  }

  const env = payload as {
    error?: { code: number; message: string };
    result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  };
  if (env.error) return { status: res.status, rpcError: env.error };

  const text = env.result?.content?.find((c) => c.type === "text")?.text;
  let json: unknown;
  if (text !== undefined) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, isError: env.result?.isError === true, text, json };
}

/** JSON, or the first `data:` frame of an SSE stream. */
function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to SSE
  }
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  rpc(token, "tools/call", { name, arguments: args });

// ─────────────────────────────────────────────────────────────────────── assertions

let failures = 0;

function check(label: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
  return ok;
}

/** An ownership refusal, and specifically that one — not a validation or schema error. */
function checkRefused(label: string, r: RpcOutcome): boolean {
  const body = r.text ?? r.rpcError?.message ?? "";
  if (r.rpcError) {
    return check(label, false, `rejected at the envelope (${r.rpcError.code}): ${body}`);
  }
  if (!r.isError) {
    return check(
      label,
      false,
      `SUCCEEDED — account B reached account A's row. LEAK. ${(r.text ?? "").slice(0, 300)}`,
    );
  }
  return check(
    label,
    body.includes(NOT_IN_ACCOUNT),
    `errored, but not with the ownership refusal: ${body.slice(0, 300)}`,
  );
}

// ───────────────────────────────────────────────────────────────────────── the run

console.log(`mcp-isolation against ${MCP_URL}\n`);

// 1 ── both tokens resolve, to DIFFERENT accounts. Without this the whole script is
//      vacuous: two tokens for the same account would "pass" every assertion below.
console.log("1. both tokens resolve to different accounts");

const ctxA = await callTool(TOKEN_A, "get_context", {});
const ctxB = await callTool(TOKEN_B, "get_context", {});
check(
  "token A authenticates",
  !ctxA.rpcError && !ctxA.isError,
  ctxA.rpcError?.message ?? ctxA.text,
);
check(
  "token B authenticates",
  !ctxB.rpcError && !ctxB.isError,
  ctxB.rpcError?.message ?? ctxB.text,
);
if (failures > 0) {
  console.error("\nCannot continue: a token did not authenticate.");
  process.exit(1);
}

const nameA = JSON.stringify(ctxA.json);
const nameB = JSON.stringify(ctxB.json);
if (
  !check(
    "the two tokens are different accounts",
    nameA !== nameB,
    "get_context returned identical context for both tokens — they look like the same account, " +
      "which would make every assertion below pass vacuously",
  )
) {
  process.exit(1);
}

// 2 ── find ids belonging to A.
console.log("\n2. collect account A's ids");

const tasksA = await callTool(TOKEN_A, "list_tasks", { filter: "all" });
const newsA = await callTool(TOKEN_A, "get_news", {});

const taskIds = collectIds(tasksA.json);
const newsIds = collectIds(newsA.json);

/** Every uuid-shaped `id` anywhere in a tool's JSON result. */
function collectIds(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, found);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "id" && typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)) found.push(v);
      else collectIds(v, found);
    }
  }
  return found;
}

check(
  `account A has at least one task (${taskIds.length} found)`,
  taskIds.length > 0,
  "with no task of A's to attack, the task assertions cannot fail and so must not pass",
);
check(
  `account A has at least one news item (${newsIds.length} found)`,
  newsIds.length > 0,
  "with no news item of A's to attack, save_news_item cannot be tested",
);
if (failures > 0) process.exit(1);

const taskId = taskIds[0];
const newsId = newsIds[0];

// 3 ── snapshot A's rows, through A's own token.
console.log("\n3. snapshot account A's rows");

const snapTask = await callTool(TOKEN_A, "get_task", { id: taskId });
const snapNews = await callTool(TOKEN_A, "get_news", {});
const beforeTask = JSON.stringify(snapTask.json);
const beforeNews = JSON.stringify(snapNews.json);
check("snapshot of the target task taken", snapTask.json !== undefined);
check("snapshot of A's news list taken", snapNews.json !== undefined);

// 4 ── attack every mutation with token B.
//
// Every one of these is the real production call with a real id — the only thing that
// should stop it is the ownership guard. delete_task is included deliberately: it is the
// irreversible one, and the one whose failure would be discovered last.
console.log("\n4. attack A's ids with token B");

const future = new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+00:00");

checkRefused(
  "get_task(A's id)        refused",
  await callTool(TOKEN_B, "get_task", { id: taskId }),
);
checkRefused(
  "update_task(A's id)     refused",
  await callTool(TOKEN_B, "update_task", { id: taskId, title: "isolation probe — must not land" }),
);
checkRefused(
  "complete_task(A's id)   refused",
  await callTool(TOKEN_B, "complete_task", { id: taskId }),
);
checkRefused(
  "snooze_task(A's id)     refused",
  await callTool(TOKEN_B, "snooze_task", { id: taskId, until: future }),
);
checkRefused(
  "delete_task(A's id)     refused",
  await callTool(TOKEN_B, "delete_task", { id: taskId }),
);
checkRefused(
  "save_news_item(A's id)  refused",
  await callTool(TOKEN_B, "save_news_item", { id: newsId, saved: true }),
);

// 5 ── B's own reads must not contain A's ids either. A refusal on a known id says
//      nothing about what a plain list returns.
console.log("\n5. account B's own reads leak nothing of A's");

const listB = collectIds((await callTool(TOKEN_B, "list_tasks", { filter: "all" })).json);
const newsB = collectIds((await callTool(TOKEN_B, "get_news", {})).json);
const aTasks = new Set(taskIds);
const aNews = new Set(newsIds);
check(
  "list_tasks for B contains none of A's task ids",
  !listB.some((id) => aTasks.has(id)),
  `leaked: ${listB.filter((id) => aTasks.has(id)).join(", ")}`,
);
check(
  "get_news for B contains none of A's item ids",
  !newsB.some((id) => aNews.has(id)),
  `leaked: ${newsB.filter((id) => aNews.has(id)).join(", ")}`,
);

// 6 ── THE assertion: nothing was written. Six mutations were attempted; if any of them
//      refused the read but performed the write, this is where it shows.
console.log("\n6. negative evidence — re-read A's rows and compare");

const afterTask = JSON.stringify((await callTool(TOKEN_A, "get_task", { id: taskId })).json);
const afterNews = JSON.stringify((await callTool(TOKEN_A, "get_news", {})).json);

check(
  "A's task is byte-identical after six attacks",
  afterTask === beforeTask,
  `before: ${beforeTask?.slice(0, 200)}\n          after:  ${afterTask?.slice(0, 200)}`,
);
check(
  "A's news list is byte-identical after six attacks",
  afterNews === beforeNews,
  "save_news_item may have flipped is_saved on a row belonging to A",
);
// delete_task is the one attack whose success would make the re-read above fail to find
// anything at all, so it is asserted explicitly rather than inferred.
check(
  "A's task still exists",
  afterTask !== undefined && afterTask !== "undefined",
  "get_task no longer resolves — delete_task may have succeeded across accounts",
);

// 7 ── an unknown token and a revoked one are indistinguishable.
console.log("\n7. unknown and revoked tokens answer identically");

const unknown = await rpc("de_mcp_isolation_unknown_token", "tools/call", {
  name: "get_context",
  arguments: {},
});
check("an unknown token is rejected with 401", unknown.status === 401, `got ${unknown.status}`);
check(
  "…with the documented message",
  unknown.rpcError?.message === REJECTION,
  `got: ${unknown.rpcError?.message}`,
);

if (TOKEN_B_REVOKED) {
  const revoked = await rpc(TOKEN_B_REVOKED, "tools/call", { name: "get_context", arguments: {} });
  check(
    "a revoked token gets the same status",
    revoked.status === unknown.status,
    `revoked ${revoked.status} vs unknown ${unknown.status}`,
  );
  check(
    "a revoked token gets the same message",
    revoked.rpcError?.message === unknown.rpcError?.message,
    `revoked "${revoked.rpcError?.message}" vs unknown "${unknown.rpcError?.message}" — ` +
      "a different message tells an unauthenticated caller which of the two it was",
  );
} else {
  console.log(
    "  skip  revoked-token comparison — set DAILY_EDGE_TOKEN_B_REVOKED to a revoked de_… token.",
  );
  console.log(
    "        Reported as a skip, not folded into the pass count. The unknown-token half above ran.",
  );
}

// 8 ── the per-token rate limit.
//
// OPT-IN, and last. Running it spends account B's whole hourly budget and writes
// RATE_LIMIT_PER_HOUR rows to mcp_tool_calls — which is what the limit counts, so for the
// next hour every assertion above would get a rate-limit error instead of an ownership
// refusal. Default off so the rest of this script stays re-runnable.
if (RUN_RATE_LIMIT) {
  console.log(`\n8. the ${RATE_LIMIT_PER_HOUR}/hour per-token rate limit`);
  let limited: RpcOutcome | undefined;
  let calls = 0;
  for (let i = 0; i < RATE_LIMIT_PER_HOUR + 5; i++) {
    const r = await callTool(TOKEN_B, "get_context", {});
    calls++;
    const body = r.text ?? r.rpcError?.message ?? "";
    if (body.includes("Rate limit reached")) {
      limited = r;
      break;
    }
  }
  check(
    "the rate limit is enforced",
    limited !== undefined,
    `made ${calls} calls without being limited`,
  );
  if (limited) {
    const body = limited.text ?? limited.rpcError?.message ?? "";
    check(
      `…the message names ${RATE_LIMIT_PER_HOUR}/hour`,
      body.includes(`${RATE_LIMIT_PER_HOUR} Daily Edge tool calls per hour`),
      body.slice(0, 200),
    );
    // Note the shape: checkRateLimit() is called INSIDE the registered tool wrapper, after
    // auth, so the SDK turns its HttpError into a JSON-RPC tool error on an HTTP 200 — not
    // an HTTP 429. The 429 → code -32000 mapping in mcp/index.ts' rpcError() only applies
    // to failures raised in handle(), which is auth. Asserted as it behaves, not as the
    // plan guessed.
    check(
      "…surfacing as a tool error, which is where the check lives",
      limited.isError === true || limited.status === 429,
      `status ${limited.status}, isError ${limited.isError}`,
    );
    if (limited.status === 429) {
      check(
        "…and an HTTP 429 carries JSON-RPC code -32000",
        limited.rpcError?.code === -32000,
        `code ${limited.rpcError?.code}`,
      );
    }
    check(
      `…after about ${RATE_LIMIT_PER_HOUR} calls, not immediately`,
      calls > 1,
      `limited on call ${calls}; token B may already have been near its limit`,
    );
  }
} else {
  console.log(
    `\n8. skip  the ${RATE_LIMIT_PER_HOUR}/hour rate limit — pass --rate-limit to run it.`,
  );
  console.log("        It spends account B's whole hourly budget and writes 120 mcp_tool_calls");
  console.log("        rows, which would make assertions 1–7 fail with 'Rate limit reached'");
  console.log("        instead of an ownership refusal for the following hour.");
}

console.log(
  failures === 0 ? "\nPASS — no assertion failed." : `\nFAIL — ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
