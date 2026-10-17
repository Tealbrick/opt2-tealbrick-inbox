// inbox_withdraw (OD-1): the raiser closes its own open item. Handler and store level: the identity rules (verified product
// + instance for an app, the agent id for an agent), the no-oracle answer, idempotency, the not_open answer, the audit
// rows and their throttle, the upgrade of a 0.2.9 database. The same rules against the real SDK and a bridge: withdraw-real.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { clock, handlers } from "../src/app.ts";
import * as store from "../src/store.ts";
import { AGENT, ctxFor, memoryDb, migrate, OTHER, OWNER } from "./helpers.ts";

const h = handlers as Record<string, { run(input: any, ctx: any): Promise<any> }>;
const code = (c: string, status?: number) => (e: unknown) => {
  assert.equal((e as TbError).code, c);
  if (status) assert.equal((e as TbError).httpStatus, status);
  return true;
};

const CREATIVE = { type: "app", id: "ins_01J00000000000000000000C01", name: "Creative", mode: "free", product: "creative" } as const;
/** the same product, another instance */
const CREATIVE_2 = { ...CREATIVE, id: "ins_01J00000000000000000000C02" } as const;
/** another product */
const OTHER_APP = { type: "app", id: "ins_01J00000000000000000000D01", name: "Creative", mode: "free", product: "kanban" } as const;
/** the raising instance id, but a different verified product (an instance id belongs to one product; this must still not match) */
const SAME_INSTANCE_OTHER_PRODUCT = { ...CREATIVE, product: "kanban" } as const;
/** an app caller whose product the SDK could not verify (it refuses such a call itself; the handler fails closed too) */
const NO_PRODUCT = { type: "app", id: CREATIVE.id, name: "Creative", mode: "free" } as const;

const UNKNOWN = (itemId: string) => ({ itemId, result: "unknown", status: "unknown" });
const NOW = Date.parse("2026-10-18T10:00:00Z");

function withClock<T>(fn: (set: (t: number) => void) => Promise<T>): Promise<T> {
  const real = clock.now;
  let now = NOW;
  clock.now = () => now;
  return fn((t) => {
    now = t;
  }).finally(() => {
    clock.now = real;
  });
}

const ask = (db: ReturnType<typeof memoryDb>, who: Parameters<typeof ctxFor>[1], title = "Approve the draft?") =>
  h.inbox_ask.run({ kind: "approval", title, context: "Checkpoint in Creative" }, ctxFor(db, who)) as Promise<{ itemId: string }>;
const activity = (db: ReturnType<typeof memoryDb>) => db.prepare("SELECT * FROM inbox_activity ORDER BY created_at, id").all();

test("the raising app withdraws: the item is expired with the reason, gone from the open list, and the badge count drops", async () => {
  await withClock(async (set) => {
    const db = memoryDb();
    const pushes = { pushes: 0 };
    const asked = await ask(db, CREATIVE);
    const me = ctxFor(db, OWNER);
    assert.equal((await h.items_list.run({}, me)).items.length, 1);
    assert.equal(store.waitingCount(db, NOW), 1);

    set(NOW + 5000);
    const out = await h.inbox_withdraw.run({ itemId: asked.itemId, reason: "Answered in Creative." }, ctxFor(db, CREATIVE, undefined, { status: pushes }));
    assert.deepEqual(out, { itemId: asked.itemId, result: "withdrawn", status: "expired" });
    assert.equal(pushes.pushes, 1, "the TBD badge is told");

    const status = await h.inbox_status.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE));
    assert.deepEqual([status.status, status.response, status.message], ["expired", null, null], "the raiser reads expired, never an approval");
    const open = await h.items_list.run({}, me);
    assert.deepEqual(open.items, []);
    assert.equal(open.counts.pending, 0);
    assert.equal(store.waitingCount(db, NOW + 5000), 0);
    const done = await h.items_list.run({ view: "done" }, me);
    assert.deepEqual(
      done.items.map((i: { id: string; status: string; withdrawn: boolean }) => [i.id, i.status, i.withdrawn]),
      [[asked.itemId, "expired", true]],
    );
    const full = await h.item_get.run({ itemId: asked.itemId }, me);
    assert.deepEqual(full.withdrawal, { at: new Date(NOW + 5000).toISOString(), reason: "Answered in Creative." });
    assert.equal(full.from.name, "Creative");
    // the owner cannot answer a withdrawn item
    await assert.rejects(h.item_decide.run({ itemId: asked.itemId, version: full.version, response: "approve" }, me), code("item_expired", 409));
    await assert.rejects(h.inbox_reply.run({ itemId: asked.itemId, message: "late" }, ctxFor(db, CREATIVE)), code("item_closed", 409));
  });
});

