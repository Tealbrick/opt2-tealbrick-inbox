// S4-7: inbox_status and inbox_reply match the verified caller on type + id, and for an app also on the product the
// item recorded. S4-4: the tick bounds the refused-attempt rows by age AND by a cap per class. Each rule is tested on
// the good case (still works) and the bad case (refused / pruned), L34.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { handlers } from "../src/app.ts";
import * as store from "../src/store.ts";
import { AGENT, ctxFor, memoryDb, migrate } from "./helpers.ts";

const h = handlers as Record<string, { run(input: any, ctx: any): Promise<any> }>;
const notFound = (e: unknown) => (e as TbError).code === "item_not_found" && (e as TbError).httpStatus === 404;

const CREATIVE = { type: "app", id: "ins_01J00000000000000000000C01", name: "Creative", mode: "free", product: "creative" } as const;
const CREATIVE_2 = { ...CREATIVE, id: "ins_01J00000000000000000000C02" } as const;
const SAME_INSTANCE_OTHER_PRODUCT = { ...CREATIVE, product: "kanban" } as const;
const NO_PRODUCT = { type: "app", id: CREATIVE.id, name: "Creative", mode: "free" } as const;
/** an agent whose id equals the app's instance id: the type must still not match */
const AGENT_SAME_ID = { type: "agent", id: CREATIVE.id, name: "Creative", mode: "free" } as const;

const NOW = Date.parse("2026-10-18T10:00:00Z");

async function appItem(db: ReturnType<typeof memoryDb>) {
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "Which palette?" }, ctxFor(db, CREATIVE));
  return itemId as string;
}

test("S4-7 good case: the raising app (same instance, same verified product) reads and replies to its own item", async () => {
  const db = memoryDb();
  const id = await appItem(db);
  const s = await h.inbox_status.run({ itemId: id }, ctxFor(db, CREATIVE));
  assert.deepEqual([s.status, s.kind], ["open", "question"]);
  const r = await h.inbox_reply.run({ itemId: id, message: "Option B is the brand palette." }, ctxFor(db, CREATIVE));
  assert.equal(r.itemId, id);
  assert.equal(store.get(db, id, NOW + 1).version, 2);
});

test("S4-7 bad cases: another instance, another product on the same instance, no product, or another caller type reads unknown and cannot reply", async () => {
  const db = memoryDb();
  const id = await appItem(db);
  for (const who of [CREATIVE_2, SAME_INSTANCE_OTHER_PRODUCT, NO_PRODUCT, AGENT_SAME_ID]) {
    const s = await h.inbox_status.run({ itemId: id }, ctxFor(db, who));
    assert.deepEqual(s, { itemId: id, kind: null, status: "unknown", seenByOwner: false, response: null, message: null, decidedAt: null, expiresAt: null }, `${who.type} ${who.id} ${"product" in who ? who.product : "-"}`);
    await assert.rejects(h.inbox_reply.run({ itemId: id, message: "x" }, ctxFor(db, who)), notFound);
  }
  assert.equal(store.get(db, id, NOW + 1).version, 1, "no reply was added");
});

test("S4-7: an agent's item does not answer an app that carries the agent's id", async () => {
  const db = memoryDb();
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "Mine" }, ctxFor(db, AGENT));
  assert.equal((await h.inbox_status.run({ itemId }, ctxFor(db, AGENT))).status, "open");
  const asApp = { type: "app", id: AGENT.id, name: "Scout", mode: "free", product: "creative" } as const;
  assert.equal((await h.inbox_status.run({ itemId }, ctxFor(db, asApp))).status, "unknown");
});

