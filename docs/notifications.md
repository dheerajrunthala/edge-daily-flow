# Notifications and the reminder ladder

How anything in Daily Edge reaches a person: the channels, the escalation ladder, quiet hours, browser notifications and the Telegram bot.

Every notification goes out through `_shared/notify.ts`, the way every email goes out through `_shared/email.ts`.

### Notifications (Phase 5)

Every notification in the project goes out through `_shared/notify.ts`, the way every email
goes out through `_shared/email.ts`. `notify(recipient, payload, channels)` fans one payload
across the recipient's enabled channels and reports each independently, so one channel
failing never silences another.

- **Channels** live in `notification_prefs.channels` (`notification_channel` enum).
  All three deliver: `email`, `telegram` and `push` (web push — see below).
  `activeChannels()` is exported separately from `notify()` so a caller can claim its
  idempotency rows per channel before sending.
- `notify()` takes the service-role client as its first argument, because the push sender
  reads the recipient's subscriptions and prunes the dead ones.
- **Quiet hours** are enforced inside notify.ts, never by callers: it is a property of the
  user, and forgetting it at one call site is the bug that wakes someone at 3am. Wall clock
  in the user's timezone, normally wrapping midnight (22:00 → 07:00); `start = end` means
  off. Nothing is claimed or sent during the window, so the ladder simply resumes after it.

#### The escalation ladder

A task that opted into reminders (`remind_before` is set) walks these stages:

| stage   | fires                                         | channels        |
| ------- | --------------------------------------------- | --------------- |
| `lead`  | the user's `remind_before`                    | all enabled     |
| `1h`    | one hour before due                           | telegram / push |
| `15m`   | fifteen minutes before due                    | telegram / push |
| `due`   | at `due_at`                                   | all enabled     |
| `nag:k` | `due_at + k × nag_interval`, while still open | telegram / push |

**Email carries `lead` and `due` only** (`EMAIL_STAGES` / `routeStage()` in check-reminders).
Email is the channel you read later, so it gets the two rungs that are still news on a
delay; the in-between rungs and every nag are push-shaped — only useful now, and an inbox
full of "still open" is how a reminder app gets muted. The filter runs **before** the
ledger is claimed, not after: a stage email never carries leaves no email row behind, and a
user whose only channel is email simply has a shorter ladder (`lead` → `due`) rather than
stages that silently go nowhere.

- **`task_notifications` is the ledger, not the timer.** One row per
  (task, occurrence, stage, channel), claimed _before_ the send and deleted again if the
  send fails — the same pattern as `brief_sends`. That is what makes a per-minute cron safe
  to run 1440 times a day, and what makes two overlapping ticks unable to double-send.
- A recurring task rolling `due_at` forward starts a **fresh ladder for free**, because the
  ledger is keyed on `due_at`.
- **Stages that coincide collapse.** With `remind_before` = 1 hour, `lead` and `1h` are the
  same instant; `plan()` keys stages by fire time so the user gets one notification.
- **A stage earlier than `tasks.created_at` never fires.** Creating a task due in five
  minutes must not immediately ping "due in 1 hour". This is also why a 5-minute test task
  only shows `lead` (if `remind_before` ≤ 5 min), `due` and the nags.
- **Several stages pending at once** (the function was down) sends only the latest; the
  older ones are written with `delivered = false` — accounted for, never fired late, and
  not pretending an email went out.
- **`snoozed_until`** retires every stage before it, permanently. The ladder resumes at the
  current nag instead of replaying what it slept through.
- **All-day tasks get only `lead`.** Their `due_at` is local midnight, so escalating through
  "due now" and nagging would mean a birthday pinging you from 00:00.
- Safety rails, deliberately opinionated: stop nagging after `NAG_WINDOW_HOURS = 48` or
  `MAX_NAGS = 24`, whichever comes first, cap `MAX_PER_USER = 5` notifications per tick, and
  drop fixed stages more than `MAX_LATENESS_HOURS = 6` late. Nags are exempt from the
  lateness horizon because `plan()` only ever emits the current one.

#### Browser notifications (Phase 6)

Two independent mechanisms, and keeping them separate is the point:

- **In-app (tab open)** — `NotificationCenter`, mounted inside `AppShell`, subscribes over
  Supabase Realtime to the user's own `task_notifications` inserts and renders a toast +
  chime + tab badge. It is a **view of the ledger, not a fourth channel**: the row is
  written by check-reminders _before_ it sends, so an in-app toast cannot disagree with
  what actually went out, nothing is scheduled in the browser, and a laptop waking from
  sleep shows nothing stale because it simply never receives the rows it missed.
  `task_notifications` is in the `supabase_realtime` publication; realtime applies the
  table's own RLS (`user_id = auth.uid()`) to the socket's JWT.
  - One notification writes one row **per channel**, which arrive as separate events, so
    the component collapses on `task_id|due_at|stage` or the user gets three toasts.
  - Rows with `delivered = false` are bookkeeping for a superseded stage and are skipped.
  - The chime is synthesized in WebAudio (no asset) and must be **unlocked on the first
    user gesture** — a context created before any interaction starts suspended and cannot
    be resumed later. A reminder arriving before the first click is therefore silent.
  - Title flash and favicon badge (`src/lib/tab-alert.ts`) only run while the tab is
    hidden, and clear on focus. The title interval re-reads `document.title` whenever it
    is neither of its own two strings, so navigating mid-alert doesn't get overwritten.
