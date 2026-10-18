// I5 inbox_metrics (DESIGN-B1 section 4): the definitions on fixed fixtures. Each rule is tested on the good case AND the
// bad case (L34): a withdrawn item is not an expiry, a re-ask at 25 h is not a re-ask, a non-owner is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { clock, handlers } from "../src/app.ts";
import { metrics, normTitle } from "../src/metrics.ts";
import { AGENT, ctxFor, memoryDb, OWNER } from "./helpers.ts";

const h = handlers as Record<string, { run(input: any, ctx: any): Promise<any> }>;
const NOW = Date.parse("2026-10-18T12:00:00Z");
const H = 3_600_000;
const D = 24 * H;

interface Fix {
  id: string;
  who?: string;
  name?: string;
  type?: string;
  title?: string;
  status?: "open" | "answered" | "expired";
  created: number;
  /** expires_at; default created + 7 d */
  expires?: number;
  withdrawn?: boolean;
  /** decided_at (answered items) */
  decided?: number;
}
let seq = 0;
function put(db: Db, f: Fix): void {
  const status = f.status ?? "open";
  db.prepare(
    `INSERT INTO inbox_items (id, kind, title, responses, from_type, from_id, from_name, status, priority, version, created_at, updated_at, expires_at, withdrawn_at)
     VALUES (?, 'question', ?, '["answer","clarify"]', ?, ?, ?, ?, 'normal', 1, ?, ?, ?, ?)`,
  ).run(f.id, f.title ?? `Question ${f.id}`, f.type ?? "agent", f.who ?? "agt_A", f.name ?? "Scout", status, f.created, f.created, f.expires ?? f.created + 7 * D, f.withdrawn ? f.created + 1 : null);
  if (f.decided !== undefined) db.prepare("INSERT INTO inbox_decisions (id, item_id, response, message, decided_by, decided_at, item_version) VALUES (?, ?, 'answer', 'ok', 'per_1', ?, 1)").run(`dec_${++seq}`, f.id, f.decided);
}
/** an answered item decided `s` seconds after it was created */
const answered = (db: Db, id: string, created: number, s: number, extra: Partial<Fix> = {}) => put(db, { id, created, status: "answered", decided: created + s * 1000, ...extra });

test("empty inbox: zeros, null percentiles and null rates (zero denominators)", () => {
  const m = metrics(memoryDb(), 7, NOW);
  assert.deepEqual(m, {
    window: { from: "2026-10-11T12:00:00.000Z", to: "2026-10-18T12:00:00.000Z", days: 7 },
    asked: 0,
    answered: 0,
    expired: 0,
    withdrawn: 0,
    open: 0,
    timeToDecision: { n: 0, p50S: null, p90S: null },
    expiryRate: null,
    reAskRate: null,
    byRaiser: [],
  });
});

test("counts by status: a withdrawn item is withdrawn, never expired; open and answered are counted once", () => {
  const db = memoryDb();
  answered(db, "a1", NOW - H, 60);
  answered(db, "a2", NOW - H, 120);
  put(db, { id: "e1", status: "expired", created: NOW - 2 * D, expires: NOW - D });
  put(db, { id: "w1", status: "expired", created: NOW - 2 * D, withdrawn: true });
  put(db, { id: "w2", status: "expired", created: NOW - 2 * D, withdrawn: true });
  put(db, { id: "o1", created: NOW - H });
  const m = metrics(db, 7, NOW);
  assert.deepEqual([m.asked, m.answered, m.expired, m.withdrawn, m.open], [6, 2, 1, 2, 1]);
  assert.equal(m.answered + m.expired + m.withdrawn + m.open, m.asked);
  // withdrawn and open are out of the expiry rate: 1 / (2 + 1)
  assert.equal(m.expiryRate, 0.3333);
});

test("expiryRate: withdrawn-only and open-only windows have a zero denominator → null; all expired → 1", () => {
  const db = memoryDb();
  put(db, { id: "w1", status: "expired", created: NOW - D, withdrawn: true });
  put(db, { id: "o1", created: NOW - D });
  assert.equal(metrics(db, 7, NOW).expiryRate, null);
  put(db, { id: "e1", status: "expired", created: NOW - D, expires: NOW - H });
  assert.equal(metrics(db, 7, NOW).expiryRate, 1);
});

