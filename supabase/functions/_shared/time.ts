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

/**
 * "YYYY-MM-DD" for the instant as seen in tz.
 *
 * Takes a string as well as a Date, and must: src/lib/tz.ts has always done
 * `new Date(date)` here and half the callers on this side pass an ISO timestamp straight
 * out of Postgres. Without the conversion, Intl's formatToParts coerces the string with
 * ToNumber, gets NaN, and throws "Invalid time value" — which is exactly what
 * nextOccurrenceAhead did on its `allDay` branch, i.e. every time an all-day recurring
 * task (a birthday) was completed from Telegram or a push button.
 */
export function dayKey(date: Date | string, tz: string): string {
  const p = partsInTz(new Date(date), tz);
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

/**
 * Postgres interval text to milliseconds. PostgREST renders an interval either as
 * "HH:MM:SS" or as "N days" / "N days HH:MM:SS" depending on the value, which is why
 * both shapes are handled here. Used for tasks.remind_before and
 * notification_prefs.nag_interval.
 */
export function intervalMs(value: string | null): number | null {
  if (!value) return null;
  let ms = 0;
  let matched = false;

  const days = /(-?\d+)\s+days?/.exec(value);
  if (days) {
    ms += Number(days[1]) * 86_400_000;
    matched = true;
  }
  const clock = /(\d{1,2}):(\d{2}):(\d{2})/.exec(value);
  if (clock) {
    ms += (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000;
    matched = true;
  }
  const hours = /(-?\d+)\s+hours?/.exec(value);
  if (!clock && hours) {
    ms += Number(hours[1]) * 3_600_000;
    matched = true;
  }
  const mins = /(-?\d+)\s+mins?(?:utes?)?/.exec(value);
  if (!clock && mins) {
    ms += Number(mins[1]) * 60_000;
    matched = true;
  }
  return matched ? ms : null;
}

/** Minutes since midnight as seen in tz — the unit quiet hours are compared in. */
export function minutesOfDay(date: Date, tz: string): number {
  const p = partsInTz(date, tz);
  return p.h * 60 + p.min;
}

/** "HH:MM" or "HH:MM:SS" (Postgres `time`) to minutes since midnight. */
export function clockToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
