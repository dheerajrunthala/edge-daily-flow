// Telegram Bot API access. Kept separate from notify.ts the way email.ts is kept separate
// from the functions that send mail: this file knows the wire protocol, nothing else does.
//
// Bot: @DailyEdgeAppBot. TELEGRAM_BOT_TOKEN is an Edge Function secret.

const API_ROOT = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

function token(): string {
  const t = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!t) throw new TelegramError("TELEGRAM_BOT_TOKEN is not set on this project");
  return t;
}

export function botUsername(): string {
  return Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "DailyEdgeAppBot";
}

/** One Bot API call. Telegram answers 200 with `ok: false` for logical errors, not just HTTP errors. */
async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_ROOT}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  } | null;
  if (!res.ok || !body?.ok) {
    throw new TelegramError(
      `${method} failed: ${body?.description ?? res.statusText}`,
      body?.error_code ?? res.status,
    );
  }
  return body.result as T;
}

// ------------------------------------------------------------------ types

export type InlineButton = { text: string; callback_data: string };

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
};

// ------------------------------------------------------------------ sending

/**
 * Send a message. `parse_mode: HTML` because Telegram's MarkdownV2 requires escaping a
 * dozen characters that show up constantly in task titles and news headlines.
 */
export async function sendMessage(
  chatId: number,
  html: string,
  opts: { buttons?: InlineButton[][]; preview?: boolean } = {},
): Promise<{ message_id: number }> {
  return await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: opts.preview !== true },
    ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
  });
}

/**
 * Acknowledge a button press. Telegram shows a spinner on the button until this is
 * called, so it has to happen even when the handler fails.
 */
export async function answerCallback(id: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

/** Replace a message's text, used to strike through a card once its buttons are spent. */
export async function editMessageText(
  chatId: number,
  messageId: number,
  html: string,
): Promise<void> {
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

export async function setWebhook(url: string, secret: string): Promise<unknown> {
  return await call("setWebhook", {
    url,
    secret_token: secret,
    // Everything else (polls, edits, channel posts) would just be dropped by the handler.
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo(): Promise<unknown> {
  return await call("getWebhookInfo", {});
}

/** Telegram's HTML subset allows <b> <i> <code> <a>; everything else must be escaped. */
export function tgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
