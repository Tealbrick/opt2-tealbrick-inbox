// Quiet hours for the owner alert (G6 I2, C263): a daily window in the owner's own time zone during which no alert DM is
// sent. Pure functions over an IANA zone (Intl), so DST and windows across midnight need no special cases: the end of a
// window is found by stepping forward until the local wall time is outside it.

export interface QuietHours {
  /** local wall time "HH:MM" (24 h) when quiet starts */
  start: string;
  /** local wall time "HH:MM" when quiet ends; the window may cross midnight */
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
const MAX_LOOKAHEAD_MS = 48 * 3600_000;

export const validHhmm = (s: unknown): s is string => typeof s === "string" && HHMM.test(s);

const minutesOf = (hhmm: string): number => {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`not HH:MM: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** True when `tz` is an IANA zone this runtime knows. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** Minutes after local midnight in `tz` at the instant `at` (ms). */
export function localMinutes(tz: string, at: number): number {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formats.set(tz, f);
  }
  let h = 0;
  let m = 0;
  for (const p of f.formatToParts(new Date(at))) {
    if (p.type === "hour") h = Number(p.value) % 24;
    else if (p.type === "minute") m = Number(p.value);
  }
  return h * 60 + m;
}

/** True when the local wall time at `at` is inside [start, end). start = end is no window. */
export function inQuiet(q: QuietHours | null, tz: string | null, at: number): boolean {
  if (!q || !tz) return false;
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  if (s === e) return false;
  const now = localMinutes(tz, at);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/**
 * The first whole minute after `at` when quiet is over (local wall times change on whole minutes); `at` itself when not
 * in quiet hours. Bounded to 48 h, so a bad zone or window can never park an alert forever.
 */
export function quietEnd(q: QuietHours | null, tz: string | null, at: number): number {
  if (!inQuiet(q, tz, at)) return at;
  for (let t = Math.floor(at / MINUTE_MS) * MINUTE_MS + MINUTE_MS; t <= at + MAX_LOOKAHEAD_MS; t += MINUTE_MS) if (!inQuiet(q, tz, t)) return t;
  return at + MAX_LOOKAHEAD_MS;
}