test("same product but another instance: the same answer as for an id that does not exist", async () => {
  const db = memoryDb();
  const asked = await ask(db, CREATIVE);
  const refused = await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE_2));
  const nothing = await h.inbox_withdraw.run({ itemId: "itm_01J00000000000000000000000" }, ctxFor(db, CREATIVE_2));
  assert.deepEqual(refused, UNKNOWN(asked.itemId));
  assert.deepEqual({ ...refused, itemId: "x" }, { ...nothing, itemId: "x" }, "identical shape and values for a real item and a missing one");
  assert.equal((await h.items_list.run({}, ctxFor(db, OWNER))).items.length, 1, "the item is still open");
});

test("a different product, or the right instance with a different product: the same answer as unknown", async () => {
  const db = memoryDb();
  const asked = await ask(db, CREATIVE);
  assert.deepEqual(await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, OTHER_APP)), UNKNOWN(asked.itemId));
  assert.deepEqual(await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, SAME_INSTANCE_OTHER_PRODUCT)), UNKNOWN(asked.itemId));
  assert.equal(store.get(db, asked.itemId, NOW).status, "open");
});

test("an agent cannot withdraw an app's item, and an app cannot withdraw an agent's", async () => {
  const db = memoryDb();
  const byApp = await ask(db, CREATIVE);
  const byAgent = await ask(db, AGENT, "Agent question");
  assert.deepEqual(await h.inbox_withdraw.run({ itemId: byApp.itemId }, ctxFor(db, AGENT)), UNKNOWN(byApp.itemId));
  assert.deepEqual(await h.inbox_withdraw.run({ itemId: byAgent.itemId }, ctxFor(db, CREATIVE)), UNKNOWN(byAgent.itemId));
  assert.equal(store.get(db, byApp.itemId, NOW).status, "open");
  assert.equal(store.get(db, byAgent.itemId, NOW).status, "open");
});

test("an app caller with no verified product is refused (fail closed) and the item is untouched; the owner sees the attempt", async () => {
  await withClock(async () => {
    const db = memoryDb();
    const asked = await ask(db, CREATIVE);
    await assert.rejects(h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, NO_PRODUCT)), code("caller_unverified", 403));
    // an empty product string is no product either
    await assert.rejects(h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, { ...NO_PRODUCT, product: "" })), code("caller_unverified", 403));
    assert.equal(store.get(db, asked.itemId, NOW).status, "open");
    const full = store.get(db, asked.itemId, NOW);
    assert.deepEqual(
      full.activity.map((a) => [a.kind, a.actor.type, a.actor.id, a.actor.product, a.detail]),
      [["withdraw_refused", "app", CREATIVE.id, null, "no_product"]],
      "throttled: the second identical attempt writes no second row",
    );
  });
});

test("an app that asked without a verified product can never be matched later", async () => {
  const db = memoryDb();
  const asked = await ask(db, NO_PRODUCT);
  assert.equal(db.prepare("SELECT from_product FROM inbox_items WHERE id = ?").get(asked.itemId)?.from_product, null);
  // not even the same instance with some product matches a row that has none
  assert.deepEqual(await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE)), UNKNOWN(asked.itemId));
});