test("window edges: created exactly at now - days is out, one ms later is in, exactly now is in, after now is out", () => {
  const db = memoryDb();
  put(db, { id: "edge", created: NOW - 7 * D });
  put(db, { id: "in", created: NOW - 7 * D + 1 });
  put(db, { id: "now", created: NOW });
  put(db, { id: "future", created: NOW + 1 });
  assert.equal(metrics(db, 7, NOW).asked, 2);
  // 30 days: the 7-day edge item is inside, the 30-day edge is not
  put(db, { id: "edge30", created: NOW - 30 * D });
  put(db, { id: "in30", created: NOW - 30 * D + 1 });
  const m30 = metrics(db, 30, NOW);
  assert.equal(m30.asked, 4);
  assert.deepEqual(m30.window, { from: "2026-09-18T12:00:00.000Z", to: "2026-10-18T12:00:00.000Z", days: 30 });
});

test("timeToDecision: nearest-rank percentiles on n = 1, 2 and 10 (integers); only answered items of the window count", () => {
  const db = memoryDb();
  answered(db, "s1", NOW - H, 90);
  let t = metrics(db, 7, NOW).timeToDecision;
  assert.deepEqual(t, { n: 1, p50S: 90, p90S: 90 });
  answered(db, "s2", NOW - H, 30);
  t = metrics(db, 7, NOW).timeToDecision;
  // sorted 30, 90: ceil(0.5*2)=1st → 30; ceil(0.9*2)=2nd → 90
  assert.deepEqual(t, { n: 2, p50S: 30, p90S: 90 });
  answered(db, "outside", NOW - 8 * D, 5); // created before the window: not counted
  put(db, { id: "open", created: NOW - H }); // not answered: not counted
  assert.equal(metrics(db, 7, NOW).timeToDecision.n, 2);

  const ten = memoryDb();
  for (let i = 1; i <= 10; i++) answered(ten, `t${i}`, NOW - H, i * 10);
  // 10 values 10..100: p50 = 5th = 50; p90 = 9th = 90 (not interpolated)
  assert.deepEqual(metrics(ten, 7, NOW).timeToDecision, { n: 10, p50S: 50, p90S: 90 });
});

test("timeToDecision seconds are integers (rounded from milliseconds)", () => {
  const db = memoryDb();
  put(db, { id: "x", status: "answered", created: NOW - H, decided: NOW - H + 1_499 });
  assert.equal(metrics(db, 7, NOW).timeToDecision.p50S, 1);
});

const T0 = NOW - 3 * D;
/** an earlier item of the same raiser and title that expired by time at `T0 + expiredAfterMs`, and a new ask `gapMs` after that */
function reAskPair(gapMs: number, over: { earlier?: Partial<Fix>; later?: Partial<Fix> } = {}) {
  const db = memoryDb();
  put(db, { id: "first", status: "expired", created: T0 - 7 * D, expires: T0, title: "Deploy to prod?", ...over.earlier });
  put(db, { id: "second", created: T0 + gapMs, title: "Deploy to prod?", ...over.later });
  return metrics(db, 7, NOW);
}

test("re-ask: the same question 23 h after it expired by time is a re-ask; 25 h is not", () => {
  const yes = reAskPair(23 * H);
  assert.equal(yes.reAskRate, 1, "the later item is the only item of the window, and it is a re-ask");
  const no = reAskPair(25 * H);
  assert.equal(no.reAskRate, 0);
  // exactly 24 h is still inside, 24 h + 1 ms is out
  assert.equal(reAskPair(24 * H).reAskRate, 1);
  assert.equal(reAskPair(24 * H + 1).reAskRate, 0);
});

test("re-ask: a withdrawn predecessor is not a re-ask; a predecessor that is not expired is not a re-ask", () => {
  assert.equal(reAskPair(1 * H, { earlier: { withdrawn: true } }).reAskRate, 0);
  assert.equal(reAskPair(1 * H, { earlier: { status: "answered", decided: T0 } }).reAskRate, 0);
  assert.equal(reAskPair(1 * H).reAskRate, 1, "control: the same pair with a time-expired predecessor is a re-ask");
});

test("re-ask: another raiser with the same title is not a re-ask (also another type with the same id)", () => {
  assert.equal(reAskPair(1 * H, { later: { who: "agt_B" } }).reAskRate, 0);
  assert.equal(reAskPair(1 * H, { later: { type: "app" } }).reAskRate, 0);
});

test("re-ask: titles are compared after trim, collapsed white space and lower case; a different title is not a re-ask", () => {
  assert.equal(normTitle("  Deploy   TO\tprod? "), "deploy to prod?");
  assert.equal(reAskPair(1 * H, { later: { title: "  deploy   TO  PROD?  " } }).reAskRate, 1);
  assert.equal(reAskPair(1 * H, { later: { title: "Deploy to staging?" } }).reAskRate, 0);
});

