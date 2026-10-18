// G6 I2 (C263): quiet hours in the owner's time zone and the alert digest. Pure quiet-hours math (midnight, DST), the
// settings rules, deferral in `each` mode, and the digest (window, frozen input, held retry with the same key, first
// contact, withdraw never cancels it, empty window, quiet at due time). Good cases and bad cases, L34.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { ALERTS_OFF, DIGEST_TITLES, digestText, readAlerts } from "../src/alerts.ts";
import { clock, handlers, tick } from "../src/app.ts";
import { inQuiet, localMinutes, quietEnd, validTimeZone } from "../src/quiet.ts";
import { writeSetting } from "../src/store.ts";
import { AGENT, type CallApp, ctxFor, memoryDb, OWNER, PORTAL, type Sent, WS } from "./helpers.ts";

const h = handlers as Record<string, { run(input: any, ctx: any): Promise<any> }>;
const NPUB = `npub1${"q".repeat(58)}`;
const BERLIN = "Europe/Berlin";
const NIGHT = { start: "22:00", end: "07:00" };
const code = (c: string, status = 400) => (e: unknown) => {
  assert.equal((e as TbError).code, c);
  assert.equal((e as TbError).httpStatus, status);
  return true;
};

function fakeConnect(script: (n: number, s: Sent) => Json | Error = () => ({ status: "ok", output: {} })): { callApp: CallApp; sent: Sent[] } {
  const sent: Sent[] = [];
  const callApp = (async (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => {
    const s = { product, op, input, key: opts?.idempotencyKey };
    sent.push(s);
    const r = script(sent.length, s);
    if (r instanceof Error) throw r;
    return r;
  }) as CallApp;
  return { callApp, sent };
}

/** A clock the handlers and the tick share. */
function clockAt(iso: string) {
  const real = clock.now;
  let now = Date.parse(iso);
  clock.now = () => now;
  return {
    get now() {
      return now;
    },
    set(t: string | number) {
      now = typeof t === "number" ? t : Date.parse(t);
    },
    restore() {
      clock.now = real;
    },
  };
}
const startCtx = (db: ReturnType<typeof memoryDb>, callApp: CallApp) => ({
  db,
  log: { debug() {}, info() {}, warn() {}, error() {} },
  callApp,
  statusChanged() {},
  ownerLink: (p: string) => `${PORTAL}/w/${WS}/open?product=inbox&path=${encodeURIComponent(p)}`,
});
const alerts = (over: Record<string, unknown> = {}) => ({ dm: "buzz", buzzTo: NPUB, channelAccount: null, channelPerson: null, ...over });

// ── quiet-hours math ──

test("quiet math: a window across midnight in Berlin (CEST, UTC+2); outside → no wait", () => {
  assert.equal(localMinutes(BERLIN, Date.parse("2026-10-18T20:30:00Z")), 22 * 60 + 30);
  assert.equal(inQuiet(NIGHT, BERLIN, Date.parse("2026-10-18T20:30:00Z")), true, "22:30 local");
  assert.equal(inQuiet(NIGHT, BERLIN, Date.parse("2026-10-18T04:59:00Z")), true, "06:59 local");
  assert.equal(inQuiet(NIGHT, BERLIN, Date.parse("2026-10-18T05:00:00Z")), false, "07:00 local: end is exclusive");
  assert.equal(inQuiet(NIGHT, BERLIN, Date.parse("2026-10-18T12:00:00Z")), false);
  assert.equal(quietEnd(NIGHT, BERLIN, Date.parse("2026-10-18T20:30:00Z")), Date.parse("2026-10-19T05:00:00Z"));
  const noon = Date.parse("2026-10-18T12:00:00Z");
  assert.equal(quietEnd(NIGHT, BERLIN, noon), noon);
  assert.equal(quietEnd(null, BERLIN, noon), noon);
  assert.equal(inQuiet(NIGHT, null, Date.parse("2026-10-18T20:30:00Z")), false, "no zone → no quiet hours");
});

test("quiet math across DST: spring forward skips 02:00–03:00, fall back repeats 02:00–03:00 (Berlin 2026)", () => {
  // 2026-03-29 01:00Z: 02:00 CET becomes 03:00 CEST
  const spring = { start: "01:30", end: "02:30" };
  assert.equal(quietEnd(spring, BERLIN, Date.parse("2026-03-29T00:40:00Z")), Date.parse("2026-03-29T01:00:00Z"), "01:40 CET → quiet ends at 03:00 CEST");
  // 2026-10-25 01:00Z: 03:00 CEST becomes 02:00 CET (the hour repeats)
  const fall = { start: "02:00", end: "02:30" };
  assert.equal(quietEnd(fall, BERLIN, Date.parse("2026-10-25T00:10:00Z")), Date.parse("2026-10-25T00:30:00Z"), "first 02:10 CEST → 02:30 CEST");
  assert.equal(inQuiet(fall, BERLIN, Date.parse("2026-10-25T01:10:00Z")), true, "second 02:10 (CET) is quiet again");
});

test("validTimeZone: IANA names pass; junk, empty and over-long fail", () => {
  for (const z of ["Europe/Berlin", "UTC", "America/New_York"]) assert.equal(validTimeZone(z), true, z);
  for (const z of ["", "Mars/Olympus", "x".repeat(65), 42, null]) assert.equal(validTimeZone(z), false, String(z));
});

// ── settings ──

test("settings: quiet hours need a valid zone and distinct times; a bad window size is refused; dm off resets everything", async () => {
  const db = memoryDb();
  const me = ctxFor(db, OWNER);
  await assert.rejects(h.alerts_set.run(alerts({ quietHours: NIGHT }), me), code("time_zone_invalid"));
  await assert.rejects(h.alerts_set.run(alerts({ quietHours: NIGHT, timeZone: "Mars/Olympus" }), me), code("time_zone_invalid"));
  await assert.rejects(h.alerts_set.run(alerts({ quietHours: { start: "07:00", end: "07:00" }, timeZone: BERLIN }), me), code("alerts_invalid"));
  await assert.rejects(h.alerts_set.run(alerts({ quietHours: { start: "7:00", end: "08:00" }, timeZone: BERLIN }), me), code("alerts_invalid"));
  await assert.rejects(h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 5 }), me), code("alerts_invalid"));
  const ok = await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 180, quietHours: NIGHT, timeZone: BERLIN }), me);
  assert.deepEqual([ok.delivery, ok.digestEveryMin, ok.quietHours, ok.timeZone], ["digest", 180, NIGHT, BERLIN]);
  assert.deepEqual(await h.alerts_get.run({}, me), ok);
  assert.deepEqual(await h.alerts_set.run({ dm: "off", buzzTo: null, channelAccount: null, channelPerson: null, quietHours: NIGHT, timeZone: BERLIN }, me), ALERTS_OFF);
});

