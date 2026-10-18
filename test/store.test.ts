// Domain rules (store.ts): the decision loop and its fail-closed checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TbError } from "@opt2-tealbrick/miniapp-sdk";
import * as store from "../src/store.ts";
import { AGENT, memoryDb, OTHER, OWNER } from "./helpers.ts";

const T0 = Date.parse("2026-10-12T10:00:00Z");
const from = { type: "agent" as const, id: AGENT.id, name: AGENT.name };
/** the verified callers of the agent ops (an agent has no product) */
const ME = { type: "agent" as const, id: AGENT.id, product: null };
const THEM = { type: "agent" as const, id: OTHER.id, product: null };
const code = (code: string, status?: number) => (e: unknown) => {
  assert.equal((e as TbError).code, code);
  if (status) assert.equal((e as TbError).httpStatus, status);
  return true;
};

test("approval: ask → status open → owner approves → agent reads approve with the owner's note", () => {
  const db = memoryDb();
  const item = store.ask(db, from, { kind: "approval", title: "Send the invoice to ACME?", context: "Total 120 EUR" }, T0);
  assert.match(item.id, /^itm_/);
  assert.equal(item.status, "open");
  assert.equal(item.version, 1);
  assert.equal(item.expiresAt, new Date(T0 + store.DEFAULT_EXPIRY_S * 1000).toISOString());

  let s = store.status(db, ME, item.id);
  assert.deepEqual([s.status, s.seenByOwner, s.response], ["open", false, null]);

  const d = store.decide(db, { itemId: item.id, version: 1, response: "approve", message: "Go ahead." }, OWNER.id, T0 + 1000);
  assert.deepEqual(d, { itemId: item.id, status: "answered", response: "approve", decidedAt: new Date(T0 + 1000).toISOString() });
  s = store.status(db, ME, item.id);
  assert.deepEqual([s.status, s.seenByOwner, s.response, s.message], ["answered", true, "approve", "Go ahead."]);

  const full = store.get(db, item.id, T0 + 2000);
  assert.equal(full.decision?.decidedBy, OWNER.id, "who decided is recorded");
  assert.equal(full.decision?.decidedAt, new Date(T0 + 1000).toISOString(), "when is recorded");
  assert.deepEqual(
    full.messages.map((m) => [m.author, m.body]),
    [["owner", "Go ahead."]],
  );
});

test("question: answer needs words; clarify needs words; approve is not allowed on a question", () => {
  const db = memoryDb();
  const q = store.ask(db, from, { kind: "question", title: "Which region?" }, T0);
  assert.deepEqual(store.get(db, q.id, T0).responses, ["answer", "clarify"]);
  assert.throws(() => store.decide(db, { itemId: q.id, version: 1, response: "approve" }, OWNER.id, T0), code("response_not_allowed", 409));
  assert.throws(() => store.decide(db, { itemId: q.id, version: 1, response: "answer", message: "   " }, OWNER.id, T0), code("message_required", 400));
  assert.throws(() => store.decide(db, { itemId: q.id, version: 1, response: "clarify" }, OWNER.id, T0), code("message_required", 400));
  store.decide(db, { itemId: q.id, version: 1, response: "answer", message: "eu-west" }, OWNER.id, T0);
  assert.equal(store.status(db, ME, q.id).message, "eu-west");
});

test("ask refuses responses outside the kind and an approval without approve/deny", () => {
  const db = memoryDb();
  assert.throws(() => store.ask(db, from, { kind: "approval", title: "x", responses: ["answer"] }, T0), code("response_not_allowed", 400));
  assert.throws(() => store.ask(db, from, { kind: "approval", title: "x", responses: ["clarify"] }, T0), code("response_not_allowed", 400));
  assert.throws(() => store.ask(db, from, { kind: "question", title: "x", responses: ["deny"] }, T0), code("response_not_allowed", 400));
  const a = store.ask(db, from, { kind: "approval", title: "x", responses: ["approve", "clarify"] }, T0);
  assert.throws(() => store.decide(db, { itemId: a.id, version: 1, response: "deny" }, OWNER.id, T0), code("response_not_allowed", 409));
});

test("a duplicate answer fails closed and the first one stands", () => {
  const db = memoryDb();
  const a = store.ask(db, from, { kind: "approval", title: "Deploy?" }, T0);
  store.decide(db, { itemId: a.id, version: 1, response: "deny", message: "Not today." }, OWNER.id, T0);
  assert.throws(() => store.decide(db, { itemId: a.id, version: 1, response: "approve" }, OWNER.id, T0), code("already_decided", 409));
  assert.throws(() => store.decide(db, { itemId: a.id, version: 2, response: "approve" }, OWNER.id, T0), code("already_decided", 409));
  assert.equal(store.status(db, ME, a.id).response, "deny");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM inbox_decisions").get()?.n), 1);
});

test("a stale answer (the agent added a message after the owner opened the item) is refused", () => {
  const db = memoryDb();
  const a = store.ask(db, from, { kind: "approval", title: "Pay supplier?" }, T0);
  const seen = store.get(db, a.id, T0).version;
  store.reply(db, ME, a.id, "Correction: the amount is 1200, not 120.", T0 + 10);
  assert.throws(
    () => store.decide(db, { itemId: a.id, version: seen, response: "approve" }, OWNER.id, T0 + 20),
    (e: unknown) => code("stale_version", 409)(e) && (e as TbError).details?.version === 2,
  );
  assert.equal(store.status(db, ME, a.id).status, "open", "nothing was decided");
  store.decide(db, { itemId: a.id, version: 2, response: "deny", message: "Too much." }, OWNER.id, T0 + 30);
  assert.deepEqual(
    store.get(db, a.id, T0 + 40).messages.map((m) => m.author),
    ["agent", "owner"],
  );
});

