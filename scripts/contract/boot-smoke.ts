// Tier 4 — does every Edge Function's isolate actually boot?
//
//   npm run test:contract
//
// A missing export is a BOOT FAILURE here, not a type error. The isolate refuses to
// start, pg_net records BOOT_ERROR, and the function logs are empty — so it looks exactly
// like a function that was never called. That class of bug has bitten this project twice,
// and `npm run build` cannot see it: the Deno bundle is assembled on deploy, from
// specifiers (`jsr:`, `npm:`, `../_shared/*.ts`) that the Vite build never resolves.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// Why this probes over HTTP with a DELIBERATELY WRONG credential
//
// Two things had to be got right, and the obvious approach gets both wrong.
//
// 1. A bare 401 does NOT prove the isolate booted. Measured against production:
//
//      POST /parse-task  (no Authorization)
//        → 401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}
//
//    That is the PLATFORM GATEWAY answering. verify_jwt = true means the isolate is never
//    started, so the response is identical whether the bundle is healthy or broken. The
//    same call carrying the publishable anon key gets past the gate and reaches the
//    handler, which answers in its own words:
//
//      POST /parse-task  (Authorization: Bearer <anon key>)
//        → 401 {"error":"Invalid or expired token"}      ← requireUser(), i.e. our code
//
//    So each probe asserts on a HANDLER-AUTHORED response, not on a status code. That is
//    the only evidence that the bundle loaded and the handler ran.
//
// 2. The cron functions must not be invoked for real. docs/plans/P1-codify-tests.md
//    suggested `invoke_edge_function` + net._http_response for them, because that is the
//    production path. It is — and it would also run the jobs: ingest-news would spend
//    Gemini quota and build-digests would spend one call per user, on every smoke run. A
//    wrong `x-cron-secret` boots the identical bundle through the identical import graph
//    and stops at the handler's first line, having written nothing. Boot is what this
//    tests; the secret check is the cheapest possible proof of reaching it.
//
// The credentials below are all intentionally invalid. Nothing in this file is a secret,
// and nothing in this file writes.

const SUPABASE_URL = (
  process.env.SUPABASE_URL ?? "https://uhhphhkpxxofspbfynmo.supabase.co"
).replace(/\/$/, "");
// The publishable (anon) key. Public by design — it ships inside the browser bundle. Used
// here only to get past the platform's JWT gate so the handler can reject it itself.
const ANON_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoaHBoaGtweHhvZnNwYmZ5bm1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NjUxNTgsImV4cCI6MjEwNzM0MTE1OH0.H0Drjiaq6ldhsUmIIo2OiGFFddM1WIXneZYpyr-JvBQ";

const WRONG_CRON = "boot-smoke-intentionally-wrong";

type Probe = {
  fn: string;
  /** How the handler is reached past the platform gate, and why that is what it takes. */
  gate: string;
  headers: Record<string, string>;
  /** A fragment only this function's own handler code can produce. */
  expect: string;
};