test("settings reader is tolerant: a 0.3.x setting reads with the defaults; a stored zone this runtime does not know turns quiet hours off", () => {
  const db = memoryDb();
  writeSetting(db, "alerts", { dm: "buzz", buzzTo: NPUB, channelAccount: null, channelPerson: null });
  assert.deepEqual(readAlerts(db), { ...ALERTS_OFF, dm: "buzz", buzzTo: NPUB });
  writeSetting(db, "alerts", { dm: "buzz", buzzTo: NPUB, channelAccount: null, channelPerson: null, quietHours: NIGHT, timeZone: "Gone/Zone", delivery: "weekly", digestEveryMin: 7 });
  const a = readAlerts(db);
  assert.deepEqual([a.quietHours, a.timeZone, a.delivery, a.digestEveryMin], [null, null, "each", 60]);
});

// ── each mode + quiet hours ──

test("each mode: an item asked in quiet hours waits (no DM) and goes out once when the window ends", async (t) => {
  const c = clockAt("2026-10-18T21:00:00Z"); // 23:00 Berlin
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  const conn = fakeConnect();
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "Late question" }, ctxFor(db, AGENT, conn.callApp));
  assert.equal(conn.sent.length, 0, "quiet: nothing sent");
  const d = (await h.item_get.run({ itemId }, ctxFor(db, OWNER))).deliveries[0];
  assert.deepEqual([d.status, d.error], ["pending", "quiet_hours"]);
  c.set("2026-10-19T04:55:00Z"); // 06:55
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 0, "still quiet");
  c.set("2026-10-19T05:00:00Z"); // 07:00
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 1);
  assert.equal((await h.item_get.run({ itemId }, ctxFor(db, OWNER))).deliveries[0].status, "sent");
});