test("re-ask: an ask before the predecessor expired is not a re-ask; the rate is re-asks over asked (rounded to 4 decimals)", () => {
  assert.equal(reAskPair(-1 * H).reAskRate, 0, "asked 1 h BEFORE the first one expired");
  const db = memoryDb();
  put(db, { id: "first", status: "expired", created: T0 - 7 * D, expires: T0, title: "Q" });
  put(db, { id: "again", created: T0 + H, title: "Q" });
  put(db, { id: "x1", created: T0 + H, title: "Other 1" });
  put(db, { id: "x2", created: T0 + H, title: "Other 2" });
  assert.equal(metrics(db, 7, NOW).reAskRate, 0.3333);
});

test("byRaiser: sorted by asked then id, name from the newest item, counts per status, capped at 10", () => {
  const db = memoryDb();
  // raiser B asks 2, raiser A asks 2 (tie → id order A before B), raiser C asks 3
  put(db, { id: "b1", who: "agt_B", name: "Old name", created: NOW - 2 * H });
  put(db, { id: "b2", who: "agt_B", name: "New name", created: NOW - H, status: "expired", withdrawn: true });
  put(db, { id: "a1", who: "agt_A", created: NOW - H });
  answered(db, "a2", NOW - H, 10, { who: "agt_A" });
  for (const i of [1, 2, 3]) put(db, { id: `c${i}`, who: "agt_C", name: "Cee", created: NOW - H });
  const m = metrics(db, 7, NOW);
  assert.deepEqual(
    m.byRaiser.map((r) => [r.from.id, r.asked]),
    [
      ["agt_C", 3],
      ["agt_A", 2],
      ["agt_B", 2],
    ],
  );
  const b = m.byRaiser[2];
  assert.deepEqual(b, { from: { type: "agent", id: "agt_B", name: "New name" }, asked: 2, answered: 0, expired: 0, withdrawn: 1, open: 1 });
  assert.deepEqual(m.byRaiser[1], { from: { type: "agent", id: "agt_A", name: "Scout" }, asked: 2, answered: 1, expired: 0, withdrawn: 0, open: 1 });

  const many = memoryDb();
  for (let i = 0; i < 12; i++) {
    const id = `agt_${String(i).padStart(2, "0")}`;
    put(many, { id: `m${i}`, who: id, created: NOW - H });
    if (i >= 10) put(many, { id: `n${i}`, who: id, created: NOW - H }); // 10 and 11 ask twice: first
  }
  const top = metrics(many, 7, NOW).byRaiser;
  assert.equal(top.length, 10);
  assert.deepEqual(
    top.map((r) => r.from.id),
    ["agt_10", "agt_11", "agt_00", "agt_01", "agt_02", "agt_03", "agt_04", "agt_05", "agt_06", "agt_07"],
  );
});

test("inbox_metrics through the handler: the owner reads, days defaults to 7; the input is read as 30 when given", async () => {
  const db = memoryDb();
  put(db, { id: "in7", created: Date.now() - H });
  put(db, { id: "in30", created: Date.now() - 20 * D });
  const m7 = await h.inbox_metrics.run({}, ctxFor(db, OWNER));
  assert.equal(m7.window.days, 7);
  assert.equal(m7.asked, 1);
  const m30 = await h.inbox_metrics.run({ days: 30 }, ctxFor(db, OWNER));
  assert.equal(m30.window.days, 30);
  assert.equal(m30.asked, 2);
});

test("the handler sweeps expiry first: an open item past its time counts as expired, not open", async () => {
  const db = memoryDb();
  const real = clock.now;
  clock.now = () => NOW;
  try {
    put(db, { id: "late", created: NOW - 2 * D, expires: NOW - H });
    const m = await h.inbox_metrics.run({}, ctxFor(db, OWNER));
    assert.deepEqual([m.open, m.expired], [0, 1]);
  } finally {
    clock.now = real;
  }
});

test("a non-owner caller (an agent) gets owner_only 403 through the handler", async () => {
  const db = memoryDb();
  put(db, { id: "x", created: Date.now() - H });
  await assert.rejects(h.inbox_metrics.run({}, ctxFor(db, AGENT)), (e: unknown) => (e as TbError).code === "owner_only" && (e as TbError).httpStatus === 403);
  await assert.rejects(h.inbox_metrics.run({ days: 30 }, ctxFor(db, { type: "app", id: "ins_1", name: "App", mode: "free", product: "kanban" })), (e: unknown) => (e as TbError).code === "owner_only");
});
