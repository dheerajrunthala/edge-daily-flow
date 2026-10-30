# P6 — WhatsApp as a fourth channel

**Model: sonnet.** **Size: ~0.5h of code.** The code is small; **Meta's app review is the
risk** and cannot be rushed. **Depends on: nothing.**

## Why it is cheap

The architecture already fans out. `notify(admin, recipient, payload, channels)` in
`_shared/notify.ts` takes a list of channels and reports each independently, so one channel
failing never silences another. Adding a channel is one sender plus one webhook — no changes to
the reminder ladder, quiet hours, or any caller.

That is the payoff of a decision made in Phase 5 and worth pointing at: see
[../notifications.md](../notifications.md).

## Shape

1. Add `whatsapp` to the `notification_channel` enum (a migration — load `add-migration`).
2. `_shared/whatsapp.ts` — send a template message via the Meta Cloud API. Mirror
   `_shared/telegram.ts` in shape so the two read alike.
3. A `notifyWhatsApp` branch in `notify.ts`, beside `notifyEmail` / `notifyTelegram` /
   `notifyPush`.
4. `supabase/functions/whatsapp-webhook/index.ts` — inbound. Verify Meta's signature;
   `verify_jwt = false` plus the `config.toml` block.
5. Linking: copy the Telegram one-time-code flow exactly (`request_telegram_link()`, code nulled
   on use, 15-minute expiry). Do not invent a second mechanism.
6. A row in the Settings channels list, and the `telegram`-style feature gate.

## Traps

- **Meta requires approved message templates** for business-initiated messages outside a
  24-hour customer-service window. A reminder at 9am is business-initiated. Template approval is
  the long pole — start it first, before writing code.
- **Routing.** `EMAIL_STAGES` / `routeStage()` in `check-reminders` decides which ladder rungs
  each channel gets. WhatsApp is push-shaped, not email-shaped: it should get the in-between
  rungs and the nags, like Telegram. Decide this deliberately rather than defaulting.
- Quiet hours are already enforced inside `notify.ts`. Do not add a check.

## Acceptance criteria

- A linked number receives a `lead` and a `due` reminder.
- Unlinking stops delivery and switches the channel off.
- One channel failing (an expired template) does not prevent email or push — assert on the
  per-channel result array, which is exactly what it exists for.
- `npm run build && npm run lint && npm test` green.

## Verification

`select public.invoke_edge_function('check-reminders')` with a real task due, and read back the
`task_notifications` rows: one per channel per stage, which is the ledger proving what was sent.
