// The bot's public handle. Not a secret — it is visible in every deep link and in the
// chat itself; the token that *is* secret never leaves the Edge Function environment.
// Overridable per-environment in case a staging bot is ever needed.
export const TELEGRAM_BOT =
  (import.meta.env["VITE_TELEGRAM_BOT_USERNAME"] as string | undefined) || "DailyEdgeAppBot";

/**
 * The deep link that connects a chat. Tapping it opens the bot and sends
 * "/start <code>", which telegram-webhook consumes to bind chat_id to the user.
 */
export function telegramDeepLink(code: string): string {
  return `https://t.me/${TELEGRAM_BOT}?start=${encodeURIComponent(code)}`;
}
