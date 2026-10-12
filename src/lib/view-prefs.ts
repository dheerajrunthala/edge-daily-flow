/**
 * Remembering a view twice, on purpose.
 *
 * The URL query string is the source of truth: a filtered list is a thing you send to
 * yourself on your phone, and it has to survive a refresh. But a URL is only there if
 * you arrived by one — tapping "Tasks" in the nav lands on a bare `/tasks`, and the
 * sort you chose yesterday should still be the sort you get. So every view also writes
 * its last state to localStorage and replays it onto an empty URL on first mount.
 *
 * localStorage throws in private windows and in embedded iframes with storage blocked
 * (the Lovable preview is one), so every access is wrapped: a failure here must cost
 * the user a remembered preference, never the page.
 */

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`de.${key}`);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`de.${key}`, JSON.stringify(value));
  } catch {
    /* no storage: the view still works, it just won't be remembered */
  }
}

/** Query params are strings; these keep the parsing in one place. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** "a,b" <-> ["a","b"], dropping blanks so `?tags=` never means a tag called "". */
export function csvToList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function listToCsv(v: string[]): string | undefined {
  return v.length ? v.join(",") : undefined;
}

export function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
