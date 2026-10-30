---
name: deploy-and-verify-fn
description: Deploy a Supabase Edge Function from this repo and prove it works — the CLI invocation, the verify_jwt trap, the jsr flake, and how to read logs when a function fails silently. Use after editing anything under supabase/functions/.
---

# Deploying an Edge Function

## The command

```bash
set -a; . ./.env.local; set +a    # SUPABASE_ACCESS_TOKEN, gitignored
npx --yes supabase@latest functions deploy <name> --project-ref uhhphhkpxxofspbfynmo
```

Deploy **every function that bundles a changed `_shared/` module**, not just the one you
edited. `git grep -l 'shared/<file>' supabase/functions` lists them. A shared fix that
reaches only one function is how `dayKey()` stayed broken in half the project.

## Expect the jsr flake

`Failed to bundle ... jsr.io/... timed out after 10s` is Supabase's bundler, not your
code — jsr.io answers in under a second from here. Retry; it usually lands within three
attempts, and the big bundles (`mcp`) flake most. Loop rather than giving up:

```bash
for i in 1 2 3 4 5; do
  out=$(npx --yes supabase@latest functions deploy "$1" --project-ref uhhphhkpxxofspbfynmo 2>&1)
  echo "$out" | grep -q "Deployed Functions" && break; sleep 8
done
```

## Check config.toml before deploying anything new

An unlisted function gets `verify_jwt = true`. For a function authenticated by something
other than a Supabase JWT, that rejects every real caller **before the handler runs**, and
the failure is invisible from the app. `push-action` was one `supabase functions deploy`
away from this: it is reached from the service worker, which has no session at all, and
authenticates with an HMAC token in the payload.

So add a block for every new function, with the reason:

```toml
[functions.<name>]
verify_jwt = false   # or true
```

## Verify, and not by reading the deploy output

- **Cron-secret functions**: run the real production path, never a new one.
  ```sql
  select public.invoke_edge_function('<name>', '{"force": true}');
  ```
  Then read the result — pg_net records it in `net._http_response` keyed by the returned
  id. `BOOT_ERROR` there means a bad import; `IDLE_TIMEOUT` means something hung.
- **User-JWT functions**: a user token cannot be minted from here (the service role key
  lives only in the platform's secret store), so verify the refusals you _can_ — anon and
  the publishable key must both 401 — and have the owner exercise the happy path in the
  browser.
- **MCP tools**: call them through the connected `daily-edge` MCP server and diff the
  output against what it returned before the change.

## When it fails silently

A function that answers nothing and logs nothing was almost certainly killed by the
platform. Read the logs with the **right field name** — `event_message` is a top-level
column, and `log_attributes['event_message']` returns empty strings:

```sql
select timestamp, event_message from logs
where source = 'function_logs'
order by timestamp desc limit 30
```

Pass `iso_timestamp_start`/`end` around the actual invocation. `select now()` first — a
window guessed from local time will be hours off and return nothing, which reads exactly
like "no logs".

Two failure modes that produce silence rather than an error:

1. **A missing export is a boot failure.** `import { X }` where the module does not export
   `X` is not a type error here; the isolate refuses to start and pg_net sees
   `{"code":"BOOT_ERROR"}`.
2. **An unbounded `fetch` loses the error.** The runtime's wall clock is 150s; a hung
   upstream call means the platform kills the invocation and nothing that was going to be
   logged ever is. Every Gemini call in `_shared/gemini.ts` now carries its own deadline
   for this reason — keep that true of any new network call.