test("S4-7 upgrade: an app item from 0.2.9 (no recorded product) still answers its raising instance, not another one", async () => {
  const db = memoryDb(1);
  db.prepare(
    `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at)
     VALUES ('itm_old_app', 'question', 'Old app item', NULL, '["answer","clarify"]', 'app', ?, 'Creative', 'open', 'normal', 1, NULL, NULL, ?, ?, ?)`,
  ).run(CREATIVE.id, NOW - 1000, NOW - 1000, NOW + 86_400_000);
  migrate(db, 2);
  migrate(db, 3);
  migrate(db, 4);
  migrate(db, 5);
  assert.equal(store.status(db, { type: "app", id: CREATIVE.id, product: "creative" }, "itm_old_app").status, "open");
  assert.equal(store.status(db, { type: "app", id: CREATIVE.id, product: null }, "itm_old_app").status, "open", "the instance id is verified too");
  assert.equal(store.status(db, { type: "app", id: CREATIVE_2.id, product: "creative" }, "itm_old_app").status, "unknown");
  assert.equal(store.status(db, { type: "agent", id: CREATIVE.id, product: null }, "itm_old_app").status, "unknown");
});

// ── S4-4 ──

function refused(db: ReturnType<typeof memoryDb>, n: number, detail: string, start: number, actor = "ins_01J00000000000000000000X01") {
  const ins = db.prepare(
    "INSERT INTO inbox_activity (id, item_id, kind, actor_type, actor_id, actor_product, actor_name, detail, created_at) VALUES (?, ?, 'withdraw_refused', 'app', ?, 'kanban', 'Kanban', ?, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(`act_${detail}_${actor}_${String(i).padStart(6, "0")}`, `itm_${i}`, actor, detail, start + i);
  });
}
const count = (db: ReturnType<typeof memoryDb>, where: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM inbox_activity WHERE ${where}`).get()?.n);

test("S4-4 good case: rows under the caps and younger than REFUSAL_KEEP_MS stay", () => {
  const db = memoryDb();
  refused(db, 30, "unknown_item", NOW - 1000);
  refused(db, 30, "not_raiser", NOW - 1000);
  assert.equal(store.pruneActivity(db, NOW), 0);
  assert.equal(count(db, "1 = 1"), 60);
});

test("S4-4: refused rows older than 30 days go, younger ones stay", () => {
  const db = memoryDb();
  assert.equal(store.REFUSAL_KEEP_MS, 30 * 86_400_000);
  refused(db, 3, "not_raiser", NOW - store.REFUSAL_KEEP_MS - 10, "ins_old");
  refused(db, 3, "not_raiser", NOW - store.REFUSAL_KEEP_MS + 10_000, "ins_young");
  assert.equal(store.pruneActivity(db, NOW), 3);
  assert.equal(count(db, "actor_id = 'ins_young'"), 3);
});

test("S4-4 bad case: many actors over the caps → only the newest rows per class stay; junk ids never push out real-item probes; withdraw rows stay", async () => {
  const db = memoryDb();
  const id = await appItem(db);
  await h.inbox_withdraw.run({ itemId: id, reason: "done" }, ctxFor(db, CREATIVE));
  // older real-item probes first, then a later flood of junk ids from many actors
  for (let a = 0; a < 6; a++) refused(db, 1000, "not_raiser", NOW - 100_000 + a * 1000, `ins_real_${a}`);
  for (let a = 0; a < 30; a++) refused(db, 100, "unknown_item", NOW - 10_000 + a * 100, `ins_junk_${a}`);
  refused(db, 50, "no_product", NOW - 5000, "ins_noprod");
  const before = count(db, "kind = 'withdraw_refused'");
  const removed = store.pruneActivity(db, NOW);
  assert.equal(count(db, "kind = 'withdraw_refused' AND detail = 'unknown_item'"), store.REFUSAL_CAP_UNKNOWN);
  assert.equal(count(db, "kind = 'withdraw_refused' AND detail <> 'unknown_item'"), store.REFUSAL_CAP);
  assert.equal(removed, before - store.REFUSAL_CAP_UNKNOWN - store.REFUSAL_CAP);
  assert.equal(count(db, "actor_id = 'ins_noprod'"), 50, "the newest real-class rows stay");
  assert.equal(count(db, "actor_id = 'ins_junk_29'"), 100, "the newest junk rows stay");
  assert.equal(count(db, "actor_id = 'ins_junk_0'"), 0, "the oldest junk rows go");
  assert.equal(count(db, "kind = 'withdrawn'"), 1, "the withdraw row is history and stays");
  assert.equal(store.get(db, id, NOW).withdrawal?.reason, "done");
  // the owner's view still loads
  assert.ok(Array.isArray(store.get(db, id, NOW).activity));
  assert.equal(store.pruneActivity(db, NOW), 0, "a second prune changes nothing");
});

test("S4-7 pinned: a row without a recorded product (empty or NULL) answers its instance id whatever the caller's product; only an instance id collision could cross products", () => {
  const db = memoryDb();
  const ins = db.prepare(
    `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, from_product, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at)
     VALUES (?, 'question', 'No product', NULL, '["answer","clarify"]', 'app', ?, 'Creative', ?, 'open', 'normal', 1, NULL, NULL, ?, ?, ?)`,
  );
  ins.run("itm_empty", CREATIVE.id, "", NOW, NOW, NOW + 86_400_000);
  ins.run("itm_null", CREATIVE.id, null, NOW, NOW, NOW + 86_400_000);
  for (const id of ["itm_empty", "itm_null"]) {
    assert.equal(store.status(db, { type: "app", id: CREATIVE.id, product: "kanban" }, id).status, "open", id);
    assert.equal(store.status(db, { type: "app", id: CREATIVE_2.id, product: "creative" }, id).status, "unknown", id);
  }
});

test("S4-7: an app that asks with an empty product records none (the store keeps its own invariant)", () => {
  const db = memoryDb();
  const item = store.ask(db, { type: "app", id: CREATIVE.id, name: "Creative", product: "" }, { kind: "question", title: "x" }, NOW);
  assert.equal(db.prepare("SELECT from_product FROM inbox_items WHERE id = ?").get(item.id)?.from_product, null);
});

test("S4-4 boundaries: exactly at each cap nothing goes; one over the cap removes exactly the oldest row of that class", () => {
  const db = memoryDb();
  refused(db, store.REFUSAL_CAP_UNKNOWN, "unknown_item", NOW - 50_000, "ins_j");
  refused(db, store.REFUSAL_CAP, "not_raiser", NOW - 50_000, "ins_r");
  assert.equal(store.pruneActivity(db, NOW), 0);
  refused(db, 1, "unknown_item", NOW - 1, "ins_j2");
  refused(db, 1, "not_raiser", NOW - 1, "ins_r2");
  assert.equal(store.pruneActivity(db, NOW), 2);
  assert.equal(count(db, "id = 'act_unknown_item_ins_j_000000'"), 0, "the oldest junk row went");
  assert.equal(count(db, "id = 'act_not_raiser_ins_r_000000'"), 0, "the oldest real row went");
  assert.equal(count(db, "actor_id IN ('ins_j2', 'ins_r2')"), 2, "the newest rows stay");
});

test("S4-4: age and cap together — old rows go first, then the cap counts only the young rows", () => {
  const db = memoryDb();
  refused(db, 100, "not_raiser", NOW - store.REFUSAL_KEEP_MS - 1000, "ins_old");
  refused(db, store.REFUSAL_CAP, "not_raiser", NOW - 50_000, "ins_young");
  assert.equal(store.pruneActivity(db, NOW), 100);
  assert.equal(count(db, "actor_id = 'ins_young'"), store.REFUSAL_CAP);
});

test("S4-4: a no-product app refused on made-up ids is recorded as junk, so it cannot push out probes of real items", async () => {
  const db = memoryDb();
  const id = await appItem(db);
  await assert.rejects(h.inbox_withdraw.run({ itemId: "itm_made_up" }, ctxFor(db, NO_PRODUCT)));
  await assert.rejects(h.inbox_withdraw.run({ itemId: id }, ctxFor(db, NO_PRODUCT)));
  const rows = db.prepare("SELECT item_id, detail FROM inbox_activity ORDER BY item_id").all();
  assert.deepEqual(
    rows.map((r) => [r.item_id, r.detail]),
    [
      [id, "no_product"],
      ["itm_made_up", "unknown_item"],
    ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  );
});
