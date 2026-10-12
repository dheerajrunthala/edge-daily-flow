// Timezone helpers built on Intl — all user-facing dates use profiles.timezone.

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}

export function allTimezones(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
    if (list?.length) return list;
  } catch {
    /* ignore */
  }
  return [
    "Asia/Kolkata",
    "UTC",
    "Europe/London",
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Singapore",
    "Asia/Tokyo",
  ];
}

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

function offsetMs(date: Date, tz: string) {
  const p = partsInTz(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert wall-clock time in tz to a UTC Date. */
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

/** "YYYY-MM-DD" for the date in tz. */
export function dayKey(date: Date | string, tz: string): string {
  const p = partsInTz(new Date(date), tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function timeKey(date: Date | string, tz: string): string {
  const p = partsInTz(new Date(date), tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
}

export function fromKeys(day: string, time: string, tz: string): Date {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const [h = 0, min = 0] = time.split(":").map(Number);
  return zonedToUtc(y, m, d, h || 0, min || 0, tz);
}

export function addDaysKey(day: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function fmt(date: Date | string, tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, ...opts }).format(new Date(date));
}

export function relativeTime(date: Date | string, now = new Date()) {
  const diff = (new Date(date).getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function greeting(tz: string) {
  const h = partsInTz(new Date(), tz).h;
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
