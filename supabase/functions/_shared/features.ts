// Per-user feature switches, read in exactly one place.
//
// This file exists for the same reason quiet hours live inside notify.ts rather than at
// each call site: it is a property of the user, and forgetting it once is the bug that
// messages someone who switched the thing off. So no function reads user_features
// directly — they call isEnabled() at their entry point, and the cron ones call it before
// spending anything.
//
// The asymmetry worth noticing: a feature is enabled when there is no row. That makes
// adding a feature a migration with no backfill, and it makes the failure mode of a
// missing row "it works" rather than "it silently stopped for everyone".

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type Feature =
  | "digest"
  | "topics"
  | "reminders"
  | "planner"
  | "chat"
  | "voice"
  | "followups"
  | "telegram"
  | "push";

/**
 * Features that are off until switched on, with the reason.
 *
 * `planner` is opt-in because it is the only feature that starts a conversation the user
 * did not ask for — a cron job that messages you at 9am every morning is something you
 * should have to agree to, not something you discover. Everything else defaults on so
 * that existing accounts behave exactly as they did before this table existed.
 */
const DEFAULT_OFF: ReadonlySet<Feature> = new Set<Feature>(["planner"]);

export function defaultFor(feature: Feature): boolean {
  return !DEFAULT_OFF.has(feature);
}

/** Is this feature on for this user? Absent row means the default. */
export async function isEnabled(
  admin: SupabaseClient,
  userId: string,
  feature: Feature,
): Promise<boolean> {
  const { data, error } = await admin
    .from("user_features")
    .select("enabled")
    .eq("user_id", userId)
    .eq("feature", feature)
    .maybeSingle();

  // A read failure must not be able to switch a feature off for everyone. Log and fall
  // back to the default: the alternative is one bad query silencing the whole product.
  if (error) {
    console.error(`user_features read failed for ${feature}: ${error.message}`);
    return defaultFor(feature);
  }
  return data ? data.enabled : defaultFor(feature);
}

/**
 * Every switch for one user, defaults filled in.
 *
 * One query instead of nine, for the callers that need the whole picture — the Settings
 * page, and send-briefs deciding what to include in an email.
 */
export async function allFeatures(
  admin: SupabaseClient,
  userId: string,
): Promise<Record<Feature, boolean>> {
  const { data, error } = await admin
    .from("user_features")
    .select("feature, enabled")
    .eq("user_id", userId);
  if (error) console.error(`user_features read failed: ${error.message}`);

  const rows = new Map(
    (data ?? []).map((r: { feature: string; enabled: boolean }) => [r.feature, r.enabled]),
  );
  const out = {} as Record<Feature, boolean>;
  for (const feature of ALL_FEATURES) {
    out[feature] = rows.has(feature) ? !!rows.get(feature) : defaultFor(feature);
  }
  return out;
}

export const ALL_FEATURES: readonly Feature[] = [
  "digest",
  "topics",
  "reminders",
  "planner",
  "chat",
  "voice",
  "followups",
  "telegram",
  "push",
];

/**
 * Narrow a list of user ids to those with the feature on, in one query.
 *
 * The cron functions iterate users, and calling isEnabled() per user would be a round
 * trip each — which is exactly the kind of per-user cost the news pipeline is designed to
 * avoid. Written as "ids minus those explicitly off" so the enabled-by-default rule still
 * holds for users with no row at all.
 */
export async function filterEnabled(
  admin: SupabaseClient,
  userIds: string[],
  feature: Feature,
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const { data, error } = await admin
    .from("user_features")
    .select("user_id, enabled")
    .eq("feature", feature)
    .in("user_id", userIds);
  if (error) {
    console.error(`user_features bulk read failed for ${feature}: ${error.message}`);
    return defaultFor(feature) ? userIds : [];
  }

  const explicit = new Map(
    (data ?? []).map((r: { user_id: string; enabled: boolean }) => [r.user_id, r.enabled]),
  );
  return userIds.filter((id) => (explicit.has(id) ? !!explicit.get(id) : defaultFor(feature)));
}
