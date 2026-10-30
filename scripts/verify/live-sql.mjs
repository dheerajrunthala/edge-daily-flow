// Run SQL against the live project from a shell, so the tier-3 checks stop being a
// transcript somebody else cannot re-run.
//
//   node scripts/verify/live-sql.mjs --file scripts/db-checks.sql --privileged
//   node scripts/verify/live-sql.mjs --sql "select count(*) from news_items"
//
// ─────────────────────────────────────────────────────────────────────────────────────
// Why the Management API and not psql
//
// docs/testing.md says to run `scripts/db-checks.sql` through the Supabase MCP's
// execute_sql. That is still the right thing to do inside a session — but it means the
// repo's own 13 database assertions can only be run by an agent, and a judge or a new
// contributor cannot type one command and see them pass.
//
// POST /v1/projects/{ref}/database/query is the endpoint the hosted Supabase MCP server
// calls underneath execute_sql, so this is the same transport and the same result, reached
// without a session. It needs SUPABASE_ACCESS_TOKEN — already in .env.local, because
// deploying a function needs it too. No database password and no connection string.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// Why this re-implements the hook's deny list
//
// .claude/hooks/block-destructive-sql.sh is a PreToolUse hook, and it only guards the MCP
// tools. A script that posts SQL over HTTPS is a second door into the same production
// database with the hook nowhere near it. So the same patterns are checked here before
// anything is sent. A rule that holds on one path and not the other is not a rule.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

// Exit codes are read by scripts/verify-claims.sh, which must never print a skip as a pass.
const EXIT_FAILED = 1; // the query ran and the answer was wrong
const EXIT_NO_CREDENTIAL = 3; // cannot run at all
const EXIT_TRANSPORT = 4; // network or API failure; the claim is unknown, not false

function die(code, message) {
  console.error(message);
  process.exit(code);
}

// --------------------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const file = value("--file");
const inline = value("--sql");
if (!file === !inline) die(EXIT_FAILED, "usage: live-sql.mjs (--file <path> | --sql <text>)");

const sql = file ? readFileSync(resolve(ROOT, file), "utf8") : inline;
const label = file ?? "inline query";

// --------------------------------------------------------------- the hook's own deny list

/**
 * The patterns from .claude/hooks/block-destructive-sql.sh, in the same order and with the
 * same escape hatches. Comments are stripped per line *before* newlines are collapsed —
 * collapsing first would let a DROP on the line after a `--` comment hide inside it.
 */
function destructive(text) {
  const lower = text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/[\t]/g, " ")
    .replace(/ +/g, " ")
    .toLowerCase();

  if (lower.includes("drop table")) return "DROP TABLE";
  if (lower.includes("drop schema")) return "DROP SCHEMA";
  if (lower.includes("drop database")) return "DROP DATABASE";
  if (lower.includes("drop column")) return "DROP COLUMN — data loss is not reversible";
  if (lower.includes("truncate")) return "TRUNCATE";
  if (lower.includes("disable row level security")) return "disabling RLS";
  if (lower.includes("drop policy") && !lower.includes("create policy"))
    return "DROP POLICY with no CREATE POLICY after it";
  if (/delete\s+from/.test(lower) && !lower.includes("where")) return "DELETE without WHERE";
  if (/update\s+\S+\s+set\s/.test(lower) && !lower.includes("where")) return "UPDATE without WHERE";
  return null;
}

const danger = destructive(sql);
if (danger) {
  die(
    EXIT_FAILED,
    `refusing to send ${danger} to production (same rule as ` +
      `.claude/hooks/block-destructive-sql.sh). ${label} should not contain it.`,
  );
}

// ------------------------------------------------------------------------- credentials

/** Read one key out of a dotenv-shaped file, ignoring comments. Never prints the value. */
function fromDotenv(name, path) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/** The project ref is public — it is in .env and in supabase/config.toml by design. */
function projectRef() {
  const fromEnv = process.env.SUPABASE_PROJECT_ID || fromDotenv("SUPABASE_PROJECT_ID", ".env");
  if (fromEnv) return fromEnv;
  try {
    const toml = readFileSync(resolve(ROOT, "supabase/config.toml"), "utf8");
    return toml.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}

const token =
  process.env.SUPABASE_ACCESS_TOKEN || fromDotenv("SUPABASE_ACCESS_TOKEN", ".env.local");
const ref = projectRef();

if (!token) {
  die(
    EXIT_NO_CREDENTIAL,
    "no SUPABASE_ACCESS_TOKEN (checked the environment and .env.local). " +
      "Create one at https://supabase.com/dashboard/account/tokens, or run the SQL " +
      "through the Supabase MCP instead: execute_sql(<contents of " +
      (file ?? "the query") +
      ">).",
  );
}
if (!ref) die(EXIT_NO_CREDENTIAL, "no project ref in SUPABASE_PROJECT_ID, .env or config.toml");

// ------------------------------------------------------------------------------- run it

// read_only routes the query through `supabase_read_only_user`, which is what a claim query
// should use. Two things need more than that, and both are opted into explicitly with
// --privileged rather than being the default:
//
//   * db-checks.sql assertion 7 has to call a function that WRITES. It rolls the writes back
//     inside a PL/pgSQL EXCEPTION block (Postgres implements that as a savepoint) and then
//     re-counts to prove the rollback happened — but a read-only connection refuses before
//     any of that.
//   * calling match_news_items() at all. EXECUTE on the SECURITY DEFINER RPCs was revoked
//     from public and anon, and supabase_read_only_user holds nothing either, so a read-only
//     connection gets `42501: permission denied for function match_news_items`. Which is
//     itself the revoke working — but it means the cross-account check has to connect as a
//     role that can make the call it is trying to prove is scoped.
const readOnly = !flag("--privileged");

let res;
try {
  res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql, read_only: readOnly }),
    signal: AbortSignal.timeout(120_000),
  });
} catch (err) {
  die(EXIT_TRANSPORT, `could not reach api.supabase.com: ${err?.message ?? err}`);
}

const text = await res.text();

if (!res.ok) {
  // Postgres raising an assertion comes back as a 4xx with the message in the body. That is
  // a FAILED claim. An auth or quota problem is transport — the claim is simply unknown.
  const message = (() => {
    try {
      const j = JSON.parse(text);
      return j.message ?? j.error ?? text;
    } catch {
      return text;
    }
  })();
  if (res.status === 401 || res.status === 403) {
    die(EXIT_NO_CREDENTIAL, `SUPABASE_ACCESS_TOKEN rejected (${res.status}): ${message}`);
  }
  if (res.status >= 500) die(EXIT_TRANSPORT, `api.supabase.com ${res.status}: ${message}`);
  die(EXIT_FAILED, String(message).trim());
}

// A pass is silence: db-checks.sql returns no rows when every assertion holds.
let rows;
try {
  rows = JSON.parse(text);
} catch {
  die(EXIT_TRANSPORT, `unparseable response: ${text.slice(0, 300)}`);
}

if (!Array.isArray(rows) || rows.length === 0) process.exit(0);

// TSV, so the caller can read a number out of it with `cut` and nothing more.
//
// ALIAS EVERY COLUMN in a query you run through this. The API answers with JSON objects
// keyed by column name, and `select count(*), count(distinct x)` names both columns "count"
// — so JSON.parse keeps only the last one and the row silently comes back one field short,
// with a plausible number in the wrong place. Three of the claim queries in
// verify-claims.sh read wrong before they were aliased.
for (const row of rows) {
  console.log(
    Object.values(row)
      .map((v) => (v === null ? "" : String(v)))
      .join("\t"),
  );
}