test("the raising agent withdraws its own item; another agent gets unknown", async () => {
  const db = memoryDb();
  const asked = await ask(db, AGENT);
  assert.deepEqual(await h.inbox_withdraw.run({ itemId: asked.itemId, reason: "No longer needed" }, ctxFor(db, OTHER)), UNKNOWN(asked.itemId));
  assert.deepEqual(await h.inbox_withdraw.run({ itemId: asked.itemId, reason: "No longer needed" }, ctxFor(db, AGENT)), { itemId: asked.itemId, result: "withdrawn", status: "expired" });
  assert.equal((await h.inbox_status.run({ itemId: asked.itemId }, ctxFor(db, AGENT))).status, "expired");
  const row = db.prepare("SELECT actor_type, actor_id, actor_product FROM inbox_activity WHERE kind = 'withdrawn'").get();
  assert.deepEqual({ ...row }, { actor_type: "agent", actor_id: AGENT.id, actor_product: null });
});

test("a person is not a raiser: the owner cannot withdraw through this op", async () => {
  const db = memoryDb();
  const asked = await ask(db, AGENT);
  await assert.rejects(h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, OWNER)), code("agent_only", 403));
  assert.equal(store.get(db, asked.itemId, NOW).status, "open");
});

test("idempotent: a second withdraw returns the same answer and changes nothing (first reason, one history row)", async () => {
  await withClock(async (set) => {
    const db = memoryDb();
    const asked = await ask(db, CREATIVE);
    set(NOW + 1000);
    const first = await h.inbox_withdraw.run({ itemId: asked.itemId, reason: "first reason" }, ctxFor(db, CREATIVE));
    set(NOW + 9000);
    const again = await h.inbox_withdraw.run({ itemId: asked.itemId, reason: "another reason" }, ctxFor(db, CREATIVE));
    assert.deepEqual(again, first);
    const full = store.get(db, asked.itemId, NOW + 9000);
    assert.deepEqual(full.withdrawal, { at: new Date(NOW + 1000).toISOString(), reason: "first reason" });
    assert.equal(full.activity.filter((a) => a.kind === "withdrawn").length, 1);
    assert.equal(full.updatedAt, new Date(NOW + 1000).toISOString());
  });
});

test("an item the owner already decided answers not_open with its status and is not changed", async () => {
  const db = memoryDb();
  const asked = await ask(db, CREATIVE);
  const me = ctxFor(db, OWNER);
  const got = await h.item_get.run({ itemId: asked.itemId }, me);
  await h.item_decide.run({ itemId: asked.itemId, version: got.version, response: "approve" }, me);
  const out = await h.inbox_withdraw.run({ itemId: asked.itemId, reason: "too late" }, ctxFor(db, CREATIVE));
  assert.deepEqual(out, { itemId: asked.itemId, result: "not_open", status: "answered" });
  const after = store.get(db, asked.itemId, NOW);
  assert.equal(after.status, "answered");
  assert.equal(after.withdrawal, null);
  assert.deepEqual(after.activity, []);
  assert.equal((await h.inbox_status.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE))).response, "approve");
});

test("an item that expired by time answers not_open expired; a withdraw never revives or relabels it", async () => {
  await withClock(async (set) => {
    const db = memoryDb();
    const asked = await h.inbox_ask.run({ kind: "question", title: "Lunch?", expiresInS: 60 }, ctxFor(db, CREATIVE));
    set(NOW + 61_000);
    assert.deepEqual(await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE)), { itemId: asked.itemId, result: "not_open", status: "expired" });
    assert.equal(store.get(db, asked.itemId, NOW + 61_000).withdrawal, null, "a timeout is not shown as a withdrawal");
  });
});

