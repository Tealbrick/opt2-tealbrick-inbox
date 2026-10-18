// R5 (inbox_ask `open {path}`): an app with a verified product links its item to one of its own pages. The link always
// names the RECORDED verified product (never input), the path passes the shared launch-path rule, and every other
// caller is refused for the whole call (fail closed). Good cases and bad cases, L34.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { handlers } from "../src/app.ts";
import * as store from "../src/store.ts";
import { AGENT, ctxFor, memoryDb, migrate, OWNER, PORTAL, WS } from "./helpers.ts";

const h = handlers as Record<string, { run(input: any, ctx: any): Promise<any> }>;
const code = (c: string, status: number) => (e: unknown) => {
  assert.equal((e as TbError).code, c);
  assert.equal((e as TbError).httpStatus, status);
  return true;
};

const OBSERVER = { type: "app", id: "ins_01J00000000000000000000E01", name: "Observer", mode: "free", product: "observer" } as const;
const NO_PRODUCT = { type: "app", id: OBSERVER.id, name: "Observer", mode: "free" } as const;
/** the SDK names an app caller with its instance id when the slice has no name for it */
const UNNAMED = { ...OBSERVER, name: OBSERVER.id } as const;
const count = (db: ReturnType<typeof memoryDb>) => Number(db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get()?.n);
const link = (product: string, path: string) => `${PORTAL}/w/${WS}/open?product=${product}&path=${encodeURIComponent(path)}`;

test("R5 good case: the app's page is stored and item_get shows Open in <app> through its verified product", async () => {
  const db = memoryDb();
  for (const path of ["/review/rec_01J00000000000000000000001", "/review", "/sources"]) {
    const { itemId } = await h.inbox_ask.run({ kind: "question", title: "3 records wait for review", open: { path } }, ctxFor(db, OBSERVER));
    const got = await h.item_get.run({ itemId }, ctxFor(db, OWNER));
    assert.deepEqual(got.open, { url: link("observer", path), app: "Observer" }, path);
  }
});

test("R5: an item without open, and an agent's item, show no link", async () => {
  const db = memoryDb();
  const a = await h.inbox_ask.run({ kind: "question", title: "plain" }, ctxFor(db, OBSERVER));
  const b = await h.inbox_ask.run({ kind: "question", title: "agent" }, ctxFor(db, AGENT));
  assert.equal((await h.item_get.run({ itemId: a.itemId }, ctxFor(db, OWNER))).open, null);
  assert.equal((await h.item_get.run({ itemId: b.itemId }, ctxFor(db, OWNER))).open, null);
});

test("R5 bad cases: an agent, an app without a verified product, and a path the launch rule refuses are refused; nothing is stored", async () => {
  const db = memoryDb();
  await assert.rejects(h.inbox_ask.run({ kind: "question", title: "x", open: { path: "/review" } }, ctxFor(db, AGENT)), code("open_not_allowed", 400));
  await assert.rejects(h.inbox_ask.run({ kind: "question", title: "x", open: { path: "/review" } }, ctxFor(db, NO_PRODUCT)), code("caller_unverified", 403));
  for (const path of ["https://evil.example/x", "//evil.example/x", "/a/../b", "review", "/a\\b", "/a\nb", "/%2F%2Fevil.example", "/a/%2e%2e/b", "/%5Cevil", "/a%00b"])
    await assert.rejects(h.inbox_ask.run({ kind: "question", title: "x", open: { path } }, ctxFor(db, OBSERVER)), code("path_invalid", 400), JSON.stringify(path));
  assert.equal(count(db), 0);
});

test("R5: no Portal URL yet → no link (never a half-built URL); the label falls back to the product id when the slice gave no name", async () => {
  const db = memoryDb();
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "x", open: { path: "/review" } }, ctxFor(db, UNNAMED));
  assert.equal((await h.item_get.run({ itemId }, ctxFor(db, OWNER, undefined, { portal: false }))).open, null);
  assert.deepEqual((await h.item_get.run({ itemId }, ctxFor(db, OWNER))).open, { url: link("observer", "/review"), app: "observer" });
});

