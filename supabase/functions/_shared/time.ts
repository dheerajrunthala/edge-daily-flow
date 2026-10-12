// Timezone helpers for Edge Functions. Mirrors src/lib/tz.ts — the browser and the
// server must agree on what "today" means for a given user.

type Parts = { y: number; m: number; d: number; h: number; min: number; s: number };

export function partsInTz(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  const n = (k: string) => Number(p[k] ?? 0);
  return {
    y: n("year"),
    m: n("month"),
    d: n("day"),
    h: n("hour") % 24,
    min: n("minute"),
    s: n("second"),
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = partsInTz(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wall-clock time in tz -> UTC instant. Two passes, so DST boundaries land correctly. */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

/** "YYYY-MM-DD" for the instant as seen in tz. */
export function dayKey(date: Date, tz: string): string {
  const p = partsInTz(date, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Midnight at the start of the tz-local day containing `date`, as a UTC instant. */
export function startOfDayUtc(date: Date, tz: string): Date {
  const p = partsInTz(date, tz);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
}

/** The zone's current UTC offset formatted for an ISO timestamp, e.g. "+05:30". */
export function offsetLabel(date: Date, tz: string): string {
  const mins = Math.round(offsetMs(date, tz) / 60000);
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function weekdayName(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(date);
}

/** True for a real IANA zone, so a bad profiles.timezone can't throw deep inside Intl. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