/** All twelve functions under supabase/functions/, excluding _shared. */
const PROBES: Probe[] = [
  // verify_jwt = true. The anon key satisfies the gateway; requireUser() then rejects it.
  {
    fn: "parse-task",
    gate: "anon JWT → requireUser()",
    headers: { authorization: `Bearer ${ANON_KEY}` },
    expect: "Invalid or expired token",
  },
  {
    fn: "topics",
    gate: "anon JWT → requireUser()",
    headers: { authorization: `Bearer ${ANON_KEY}` },
    expect: "Invalid or expired token",
  },
  {
    fn: "agent",
    gate: "anon JWT → requireUser()",
    headers: { authorization: `Bearer ${ANON_KEY}` },
    expect: "Invalid or expired token",
  },

  // verify_jwt = false, cron-only. A wrong x-cron-secret stops the handler at line one.
  {
    fn: "ingest-news",
    gate: "wrong x-cron-secret",
    headers: { "x-cron-secret": WRONG_CRON },
    expect: "Missing or bad x-cron-secret",
  },
  {
    fn: "build-digests",
    gate: "wrong x-cron-secret",
    headers: { "x-cron-secret": WRONG_CRON },
    expect: "Missing or bad x-cron-secret",
  },
  {
    fn: "send-briefs",
    gate: "wrong x-cron-secret",
    headers: { "x-cron-secret": WRONG_CRON },
    expect: "Missing or bad x-cron-secret",
  },
  {
    fn: "check-reminders",
    gate: "wrong x-cron-secret",
    headers: { "x-cron-secret": WRONG_CRON },
    expect: "Missing or bad x-cron-secret",
  },
  {
    fn: "plan-day",
    gate: "wrong x-cron-secret",
    headers: { "x-cron-secret": WRONG_CRON },
    expect: "Missing or bad x-cron-secret",
  },

  // verify_jwt = false, each with its own third-party-shaped credential.
  // mcp answers JSON-RPC rather than the project's {"error":...} — a bare error body would
  // surface in an MCP client as a parse failure instead of as the reason for the rejection.
  {
    fn: "mcp",
    gate: "invalid de_ bearer token",
    headers: { authorization: "Bearer de_boot_smoke_invalid" },
    expect: "Unknown or revoked API token",
  },
  // push-subscribe runs requireUser() itself, so the gate being off is redundant, not absent.
  {
    fn: "push-subscribe",
    gate: "anon JWT → requireUser()",
    headers: { authorization: `Bearer ${ANON_KEY}` },
    expect: "Invalid or expired token",
  },
  // push-action is reached from the service worker, which holds no session at all; it
  // trusts only the HMAC action token in the notification payload.
  {
    fn: "push-action",
    gate: "no HMAC action token",
    headers: {},
    expect: "That notification has expired.",
  },
  {
    fn: "telegram-webhook",
    gate: "wrong webhook secret",
    headers: { "x-telegram-bot-api-secret-token": "boot-smoke-wrong" },
    expect: "Bad webhook secret",
  },
];

/** The gateway's own refusal — proof the isolate was never started. */
const GATEWAY_REFUSALS = ["UNAUTHORIZED_NO_AUTH_HEADER", "Missing authorization header"];

async function probe(p: Probe): Promise<string | null> {
  let status: number;
  let body: string;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${p.fn}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...p.headers },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    status = res.status;
    body = (await res.text()).slice(0, 400);
  } catch (err) {
    return `request failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // The failure this whole file exists for.
  if (body.includes("BOOT_ERROR"))
    return `BOOT_ERROR (${status}) — the isolate refused to start: ${body}`;
  if (status === 503) return `503 (${body}) — isolate unavailable; a bad import looks like this`;
  if (status >= 500) return `${status} — ${body}`;

  const gatewayRefused = GATEWAY_REFUSALS.find((f) => body.includes(f));
  if (gatewayRefused) {
    return `the gateway answered ("${gatewayRefused}"), so the isolate never booted and this probe proves nothing — the credential is not getting past verify_jwt`;
  }

  if (!body.includes(p.expect)) {
    return `handler did not answer as expected (${status}). wanted a body containing "${p.expect}", got: ${body}`;
  }
  return null;
}

const results = await Promise.all(PROBES.map(async (p) => ({ p, failure: await probe(p) })));

let failed = 0;
for (const { p, failure } of results) {
  if (failure) {
    failed++;
    console.error(`FAIL  ${p.fn.padEnd(18)} ${failure}`);
  } else {
    console.log(`boot  ${p.fn.padEnd(18)} handler reached via ${p.gate}`);
  }
}

console.log(`\n${PROBES.length - failed}/${PROBES.length} functions booted and ran their handler.`);
if (failed > 0) {
  console.error(
    `${failed} function(s) did not. Check the deployed bundle's imports — ` +
      `and remember rule 3: deploy EVERY function that bundles a changed _shared/ module, ` +
      `not just the one you edited (git grep -l 'shared/<file>' supabase/functions).`,
  );
  process.exit(1);
}