test("each mode: a withdraw during quiet hours means no DM at the end; a retry that falls into quiet hours waits too", async (t) => {
  const c = clockAt("2026-10-18T21:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  const conn = fakeConnect();
  const app = { type: "app", id: "ins_01J00000000000000000000C01", name: "Creative", mode: "free", product: "creative" } as const;
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "x" }, ctxFor(db, app, conn.callApp));
  await h.inbox_withdraw.run({ itemId }, ctxFor(db, app));
  c.set("2026-10-19T05:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 0, "withdrawn before the window ended: never sent");

  // daytime send times out → the retry is due at 21:59 local... make it fall into quiet hours
  c.set("2026-10-19T19:59:30Z"); // 21:59:30 Berlin
  const slow = fakeConnect(() => ({ status: "held", holdId: "hld_1", expiresAt: "x" }));
  const b = await h.inbox_ask.run({ kind: "question", title: "y" }, ctxFor(db, AGENT, slow.callApp));
  assert.equal(slow.sent.length, 1, "daytime: sent at once (held by Connect)");
  c.set("2026-10-19T20:01:00Z"); // 22:01, the held row is due
  await tick(startCtx(db, slow.callApp) as never, c.now);
  assert.equal(slow.sent.length, 2, "a HELD send is re-checked in quiet hours (it runs only after the owner approved it)");
  void b;
});

// ── digest ──

test("digest: one DM per window with the count, the titles and the Inbox link; never the context; items get 'next' then 'sent'", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 60 }), ctxFor(db, OWNER));
  const conn = fakeConnect();
  c.set("2026-10-18T10:05:00Z");
  const a = await h.inbox_ask.run({ kind: "approval", title: "Ship v2?", context: "SECRET context", priority: "urgent" }, ctxFor(db, AGENT, conn.callApp));
  const b = await h.inbox_ask.run({ kind: "question", title: "Which region?" }, ctxFor(db, AGENT, conn.callApp));
  assert.equal(conn.sent.length, 0, "digest mode: no DM per item");
  assert.deepEqual((await h.item_get.run({ itemId: a.itemId }, ctxFor(db, OWNER))).deliveries, []);
  const next = (await h.item_get.run({ itemId: a.itemId }, ctxFor(db, OWNER))).digest;
  assert.deepEqual(next, { status: "next", at: "2026-10-18T11:00:00.000Z", error: null });

  c.set("2026-10-18T10:59:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 0, "the window is not over");
  c.set("2026-10-18T11:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 1);
  const text = String((conn.sent[0]?.input as { content: string } | undefined)?.content);
  assert.equal(
    text,
    `Operator Inbox: 2 new items wait for you.\n- Scout asks for your approval (urgent): Ship v2?\n- Scout has a question: Which region?\nOpen: ${PORTAL}/w/${WS}/open?product=inbox&path=%2F`,
  );
  assert.ok(!text.includes("SECRET"));
  assert.match(String(conn.sent[0]?.key), /^inbox-digest-dgs_/);
  for (const id of [a.itemId, b.itemId]) assert.equal((await h.item_get.run({ itemId: id }, ctxFor(db, OWNER))).digest.status, "sent");

  // the next window is empty: no DM
  c.set("2026-10-18T12:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 1, "an empty window sends nothing");
});

test("digest: only items still open count; withdrawn, answered and snoozed ones are left out; > DIGEST_TITLES titles end with +N more", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 60 }), ctxFor(db, OWNER));
  const conn = fakeConnect();
  const app = { type: "app", id: "ins_01J00000000000000000000C01", name: "Creative", mode: "free", product: "creative" } as const;
  c.set("2026-10-18T10:01:00Z");
  const gone = await h.inbox_ask.run({ kind: "question", title: "withdrawn one" }, ctxFor(db, app));
  await h.inbox_withdraw.run({ itemId: gone.itemId }, ctxFor(db, app));
  const done = await h.inbox_ask.run({ kind: "question", title: "answered one" }, ctxFor(db, AGENT));
  await h.item_decide.run({ itemId: done.itemId, response: "answer", message: "ok", version: 1 }, ctxFor(db, OWNER));
  const later = await h.inbox_ask.run({ kind: "question", title: "snoozed one" }, ctxFor(db, AGENT));
  await h.item_snooze.run({ itemId: later.itemId, until: "2026-10-18T15:00:00Z" }, ctxFor(db, OWNER));
  for (let i = 1; i <= DIGEST_TITLES + 2; i++) await h.inbox_ask.run({ kind: "question", title: `q${i}` }, ctxFor(db, AGENT));
  c.set("2026-10-18T11:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  const text = String((conn.sent[0]?.input as { content: string } | undefined)?.content);
  assert.match(text, new RegExp(`^Operator Inbox: ${DIGEST_TITLES + 2} new items wait for you\\.`));
  assert.ok(!/withdrawn one|answered one|snoozed one/.test(text));
  assert.match(text, /\n\+2 more\n/);
  assert.equal(text.split("\n").filter((l) => l.startsWith("- ")).length, DIGEST_TITLES);
});