test("R5 store invariant: a path is never stored without a verified app product, and a stored bad row never links", () => {
  const db = memoryDb();
  const ag = store.ask(db, { type: "agent", id: AGENT.id, name: "Scout" }, { kind: "question", title: "x", open: { path: "/review" } }, 1);
  const np = store.ask(db, { type: "app", id: OBSERVER.id, name: "Observer", product: null }, { kind: "question", title: "x", open: { path: "/review" } }, 1);
  for (const id of [ag.id, np.id]) assert.equal(db.prepare("SELECT open_path FROM inbox_items WHERE id = ?").get(id)?.open_path, null);
  // a row that holds a bad path (e.g. written by hand) is not linked: the SDK builder refuses it and Inbox shows nothing
  const ok = store.ask(db, { type: "app", id: OBSERVER.id, name: "Observer", product: "observer" }, { kind: "question", title: "x", open: { path: "/review" } }, 1);
  db.prepare("UPDATE inbox_items SET open_path = '//evil.example' WHERE id = ?").run(ok.id);
  const lf = ctxFor(db, OWNER) as unknown as { ownerLinkFor: store.LinkFor };
  assert.equal(store.get(db, ok.id, 2, lf.ownerLinkFor).open, null);
});

test("R5 upgrade: a 0.3.0 database takes migration 0003; old rows load with no link", async () => {
  const db = memoryDb(2);
  db.prepare(
    `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, from_product, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at)
     VALUES ('itm_old', 'question', 'Old', NULL, '["answer","clarify"]', 'app', ?, 'Observer', 'observer', 'open', 'normal', 1, NULL, NULL, 1, 1, ?)`,
  ).run(OBSERVER.id, Date.now() + 86_400_000);
  migrate(db, 3);
  migrate(db, 4);
  const got = await h.item_get.run({ itemId: "itm_old" }, ctxFor(db, OWNER));
  assert.equal(got.open, null);
  assert.equal(got.title, "Old");
});

test("R5: the store refuses a bad page itself, whoever calls it", () => {
  const db = memoryDb();
  assert.throws(() => store.ask(db, { type: "app", id: OBSERVER.id, name: "Observer", product: "observer" }, { kind: "question", title: "x", open: { path: "//evil.example" } }, 1), code("path_invalid", 400));
  assert.equal(count(db), 0);
});

test("R5: a stored page without a recorded product never links; a refused stored page is logged without the path", async () => {
  const db = memoryDb();
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "x", open: { path: "/review" } }, ctxFor(db, OBSERVER));
  db.prepare("UPDATE inbox_items SET from_product = NULL WHERE id = ?").run(itemId);
  assert.equal((await h.item_get.run({ itemId }, ctxFor(db, OWNER))).open, null);

  db.prepare("UPDATE inbox_items SET from_product = 'observer', open_path = '//evil.example/secret' WHERE id = ?").run(itemId);
  const warned: unknown[] = [];
  const ctx = { ...ctxFor(db, OWNER), log: { debug() {}, info() {}, error() {}, warn: (...a: unknown[]) => warned.push(a) } };
  assert.equal((await h.item_get.run({ itemId }, ctx)).open, null);
  assert.equal(warned.length, 1);
  assert.ok(!JSON.stringify(warned).includes("secret"), "the log never carries the path");
});

test("R5: the link stays on the item after the owner decides (the history still points to the app page)", async () => {
  const db = memoryDb();
  const { itemId } = await h.inbox_ask.run({ kind: "question", title: "x", open: { path: "/review" } }, ctxFor(db, OBSERVER));
  await h.item_decide.run({ itemId, response: "answer", message: "Done.", version: 1 }, ctxFor(db, OWNER));
  const got = await h.item_get.run({ itemId }, ctxFor(db, OWNER));
  assert.equal(got.status, "answered");
  assert.deepEqual(got.open, { url: link("observer", "/review"), app: "Observer" });
});
