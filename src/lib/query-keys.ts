/**
 * React Query keys, in their own module so the mutation helpers in `task-actions.ts`
 * can invalidate without importing `queries.ts` (which imports them back).
 */
export const qk = {
  profile: ["profile"] as const,
  prefs: ["prefs"] as const,
  notifyPrefs: ["notification_prefs"] as const,
  telegram: ["telegram_link"] as const,
  pushSubs: ["push_subscriptions"] as const,
  apiTokens: ["api_tokens"] as const,
  tags: ["tags"] as const,
  tasks: ["tasks"] as const,
  digests: ["digests"] as const,
  items: (digestId: string | undefined) => ["news_items", digestId] as const,
  saved: ["news_items", "saved"] as const,
  completions: ["completions"] as const,
  notificationActions: ["notification_actions"] as const,
  topics: ["topics"] as const,
  features: ["user_features"] as const,
  // Insights. The window start is part of the key: it changes at local midnight, which
  // is exactly when the figures mean something different and the cache should miss.
  // `newsCounts` sits under "news_items" so marking a story read invalidates it too.
  toolCalls: (since: string) => ["mcp_tool_calls", since] as const,
  aiEvents: (since: string) => ["ai_events", since] as const,
  newsCounts: (since: string) => ["news_items", "counts", since] as const,
};