test("digest: a held digest repeats with the same input and key; first contact switches the op; a later withdraw never cancels it", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 60 }), ctxFor(db, OWNER));
  const app = { type: "app", id: "ins_01J00000000000000000000C01", name: "Creative", mode: "free", product: "creative" } as const;
  c.set("2026-10-18T10:30:00Z");
  const one = await h.inbox_ask.run({ kind: "question", title: "one" }, ctxFor(db, app));
  await h.inbox_ask.run({ kind: "question", title: "two" }, ctxFor(db, AGENT));
  const conn = fakeConnect((n): Json | Error => (n === 1 ? Object.assign(new Error("first"), { code: "buzz_first_contact_required" }) : n === 2 ? { status: "held", holdId: "hld_d", expiresAt: "x" } : { status: "ok", output: {} }));
  c.set("2026-10-18T11:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.deepEqual(
    conn.sent.map((s) => s.op),
    ["buzz_dm", "buzz_dm_first"],
  );
  assert.equal((await h.item_get.run({ itemId: one.itemId }, ctxFor(db, OWNER))).digest.status, "held");
  await h.inbox_withdraw.run({ itemId: one.itemId }, ctxFor(db, app));
  c.set("2026-10-18T11:02:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 3);
  assert.deepEqual([conn.sent[2]?.op, conn.sent[2]?.key, conn.sent[2]?.input], [conn.sent[1]?.op, conn.sent[1]?.key, conn.sent[1]?.input], "same op, key and frozen input");
  assert.equal((await h.item_get.run({ itemId: one.itemId }, ctxFor(db, OWNER))).digest.status, "sent", "the withdraw did not cancel the digest");
});

test("digest: a window that ends in quiet hours is sent when they end; turning the digest on does not repeat older items", async (t) => {
  const c = clockAt("2026-10-18T19:00:00Z"); // 21:00 Berlin
  t.after(() => c.restore());
  const db = memoryDb();
  const conn = fakeConnect();
  await h.inbox_ask.run({ kind: "question", title: "before the switch" }, ctxFor(db, AGENT));
  c.set("2026-10-18T19:10:00Z");
  await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 60, quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  c.set("2026-10-18T19:20:00Z");
  const a = await h.inbox_ask.run({ kind: "question", title: "after the switch" }, ctxFor(db, AGENT));
  assert.equal((await h.item_get.run({ itemId: a.itemId }, ctxFor(db, OWNER))).digest.at, "2026-10-19T05:00:00.000Z", "due 22:10 local = quiet → about 07:00");
  c.set("2026-10-18T20:10:00Z"); // 22:10 local: due but quiet
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 0);
  c.set("2026-10-19T05:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 1);
  const text = String((conn.sent[0]?.input as { content: string } | undefined)?.content);
  assert.match(text, /^Operator Inbox: 1 new item waits for you\.\n- Scout has a question: after the switch\n/);
});

test("digestText without a Portal link ends with the plain hint", () => {
  assert.equal(digestText([{ kind: "question", priority: "normal", title: "t", from: { type: "agent", id: "a", name: "Scout" } }], null), "Operator Inbox: 1 new item waits for you.\n- Scout has a question: t\nOpen Operator Inbox to answer.");
});

// ── review round (S2-1, S2-2, S3) ──

const deliveryOf = async (db: ReturnType<typeof memoryDb>, itemId: string) => (await h.item_get.run({ itemId }, ctxFor(db, OWNER))).deliveries[0];
const digests = (db: ReturnType<typeof memoryDb>) => db.prepare("SELECT status, error, item_ids FROM inbox_digests ORDER BY created_at, id").all();

