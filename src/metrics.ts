// Inbox activity metrics (I5, DESIGN-B1 section 4). The definitions are FIXED and are repeated in the manifest op
// description and in ARCHITECTURE.md ("Metrics definitions"); change all three together or not at all.
//
// Two bounded reads, then plain TypeScript: (1) the items created in the window (now - days, now] with their decision
// time, (2) the earlier items that expired by time and whose `expires_at` falls in [window start - 24 h, now] (the only
// ones that can be the predecessor of a re-ask in the window). No per-item query.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { InboxMetricsOutput } from "#kit";

const DAY_MS = 86_400_000;
/** A re-ask must come within this long after the earlier item expired by time. */
export const REASK_WITHIN_MS = DAY_MS;
export const TOP_RAISERS = 10;

type Counts = { asked: number; answered: number; expired: number; withdrawn: number; open: number };
const zero = (): Counts => ({ asked: 0, answered: 0, expired: 0, withdrawn: 0, open: 0 });

/** trim, collapse white space, lower case */
export const normTitle = (t: string): string => t.trim().replace(/\s+/g, " ").toLowerCase();

/** Nearest rank on an ascending list: the ceil(pct/100 * n)-th smallest; null when empty. */
function nearestRank(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil((pct * sorted.length) / 100)) - 1] ?? null;
}

const rate4 = (num: number, den: number): number | null => (den === 0 ? null : Math.round((num / den) * 10_000) / 10_000);

export function metrics(db: Db, days: 7 | 30, now: number): InboxMetricsOutput {
  const from = now - days * DAY_MS;
  const rows = db
    .prepare(
      `SELECT i.id, i.from_type, i.from_id, i.from_name, i.title, i.status, i.withdrawn_at, i.created_at, d.decided_at
       FROM inbox_items i LEFT JOIN inbox_decisions d ON d.item_id = i.id
       WHERE i.created_at > ? AND i.created_at <= ?`,
    )
    .all(from, now);
  const earlier = db
    .prepare("SELECT from_type, from_id, title, expires_at FROM inbox_items WHERE status = 'expired' AND withdrawn_at IS NULL AND expires_at >= ? AND expires_at <= ?")
    .all(from - REASK_WITHIN_MS, now);

  // expiry times of earlier time-expired items, per raiser and normalized title
  const expiredAt = new Map<string, number[]>();
  for (const e of earlier) {
    const key = `${e.from_type}\u0000${e.from_id}\u0000${normTitle(String(e.title))}`;
    const list = expiredAt.get(key);
    if (list) list.push(Number(e.expires_at));
    else expiredAt.set(key, [Number(e.expires_at)]);
  }

  const total = zero();
  const raisers = new Map<string, { type: string; id: string; name: string; newest: number; c: Counts }>();
  const decisionS: number[] = [];
  let reAsks = 0;
  for (const r of rows) {
    const withdrawn = r.withdrawn_at !== null && r.withdrawn_at !== undefined;
    const bucket: keyof Counts = withdrawn ? "withdrawn" : r.status === "answered" ? "answered" : r.status === "expired" ? "expired" : "open";
    const created = Number(r.created_at);
    const rk = `${r.from_type}\u0000${r.from_id}`;
    let who = raisers.get(rk);
    if (!who) {
      who = { type: String(r.from_type), id: String(r.from_id), name: String(r.from_name), newest: created, c: zero() };
      raisers.set(rk, who);
    } else if (created > who.newest) {
      who.newest = created;
      who.name = String(r.from_name);
    }
    for (const c of [total, who.c]) {
      c.asked++;
      c[bucket]++;
    }
    if (bucket === "answered" && r.decided_at !== null && r.decided_at !== undefined) decisionS.push(Math.max(0, Math.round((Number(r.decided_at) - created) / 1000)));
    const prev = expiredAt.get(`${rk}\u0000${normTitle(String(r.title))}`);
    if (prev?.some((t) => t >= created - REASK_WITHIN_MS && t <= created)) reAsks++;
  }
  decisionS.sort((a, b) => a - b);

  const byRaiser = [...raisers.values()]
    .sort((a, b) => b.c.asked - a.c.asked || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, TOP_RAISERS)
    .map((w) => ({ from: { type: w.type as "agent" | "app" | "person", id: w.id, name: w.name }, ...w.c }));

  return {
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days },
    ...total,
    timeToDecision: { n: decisionS.length, p50S: nearestRank(decisionS, 50), p90S: nearestRank(decisionS, 90) },
    expiryRate: rate4(total.expired, total.answered + total.expired),
    reAskRate: rate4(reAsks, total.asked),
    byRaiser,
  };
}