test("expiry: an unanswered item expires, cannot be answered and the agent reads expired", () => {
  const db = memoryDb();
  const a = store.ask(db, from, { kind: "approval", title: "Quick one", expiresInS: 60 }, T0);
  const later = T0 + 61_000;
  assert.throws(() => store.decide(db, { itemId: a.id, version: 1, response: "approve" }, OWNER.id, later), code("item_expired", 409));
  assert.equal(store.expireDue(db, later), 1);
  assert.throws(() => store.decide(db, { itemId: a.id, version: 1, response: "approve" }, OWNER.id, later), code("item_expired", 409));
  const s = store.status(db, ME, a.id);
  assert.deepEqual([s.status, s.response], ["expired", null]);
  assert.throws(() => store.reply(db, ME, a.id, "hello?", later), code("item_closed", 409));
  assert.throws(() => store.ack(db, a.id, later), code("item_closed", 409));
});

test("agents see only their own items (another agent's item is not found)", () => {
  const db = memoryDb();
  const a = store.ask(db, from, { kind: "question", title: "Mine" }, T0);
  assert.deepEqual([store.status(db, THEM, a.id).status, store.status(db, THEM, a.id).response], ["unknown", null]);
  assert.equal(store.status(db, ME, "itm_missing").status, "unknown");
  assert.throws(() => store.reply(db, THEM, a.id, "x", T0), code("item_not_found", 404));
  assert.throws(() => store.get(db, "itm_missing", T0), code("item_not_found", 404));
});

test("triage: ack, priority, snooze only on open items; snooze must be future and ≤ 30 days; a passed snooze is pending again", () => {
  const db = memoryDb();
  const a = store.ask(db, from, { kind: "approval", title: "A" }, T0);
  const b = store.ask(db, from, { kind: "approval", title: "B", priority: "low" }, T0 + 1);
  const c = store.ask(db, from, { kind: "question", title: "C", priority: "urgent" }, T0 + 2);
  assert.equal(store.ack(db, a.id, T0 + 5).acked, true);
  assert.equal(store.status(db, ME, a.id).seenByOwner, true);
  assert.equal(store.setPriority(db, b.id, "high", T0 + 5).priority, "high");
  assert.deepEqual(
    store.list(db, "pending", 10, 0, T0 + 6).items.map((i) => i.title),
    ["C", "B", "A"],
    "urgent first, then high, then oldest",
  );
  assert.throws(() => store.snooze(db, a.id, new Date(T0 - 1000).toISOString(), T0 + 6), code("until_invalid", 400));
  assert.throws(() => store.snooze(db, a.id, "tomorrow", T0 + 6), code("until_invalid", 400));
  assert.throws(() => store.snooze(db, a.id, new Date(T0 + 31 * 86400_000).toISOString(), T0 + 6), code("until_invalid", 400));
  const until = new Date(T0 + 3600_000).toISOString();
  assert.equal(store.snooze(db, a.id, until, T0 + 6).snoozedUntil, until);
  let l = store.list(db, "pending", 10, 0, T0 + 7);
  assert.deepEqual(
    l.items.map((i) => i.title),
    ["C", "B"],
  );
  assert.deepEqual(l.counts, { pending: 2, snoozed: 1 });
  assert.deepEqual(
    store.list(db, "snoozed", 10, 0, T0 + 7).items.map((i) => i.title),
    ["A"],
  );
  l = store.list(db, "pending", 10, 0, T0 + 3600_001);
  assert.equal(l.items.length, 3, "the snooze passed");
  assert.equal(store.snooze(db, a.id, null, T0 + 8).snoozedUntil, null);

  store.decide(db, { itemId: c.id, version: 1, response: "answer", message: "done" }, OWNER.id, T0 + 9);
  assert.throws(() => store.ack(db, c.id, T0 + 10), code("item_closed", 409));
  assert.throws(() => store.setPriority(db, c.id, "low", T0 + 10), code("item_closed", 409));
  assert.throws(() => store.snooze(db, c.id, until, T0 + 10), code("item_closed", 409));
  assert.deepEqual(
    store.list(db, "done", 10, 0, T0 + 11).items.map((i) => [i.title, i.response]),
    [["C", "answer"]],
  );
});

test("paging and the per-caller open-item cap", () => {
  const db = memoryDb();
  for (let i = 0; i < store.MAX_OPEN_PER_CALLER; i++) store.ask(db, from, { kind: "question", title: `q${i}` }, T0 + i);
  assert.throws(() => store.ask(db, from, { kind: "question", title: "one more" }, T0 + 500), code("too_many_open_items", 429));
  store.ask(db, { type: "agent", id: OTHER.id, name: OTHER.name }, { kind: "question", title: "other agent" }, T0 + 501);
  const p1 = store.list(db, "pending", 60, 0, T0 + 600);
  assert.equal(p1.items.length, 60);
  assert.equal(p1.nextCursor, "60");
  const p2 = store.list(db, "pending", 60, 60, T0 + 600);
  assert.equal(p2.items.length, 41);
  assert.equal(p2.nextCursor, null);
});

test("a failed decide leaves no partial write (one transaction)", () => {
  const db = memoryDb();
  const a = store.ask(db, from, { kind: "question", title: "Q" }, T0);
  assert.throws(() => store.decide(db, { itemId: a.id, version: 1, response: "answer" }, OWNER.id, T0));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM inbox_decisions").get()?.n), 0);
  assert.equal(store.get(db, a.id, T0).version, 1);
});