test("S2-1: a DM that waits for quiet hours is never sent for an item answered or expired meanwhile; an item still open is sent", async (t) => {
  const c = clockAt("2026-10-18T21:00:00Z"); // 23:00 Berlin
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  const conn = fakeConnect();
  const answered = await h.inbox_ask.run({ kind: "question", title: "answered at night" }, ctxFor(db, AGENT, conn.callApp));
  const short = await h.inbox_ask.run({ kind: "question", title: "expires at night", expiresInS: 3600 }, ctxFor(db, AGENT, conn.callApp));
  const open = await h.inbox_ask.run({ kind: "question", title: "still open" }, ctxFor(db, AGENT, conn.callApp));
  c.set("2026-10-18T21:30:00Z");
  await h.item_decide.run({ itemId: answered.itemId, response: "answer", message: "done", version: 1 }, ctxFor(db, OWNER));
  c.set("2026-10-19T05:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.deepEqual(
    conn.sent.map((s) => (s.input as { content: string }).content.split("\n")[0]),
    ["Scout has a question: still open"],
  );
  for (const id of [answered.itemId, short.itemId]) assert.deepEqual([(await deliveryOf(db, id)).status, (await deliveryOf(db, id)).error], ["failed", "closed"]);
  assert.equal((await deliveryOf(db, open.itemId)).status, "sent");
});

test("retryDue: a PENDING send that falls due in quiet hours moves to the end of the window (no send); after it, it goes out", async (t) => {
  const c = clockAt("2026-10-18T19:00:00Z"); // 21:00 Berlin
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  const conn = fakeConnect(() => ({ status: "held", holdId: "hld_p", expiresAt: "x" }));
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "x" }, ctxFor(db, AGENT, conn.callApp));
  // as after a timeout: pending again, due at 22:01
  db.prepare("UPDATE inbox_deliveries SET status = 'pending', hold_id = NULL, next_at = ? WHERE item_id = ?").run(Date.parse("2026-10-18T20:01:00Z"), itemId);
  c.set("2026-10-18T20:01:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 1, "no second send in quiet hours");
  const row = db.prepare("SELECT next_at, error FROM inbox_deliveries WHERE item_id = ?").get(itemId);
  assert.deepEqual([row?.next_at, row?.error], [Date.parse("2026-10-19T05:00:00Z"), "quiet_hours"]);
  c.set("2026-10-19T05:00:00Z");
  const ok = fakeConnect();
  await tick(startCtx(db, ok.callApp) as never, c.now);
  assert.equal(ok.sent.length, 1);
});

test("S2-2: switching from the digest to one DM per item still sends the open window once; later items get their own DM; switching off drops it", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  const conn = fakeConnect();
  await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 60 }), ctxFor(db, OWNER));
  c.set("2026-10-18T10:10:00Z");
  await h.inbox_ask.run({ kind: "question", title: "w1" }, ctxFor(db, AGENT, conn.callApp));
  await h.inbox_ask.run({ kind: "question", title: "w2" }, ctxFor(db, AGENT, conn.callApp));
  c.set("2026-10-18T10:30:00Z");
  await h.alerts_set.run(alerts({ delivery: "each" }), ctxFor(db, OWNER));
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 1);
  assert.match(String((conn.sent[0]?.input as { content: string } | undefined)?.content), /^Operator Inbox: 2 new items wait for you\.\n- Scout has a question: w1\n- Scout has a question: w2\n/);
  await tick(startCtx(db, conn.callApp) as never, c.now + 60_000);
  assert.equal(conn.sent.length, 1, "the flush runs once");
  await h.inbox_ask.run({ kind: "question", title: "after" }, ctxFor(db, AGENT, conn.callApp));
  assert.equal(conn.sent.length, 2, "one DM per item again");

  // digest → off: the open window is not sent
  const db2 = memoryDb();
  const conn2 = fakeConnect();
  c.set("2026-10-18T10:00:00Z");
  await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 60 }), ctxFor(db2, OWNER));
  c.set("2026-10-18T10:10:00Z");
  await h.inbox_ask.run({ kind: "question", title: "w1" }, ctxFor(db2, AGENT, conn2.callApp));
  await h.alerts_set.run({ dm: "off" }, ctxFor(db2, OWNER));
  await tick(startCtx(db2, conn2.callApp) as never, c.now + 7200_000);
  assert.equal(conn2.sent.length, 0);
});