test("audit: a withdraw row carries the verified product and instance; refused attempts are rows too, throttled, and shown in the item history", async () => {
  await withClock(async (set) => {
    const db = memoryDb();
    const asked = await ask(db, CREATIVE);
    const other = await ask(db, CREATIVE, "Another");
    // refused attempts: same actor + same item inside 10 minutes = one row
    for (let i = 0; i < 4; i++) await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, OTHER_APP));
    set(NOW + store.REFUSAL_SAME_ITEM_MS + 1);
    await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, OTHER_APP));
    await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE_2));
    const rows = store.get(db, asked.itemId, NOW + store.REFUSAL_SAME_ITEM_MS + 1).activity;
    assert.deepEqual(
      rows.map((a) => [a.kind, a.actor.id, a.actor.product, a.detail]),
      [
        ["withdraw_refused", OTHER_APP.id, "kanban", "not_raiser"],
        ["withdraw_refused", OTHER_APP.id, "kanban", "not_raiser"],
        ["withdraw_refused", CREATIVE_2.id, "creative", "not_raiser"],
      ],
    );

    await h.inbox_withdraw.run({ itemId: asked.itemId, reason: "done" }, ctxFor(db, CREATIVE));
    const full = store.get(db, asked.itemId, NOW + store.REFUSAL_SAME_ITEM_MS + 2);
    const w = full.activity.find((a) => a.kind === "withdrawn");
    assert.deepEqual({ type: w?.actor.type, id: w?.actor.id, product: w?.actor.product, name: w?.actor.name, detail: w?.detail }, { type: "app", id: CREATIVE.id, product: "creative", name: "Creative", detail: "done" });
    assert.equal(store.get(db, other.itemId, NOW).activity.length, 0, "history is per item");
  });
});

test("audit throttle: one actor writes at most REFUSAL_PER_ACTOR_HOUR refused rows per hour, then the rows resume; the answer never changes", async () => {
  await withClock(async (set) => {
    const db = memoryDb();
    for (let i = 0; i < store.REFUSAL_PER_ACTOR_HOUR + 10; i++) {
      const out = await h.inbox_withdraw.run({ itemId: `itm_missing_${i}` }, ctxFor(db, OTHER_APP));
      assert.equal(out.result, "unknown");
    }
    assert.equal(activity(db).length, store.REFUSAL_PER_ACTOR_HOUR);
    set(NOW + 3600_000 + 1);
    await h.inbox_withdraw.run({ itemId: "itm_missing_after" }, ctxFor(db, OTHER_APP));
    assert.equal(activity(db).length, store.REFUSAL_PER_ACTOR_HOUR + 1);
    // the background tick removes refused-attempt rows after 90 days; withdraw rows stay
    const asked = await ask(db, CREATIVE);
    await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE));
    assert.equal(store.pruneActivity(db, NOW + 3600_000 + 1 + store.REFUSAL_KEEP_MS + 1), store.REFUSAL_PER_ACTOR_HOUR + 1);
    assert.deepEqual(
      activity(db).map((r) => r.kind),
      ["withdrawn"],
    );
  });
});

test("an alert DM that has not been sent yet is stopped by the withdraw", async () => {
  const db = memoryDb();
  const asked = await ask(db, CREATIVE);
  const ins = (id: string, status: string) =>
    db
      .prepare("INSERT INTO inbox_deliveries (id, item_id, channel, op, input, idem_key, status, hold_id, error, attempts, next_at, created_at, updated_at) VALUES (?, ?, 'buzz', 'buzz_dm', '{}', ?, ?, NULL, NULL, 0, 0, 0, 0)")
      .run(id, asked.itemId, `k-${id}`, status);
  ins("dlv_pending", "pending");
  ins("dlv_held", "held");
  ins("dlv_sent", "sent");
  await h.inbox_withdraw.run({ itemId: asked.itemId }, ctxFor(db, CREATIVE));
  const d = store.get(db, asked.itemId, NOW).deliveries.map((x) => [x.id, x.status, x.error]);
  assert.deepEqual(d, [
    ["dlv_held", "failed", "withdrawn"],
    ["dlv_pending", "failed", "withdrawn"],
    ["dlv_sent", "sent", null],
  ]);
});