- **Web push (tab closed)** — `push_subscriptions` + `public/sw.js` + the `push` channel.
  - **The VAPID public key is served by `push-subscribe`, not bundled.** The keys live
    only in the platform's secret store and rotating them needs no frontend rebuild.
    Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (raw base64url, exactly as
    `npx web-push generate-vapid-keys` prints them), `VAPID_SUBJECT`. `_shared/push.ts`
    splits the 65-byte public point into JWK `x`/`y` because Web Crypto won't import the
    raw form.
  - Sender is `jsr:@negrel/webpush` — Deno-native and Web Crypto only; verified to
    resolve in the Edge runtime. A fresh `ApplicationServer` per send batch, because its
    ECDH key is meant to be ephemeral (RFC 8291 §2).
  - **404/410 means the subscription is gone**, so the row is deleted. That is the whole
    of expiry handling, and why `sendPush` reports `removed` separately from `failed`.
    Every endpoint failing for any _other_ reason throws, so the ledger claim is released
    and the next tick retries.
  - **Done / Snooze 10m are handled in the service worker, which has no Supabase
    session** — it lives in the page's localStorage, which a worker cannot read, and the
    worker often runs with no page open. So each notification carries an HMAC **action
    token** naming one user and one task, expiring in 24h, and `push-action` trusts the
    signature instead of a bearer token. The signing key is HKDF-derived from
    `SUPABASE_SERVICE_ROLE_KEY` (salt `daily-edge/push-action`, info `v1`), so there is no
    extra secret and the derived key cannot be used as the service role. The task is
    re-read scoped to the user id _inside_ the token, exactly as the Telegram webhook
    scopes a press to the chat's user.
  - **Two buttons, not three.** Chrome renders at most two notification actions and
    silently drops the rest; "Tomorrow" stays a Telegram/app affordance.
  - `requireInteraction: true` is honoured on macOS **only** if Chrome's notification
    style is "Alerts", not "Banners" — the Settings card says so, because under Banners
    the card vanishes in seconds and takes the buttons with it.
  - `tag` is `task:<id>` + `renotify`, so a later rung replaces the earlier card in place
    and still alerts rather than stacking three "still open" notifications.
  - **The service worker is a plain `public/sw.js`, deliberately not generated.**
    `vite-plugin-pwa` (`injectManifest`) was tried and emits to `dist/service-worker.js`,
    which the nitro build never copies into `.output/public/` — it would 404 in
    production. There is also nothing to precache (the app is SSR) and nothing to inject:
    every payload carries both the URL to open and the URL to post a button press to, so
    the worker needs no build-time configuration at all.
  - **`pushsubscriptionchange` cannot tell the server** (no session in the worker), so the
    worker only re-subscribes locally and `syncSubscription()` re-upserts whatever the
    browser holds on **every app load**. That plus 404/410 pruning is how a rotated
    endpoint repairs itself.
  - Service workers need a real secure origin: **test on https://dailyedgeapp.lovable.app**,
    never the Lovable preview iframe.

#### Telegram (@DailyEdgeAppBot)

- **Linking** is a one-time code: the browser calls `request_telegram_link()` (SECURITY
  DEFINER, authenticated) which mints the code in the database — the browser never invents
  it — and opens `t.me/<bot>?start=<code>`. The webhook consumes the code, binds `chat_id`,
  nulls the code, and switches the `telegram` channel on. Codes are single-use and expire in
  15 minutes. `unlink_telegram()` undoes both halves.
- **Auth** is the `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET`
  (set via `setWebhook`'s `secret_token`), then `chat_id` → `telegram_links` for identity.
  An unlinked chat can do nothing but `/start`.
- **Registration needs no local secrets**: `POST {"register": true}` with a valid
  `x-cron-secret` makes the function call `setWebhook` on itself, so it can be driven from
  `select public.invoke_edge_function('telegram-webhook', '{"register": true}')` and the bot
  token never leaves the platform's secret store. `{"info": true}` returns `getWebhookInfo`.
- Reminder cards carry inline **Done / Snooze 1h / Tomorrow** buttons; `callback_data` is
  `<action>:<task_id>` and the task is re-read scoped to the chat's user, so a guessed id
  from another account is not actionable. The card is rewritten after the press so spent
  buttons disappear.
- Task mutations the bot performs live in `_shared/tasks.ts`, which mirrors
  `src/lib/task-logic.ts` (recurrence roll-forward, "tomorrow" meaning tomorrow's date
  rather than `due_at + 1 day`) — the bot has no browser to borrow that logic from.