test("turning alerts off or changing the target closes every send that has not gone out (item DMs and digests)", async (t) => {
  const c = clockAt("2026-10-18T21:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  const conn = fakeConnect();
  await h.alerts_set.run(alerts({ quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  const a = await h.inbox_ask.run({ kind: "question", title: "x" }, ctxFor(db, AGENT, conn.callApp));
  // the same settings saved again: the waiting DM stays
  await h.alerts_set.run(alerts({ quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  assert.equal((await deliveryOf(db, a.itemId)).status, "pending");
  await h.alerts_set.run(alerts({ buzzTo: `npub1${"p".repeat(58)}`, quietHours: NIGHT, timeZone: BERLIN }), ctxFor(db, OWNER));
  assert.deepEqual([(await deliveryOf(db, a.itemId)).status, (await deliveryOf(db, a.itemId)).error], ["failed", "alerts_changed"]);
  const b = await h.inbox_ask.run({ kind: "question", title: "y" }, ctxFor(db, AGENT, conn.callApp));
  await h.alerts_set.run({ dm: "off" }, ctxFor(db, OWNER));
  assert.deepEqual([(await deliveryOf(db, b.itemId)).status, (await deliveryOf(db, b.itemId)).error], ["failed", "alerts_off"]);
  c.set("2026-10-19T05:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 0);
});

test("a digest that waits for approval in Connect blocks the next build; after approval the next digest covers both windows", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ delivery: "digest", digestEveryMin: 60 }), ctxFor(db, OWNER));
  c.set("2026-10-18T10:10:00Z");
  await h.inbox_ask.run({ kind: "question", title: "first window" }, ctxFor(db, AGENT));
  const held = fakeConnect(() => ({ status: "held", holdId: "hld_h", expiresAt: "x" }));
  c.set("2026-10-18T11:00:00Z");
  await tick(startCtx(db, held.callApp) as never, c.now);
  c.set("2026-10-18T11:30:00Z");
  await h.inbox_ask.run({ kind: "question", title: "second window" }, ctxFor(db, AGENT));
  c.set("2026-10-18T12:00:00Z");
  await tick(startCtx(db, held.callApp) as never, c.now); // still held: re-check only, no new row
  assert.equal(digests(db).length, 1);
  const ok = fakeConnect();
  c.set("2026-10-18T12:05:00Z");
  await tick(startCtx(db, ok.callApp) as never, c.now); // approved: the retry runs it
  assert.equal(digests(db)[0]?.status, "sent");
  c.set("2026-10-18T12:06:00Z");
  await tick(startCtx(db, ok.callApp) as never, c.now);
  assert.equal(digests(db).length, 2);
  assert.match(String((ok.sent.at(-1)?.input as { content: string } | undefined)?.content), /^Operator Inbox: 1 new item waits for you\.\n- Scout has a question: second window\n/);
});

test("a digest setting without its cursor starts the window at the next tick (no send then), then sends normally", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  writeSetting(db, "alerts", { dm: "buzz", buzzTo: NPUB, channelAccount: null, channelPerson: null, delivery: "digest", digestEveryMin: 60, quietHours: null, timeZone: null });
  const conn = fakeConnect();
  await tick(startCtx(db, conn.callApp) as never, c.now);
  c.set("2026-10-18T10:10:00Z");
  await h.inbox_ask.run({ kind: "question", title: "x" }, ctxFor(db, AGENT));
  c.set("2026-10-18T11:00:00Z");
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 1);
});

test("item_get: an item asked before the digest window started shows no 'next' line; a snoozed one neither", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  const before = await h.inbox_ask.run({ kind: "question", title: "before" }, ctxFor(db, AGENT));
  c.set("2026-10-18T10:05:00Z");
  await h.alerts_set.run(alerts({ delivery: "digest" }), ctxFor(db, OWNER));
  c.set("2026-10-18T10:06:00Z");
  const after = await h.inbox_ask.run({ kind: "question", title: "after" }, ctxFor(db, AGENT));
  const snoozed = await h.inbox_ask.run({ kind: "question", title: "snoozed" }, ctxFor(db, AGENT));
  await h.item_snooze.run({ itemId: snoozed.itemId, until: "2026-10-18T20:00:00Z" }, ctxFor(db, OWNER));
  assert.equal((await h.item_get.run({ itemId: before.itemId }, ctxFor(db, OWNER))).digest, null);
  assert.equal((await h.item_get.run({ itemId: snoozed.itemId }, ctxFor(db, OWNER))).digest, null);
  assert.equal((await h.item_get.run({ itemId: after.itemId }, ctxFor(db, OWNER))).digest.status, "next");
});

test("a never-sent digest whose items are all closed is dropped before its first send; a denied hold (new holdId) stops it", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts({ delivery: "digest" }), ctxFor(db, OWNER));
  const app = { type: "app", id: "ins_01J00000000000000000000C01", name: "Creative", mode: "free", product: "creative" } as const;
  const w = await h.inbox_ask.run({ kind: "question", title: "w" }, ctxFor(db, app));
  await h.inbox_withdraw.run({ itemId: w.itemId }, ctxFor(db, app));
  // as after a crash between build and first send
  db.prepare(
    `INSERT INTO inbox_digests (id, window_from, window_to, item_ids, channel, op, input, idem_key, status, hold_id, error, attempts, next_at, created_at, updated_at)
     VALUES ('dgs_x', 0, ?, ?, 'buzz', 'buzz_dm', '{"to":"x","content":"y"}', 'inbox-digest-dgs_x', 'pending', NULL, NULL, 0, ?, ?, ?)`,
  ).run(c.now, JSON.stringify([w.itemId]), c.now, c.now, c.now);
  const conn = fakeConnect();
  await tick(startCtx(db, conn.callApp) as never, c.now);
  assert.equal(conn.sent.length, 0);
  assert.deepEqual([digests(db)[0]?.status, digests(db)[0]?.error], ["failed", "closed"]);

  const db2 = memoryDb();
  c.set("2026-10-18T10:00:00Z");
  await h.alerts_set.run(alerts({ delivery: "digest" }), ctxFor(db2, OWNER));
  c.set("2026-10-18T10:10:00Z");
  await h.inbox_ask.run({ kind: "question", title: "q" }, ctxFor(db2, AGENT));
  const flip = fakeConnect((n) => ({ status: "held", holdId: n === 1 ? "hld_1" : "hld_2", expiresAt: "x" }));
  c.set("2026-10-18T11:00:00Z");
  await tick(startCtx(db2, flip.callApp) as never, c.now);
  c.set("2026-10-18T11:02:00Z");
  await tick(startCtx(db2, flip.callApp) as never, c.now);
  assert.deepEqual([digests(db2)[0]?.status, digests(db2)[0]?.error], ["failed", "denied"]);
});