test("the reason is kept as written (markup stays text), trimmed, and capped", async () => {
  const db = memoryDb();
  const asked = await ask(db, CREATIVE);
  const reason = `  <img src=x onerror=alert(1)> & "quotes"  `;
  await h.inbox_withdraw.run({ itemId: asked.itemId, reason }, ctxFor(db, CREATIVE));
  assert.equal(store.get(db, asked.itemId, NOW).withdrawal?.reason, reason.trim());
  const second = await ask(db, CREATIVE, "again");
  await h.inbox_withdraw.run({ itemId: second.itemId, reason: "   " }, ctxFor(db, CREATIVE));
  assert.equal(store.get(db, second.itemId, NOW).withdrawal?.reason, null, "blank = no reason");
});

test("upgrade from a 0.2.9 database: old rows load, an old agent item can be withdrawn by its agent, an old app item cannot be withdrawn by an app", async () => {
  const db = memoryDb(1);
  const insert = db.prepare(
    `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at)
     VALUES (?, 'approval', ?, NULL, '["approve","deny","clarify"]', ?, ?, ?, ?, 'normal', 1, NULL, NULL, ?, ?, ?)`,
  );
  const far = NOW + 7 * 86_400_000;
  insert.run("itm_old_agent", "Old agent item", "agent", AGENT.id, "Scout", "open", NOW - 1000, NOW - 1000, far);
  insert.run("itm_old_app", "Old app item", "app", CREATIVE.id, "Creative", "open", NOW - 1000, NOW - 1000, far);
  insert.run("itm_old_done", "Old answered", "agent", AGENT.id, "Scout", "answered", NOW - 2000, NOW - 1500, far);
  db.prepare("INSERT INTO inbox_decisions (id, item_id, response, message, decided_by, decided_at, item_version) VALUES ('dcs_1', 'itm_old_done', 'approve', NULL, ?, ?, 1)").run(OWNER.id, NOW - 1500);

  migrate(db, 2);

  // the owner's view loads the old rows with the new fields at their neutral values
  const listed = store.list(db, "all", 50, 0, NOW);
  assert.equal(listed.items.length, 3);
  assert.ok(listed.items.every((i) => i.withdrawn === false));
  const old = store.get(db, "itm_old_app", NOW);
  assert.deepEqual([old.withdrawal, old.activity], [null, []]);
  assert.equal(db.prepare("SELECT from_product FROM inbox_items WHERE id = 'itm_old_app'").get()?.from_product, null);

  assert.deepEqual(store.withdraw(db, { ...CREATIVE }, "itm_old_app", "x", NOW), { itemId: "itm_old_app", result: "unknown", status: "unknown" }, "no recorded product: an app cannot withdraw it");
  assert.deepEqual(store.withdraw(db, { ...NO_PRODUCT, product: null }, "itm_old_app", "x", NOW).result, "unknown");
  assert.deepEqual(store.withdraw(db, { ...OTHER, product: null }, "itm_old_agent", "x", NOW).result, "unknown");
  assert.deepEqual(store.withdraw(db, { ...AGENT, product: null }, "itm_old_agent", "no longer needed", NOW), { itemId: "itm_old_agent", result: "withdrawn", status: "expired" });
  assert.deepEqual(store.withdraw(db, { ...AGENT, product: null }, "itm_old_done", "x", NOW), { itemId: "itm_old_done", result: "not_open", status: "answered" });
  // the old app item stays open until the owner or the clock closes it
  assert.equal(store.get(db, "itm_old_app", NOW).status, "open");
  // new asks record the product, and then the same app can withdraw
  const fresh = store.ask(db, { type: "app", id: CREATIVE.id, name: "Creative", product: "creative" }, { kind: "question", title: "New" }, NOW);
  assert.equal(store.withdraw(db, { ...CREATIVE }, fresh.id, undefined, NOW).result, "withdrawn");
});