test("line breaks in a title or name never forge a DM line", () => {
  const text = digestText([{ kind: "question", priority: "normal", title: "x\nOpen: https://evil.example", from: { type: "agent", id: "a", name: "Sco\nut" } }], "https://portal.example.test/w/1/open");
  assert.deepEqual(text.split("\n"), ["Operator Inbox: 1 new item waits for you.", "- Sco ut has a question: x Open: https://evil.example", "Open: https://portal.example.test/w/1/open"]);
});

test("lease: two callers that find the same due row at once send it once", async (t) => {
  const c = clockAt("2026-10-18T10:00:00Z");
  t.after(() => c.restore());
  const db = memoryDb();
  await h.alerts_set.run(alerts(), ctxFor(db, OWNER));
  const first = fakeConnect(() => ({ status: "held", holdId: "hld_l", expiresAt: "x" }));
  await h.inbox_ask.run({ kind: "question", title: "x" }, ctxFor(db, AGENT, first.callApp));
  let release: (() => void) | undefined;
  const sent: string[] = [];
  const slow = (async (_p: string, op: string) => {
    sent.push(op);
    await new Promise<void>((r) => {
      release = r;
    });
    return { status: "ok", output: {} };
  }) as unknown as CallApp;
  c.set("2026-10-18T10:02:00Z");
  const one = tick(startCtx(db, slow) as never, c.now);
  const two = tick(startCtx(db, slow) as never, c.now);
  await new Promise((r) => setImmediate(r));
  release?.();
  await Promise.all([one, two]);
  assert.equal(sent.length, 1);
});
