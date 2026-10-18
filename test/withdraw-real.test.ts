// inbox_withdraw against the REAL Miniapp SDK (claim, slice, grant and call-proof verification, receipts, idempotency,
// migrations) driven by the conformance fake bridge, which signs agent and companion-app calls like the bridge does.
// An app caller's product is the one the SDK verified from the companion grant's `prd` (miniapp-sdk 0.1.28), so this is
// the test of "who is the raiser" as production sees it. Handler-level rules: withdraw.test.ts.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type AppClient, appEnv, createFakeBridge, type FakeBridge, type PersonSession, TEST_ROOTS_ENV } from "@opt2-tealbrick/conformance";
import { ulid } from "@opt2-tealbrick/manifest";
import { defineApp, type Json, startApp } from "@opt2-tealbrick/miniapp-sdk";
import start from "../conformance.start.ts";
import { definition, manifest } from "../src/app.ts";

type Running = { url: string; stop(): Promise<void> };
type Answer = { status: number; code: string | null; body: unknown };
interface Output {
  itemId: string;
  result: string;
  status: string;
}

const insId = () => `ins_${ulid()}`;
const CREATIVE_1 = insId();
const CREATIVE_2 = insId();
const BOARD = insId();
const UNLISTED = insId();
const DAY = 86_400_000;

/** Everything a test started, stopped by `cleanup()`: idempotent, best effort, never throws (a failing hook must not leave a server running). */
const started: { apps: Running[]; bridges: FakeBridge[]; dirs: string[] } = { apps: [], bridges: [], dirs: [] };
async function cleanup(): Promise<void> {
  for (const app of started.apps.splice(0)) await app.stop().catch(() => {});
  for (const b of started.bridges.splice(0)) await b.close().catch(() => {});
  for (const d of started.dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}
after(cleanup);

async function newBridge(): Promise<FakeBridge> {
  const bridge = await createFakeBridge({ manifest });
  started.bridges.push(bridge);
  await bridge.control.publishKeySet();
  return bridge;
}
const tmp = (what: string): string => {
  const d = mkdtempSync(join(tmpdir(), `inbox-${what}-`));
  started.dirs.push(d);
  return d;
};
const envFor = (bridge: FakeBridge, dir: string) => appEnv(bridge, dir, { [TEST_ROOTS_ENV]: JSON.stringify(bridge.testRootJwks()), TBCONF_PORT: "0" });

/** The new code on a data dir (the conformance harness boot). */
async function bootNew(bridge: FakeBridge, dir: string, env = envFor(bridge, dir)): Promise<{ app: Running; client: AppClient }> {
  const app = await start(env);
  started.apps.push(app);
  await bridge.control.waitForClaim(30_000);
  await bridge.control.waitForSliceRevision(1, 30_000);
  return { app, client: bridge.client(app.url) };
}

describe("inbox_withdraw through the real SDK", () => {
  let bridge: FakeBridge;
  let client: AppClient;
  let owner: PersonSession;
  let agentA: string;
  let agentB: string;
  let n = 0;
  const key = () => `wd-${String(++n).padStart(4, "0")}-${ulid()}`;

  before(async () => {
    try {
      bridge = await newBridge();
      ({ client } = await bootNew(bridge, tmp("real")));
      agentA = bridge.ids.agents[0]?.id ?? "";
      agentB = bridge.ids.agents[1]?.id ?? "";
      assert.ok(agentA && agentB && agentA !== agentB);
      // the slice names the callers; the Task Board has the same DISPLAY name as Creative on purpose (a name is no identity)
      await bridge.control.listCompanionCaller({ product: "creative", ins: CREATIVE_1 as never, name: "Creative" });
      await bridge.control.listCompanionCaller({ product: "creative", ins: CREATIVE_2 as never, name: "Creative" });
      await bridge.control.waitForSliceRevision(await bridge.control.listCompanionCaller({ product: "kanban", ins: BOARD as never, name: "Creative" }), 30_000);
      const sess = await client.signIn();
      assert.ok(sess, "the owner signs in");
      owner = sess;
    } catch (e) {
      await cleanup();
      throw e;
    }
  });

  const asApp = (ins: string, product: string | undefined) => ({ caller: ins as never, ...(product ? { prd: product } : {}), held: [] as never[] });
  const asAgent = (agent: string) => ({ agent: agent as never });
  const call = (op: string, input: Json, who: Record<string, unknown>, idempotencyKey?: string): Promise<Answer> =>
    client.callOp(op, input, { ...who, ...(idempotencyKey ? { idempotencyKey } : {}) }) as Promise<Answer>;
  const ok = (a: Answer): Output & { receiptId?: string } => {
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const body = a.body as { status: string; output: Output; receiptId?: string };
    assert.equal(body.status, "ok");
    return { ...body.output, ...(body.receiptId ? { receiptId: body.receiptId } : {}) };
  };
  const ask = async (who: Record<string, unknown>, title = "Approve the checkpoint?"): Promise<string> =>
    ok(await call("inbox_ask", { kind: "approval", title, context: "Mirrored from a checkpoint" }, who, key())).itemId;
  const person = async (op: string, input: Json): Promise<any> => {
    const r = await client.personOp(owner, op, input);
    assert.equal(r.status, 200, JSON.stringify(r.output));
    return r.output;
  };
  const withdraw = (itemId: string, who: Record<string, unknown>, reason?: string) => call("inbox_withdraw", { itemId, ...(reason ? { reason } : {}) }, who, key());

  it("the raising app withdraws: expired with the reason, off the open list, a receipt, and the owner sees who withdrew", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    assert.ok((await person("items_list", {})).items.some((i: { id: string }) => i.id === itemId));
    const out = ok(await withdraw(itemId, asApp(CREATIVE_1, "creative"), "Answered in Creative."));
    assert.deepEqual({ itemId: out.itemId, result: out.result, status: out.status }, { itemId, result: "withdrawn", status: "expired" });
    assert.ok(out.receiptId, "a write op with receipt: true leaves a receipt");
    assert.equal(ok(await call("inbox_status", { itemId }, asApp(CREATIVE_1, "creative"))).status, "expired");
    assert.ok(!(await person("items_list", {})).items.some((i: { id: string }) => i.id === itemId), "gone from the open list");
    const full = await person("item_get", { itemId });
    assert.equal(full.status, "expired");
    assert.equal(full.withdrawal.reason, "Answered in Creative.");
    const row = full.activity.find((a: { kind: string }) => a.kind === "withdrawn");
    assert.deepEqual({ type: row.actor.type, id: row.actor.id, product: row.actor.product, name: row.actor.name }, { type: "app", id: CREATIVE_1, product: "creative", name: "Creative" });
  });

  it("same product, another instance: the same answer as an unknown id; the item stays open", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    const refused = ok(await withdraw(itemId, asApp(CREATIVE_2, "creative")));
    const missing = ok(await withdraw("itm_01J00000000000000000000000", asApp(CREATIVE_2, "creative")));
    assert.deepEqual({ ...refused, itemId: "x", receiptId: undefined }, { ...missing, itemId: "x", receiptId: undefined });
    assert.deepEqual({ result: refused.result, status: refused.status }, { result: "unknown", status: "unknown" });
    assert.equal((await person("item_get", { itemId })).status, "open");
  });

  it("a different product (even with the same display name) gets the same answer", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    const out = ok(await withdraw(itemId, asApp(BOARD, "kanban")));
    assert.deepEqual({ result: out.result, status: out.status }, { result: "unknown", status: "unknown" });
    assert.equal((await person("item_get", { itemId })).status, "open");
  });

  it("the instance of the raiser with a grant that names another product is refused by the SDK (grant and slice disagree) and nothing changes", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    const a = await withdraw(itemId, asApp(CREATIVE_1, "kanban"));
    assert.equal(a.status, 403, JSON.stringify(a.body));
    assert.equal(a.code, "grant_invalid");
    assert.equal((await person("item_get", { itemId })).status, "open");
  });

  it("an app with no product (not in the slice, grant without prd) is refused by the app (fail closed), the item stays open, the attempt is in the history", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    const a = await withdraw(itemId, asApp(UNLISTED, undefined));
    assert.deepEqual([a.status, a.code], [403, "caller_unverified"], JSON.stringify(a.body));
    const full = await person("item_get", { itemId });
    assert.equal(full.status, "open");
    assert.deepEqual(
      full.activity.map((x: { kind: string; actor: { id: string; product: string | null }; detail: string }) => [x.kind, x.actor.id, x.actor.product, x.detail]),
      [["withdraw_refused", UNLISTED, null, "no_product"]],
    );
  });

  it("an app that is in no slice but whose grant names the product (GRANT-PRD) is the raiser of its own items", async () => {
    const fresh = insId();
    const itemId = await ask(asApp(fresh, "creative"));
    assert.equal(ok(await withdraw(itemId, asApp(fresh, "creative"))).result, "withdrawn");
  });

  it("the raising agent withdraws; another agent gets unknown; an agent cannot withdraw an app's item", async () => {
    const mine = await ask(asAgent(agentA), "Agent question");
    assert.equal(ok(await withdraw(mine, asAgent(agentB))).result, "unknown");
    assert.equal(ok(await withdraw(mine, asApp(CREATIVE_1, "creative"))).result, "unknown");
    assert.equal(ok(await withdraw(mine, asAgent(agentA), "not needed")).result, "withdrawn");
    assert.equal(ok(await call("inbox_status", { itemId: mine }, asAgent(agentA))).status, "expired");
    const appItem = await ask(asApp(CREATIVE_1, "creative"));
    assert.equal(ok(await withdraw(appItem, asAgent(agentA))).result, "unknown");
  });

  it("idempotent: the same key replays the first answer; a new key repeats the same answer and the history has one withdraw row", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    const k = key();
    const first = await call("inbox_withdraw", { itemId, reason: "r1" }, asApp(CREATIVE_1, "creative"), k);
    const replay = await call("inbox_withdraw", { itemId, reason: "r1" }, asApp(CREATIVE_1, "creative"), k);
    // (the replay is the stored first result; compare the output, not the receipt envelope)
    const out = (a: Answer) => {
      const { receiptId: _r, ...rest } = ok(a);
      return rest;
    };
    assert.deepEqual(out(replay), out(first));
    const again = ok(await withdraw(itemId, asApp(CREATIVE_1, "creative"), "r2"));
    assert.deepEqual({ itemId: again.itemId, result: again.result, status: again.status }, { itemId, result: "withdrawn", status: "expired" });
    const full = await person("item_get", { itemId });
    assert.equal(full.withdrawal.reason, "r1", "the first reason stays");
    assert.equal(full.activity.filter((a: { kind: string }) => a.kind === "withdrawn").length, 1);
  });

  it("an item the owner already answered answers not_open and keeps the answer", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    const got = await person("item_get", { itemId });
    await person("item_decide", { itemId, version: got.version, response: "approve" });
    const out = ok(await withdraw(itemId, asApp(CREATIVE_1, "creative"), "late"));
    assert.deepEqual({ result: out.result, status: out.status }, { result: "not_open", status: "answered" });
    const read = ok(await call("inbox_status", { itemId }, asApp(CREATIVE_1, "creative")));
    assert.equal((read as unknown as { response: string }).response, "approve");
  });

  it("refused attempts are audited with the verified product and instance, throttled, and visible in the item history", async () => {
    const itemId = await ask(asApp(CREATIVE_1, "creative"));
    for (let i = 0; i < 3; i++) await withdraw(itemId, asApp(BOARD, "kanban"));
    const rows = (await person("item_get", { itemId })).activity;
    assert.deepEqual(
      rows.map((a: { kind: string; actor: { id: string; product: string }; detail: string }) => [a.kind, a.actor.id, a.actor.product, a.detail]),
      [["withdraw_refused", BOARD, "kanban", "not_raiser"]],
      "three identical attempts, one row",
    );
  });

  it("R5 through the real SDK: open {path} passes the manifest schema for a verified app; an agent, a bad path and an unknown open field are refused; no Portal URL means no link", async () => {
    const r = await call("inbox_ask", { kind: "question", title: "3 records wait", open: { path: "/review/rec_01J00000000000000000000001" } }, asApp(CREATIVE_1, "creative"), key());
    const itemId = ok(r).itemId;
    assert.equal((await person("item_get", { itemId })).open, null, "the fake bridge slice has no portalUrl: no half-built link");
    const agent = await call("inbox_ask", { kind: "question", title: "x", open: { path: "/review" } }, asAgent(agentA), key());
    assert.deepEqual([agent.status, (agent.body as { code?: string; error?: { code?: string } }).error?.code ?? (agent.body as { code?: string }).code], [400, "open_not_allowed"]);
    const bad = await call("inbox_ask", { kind: "question", title: "x", open: { path: "//evil.example/x" } }, asApp(CREATIVE_1, "creative"), key());
    assert.equal(bad.status, 400);
    const extra = await call("inbox_ask", { kind: "question", title: "x", open: { path: "/review", product: "kanban" } }, asApp(CREATIVE_1, "creative"), key());
    assert.equal(extra.status, 400, "the product is never an input");
    const long = await call("inbox_ask", { kind: "question", title: "x", open: { path: `/${"a".repeat(200)}` } }, asApp(CREATIVE_1, "creative"), key());
    assert.equal(long.status, 400, "the schema caps the path at 200");
    // the same idempotency key with another page is a conflict, never a second item or a changed link
    const k = key();
    ok(await call("inbox_ask", { kind: "question", title: "same", open: { path: "/review" } }, asApp(CREATIVE_1, "creative"), k));
    assert.equal((await call("inbox_ask", { kind: "question", title: "same", open: { path: "/sources" } }, asApp(CREATIVE_1, "creative"), k)).status, 409);
  });

  it("the SDK checks the input: a missing itemId or an unknown field is refused before the handler", async () => {
    const who = asApp(CREATIVE_1, "creative");
    assert.equal((await call("inbox_withdraw", {}, who, key())).status, 400);
    assert.equal((await call("inbox_withdraw", { itemId: "x", extra: 1 }, who, key())).status, 400);
    assert.equal((await call("inbox_withdraw", { itemId: "x", reason: "" }, who, key())).status, 400);
  });
});

describe("upgrade from a 0.2.9 database through the real SDK migrations", () => {
  it("boots on a 0001-only data dir, applies 0002, keeps the old rows, and the withdraw rules hold for them", async () => {
    const bridge = await newBridge();
    const dir = tmp("upgrade");

    // 1. the 0.2.9 shape: the SDK runs only migration 0001 (as 0.2.9 shipped it)
    const old = tmp("migrations-0001");
    mkdirSync(old, { recursive: true });
    cpSync(fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)), join(old, "0001_init.sql"));
    const base = envFor(bridge, dir); // one KEK for both boots: the instance key sealed by the first boot opens in the second
    const env = { TB_DATA_EPHEMERAL: "1", ...base };
    const harness = { portalRootKeys: bridge.testRootJwks(), port: 0 } as Parameters<typeof startApp>[2];
    const v1 = await startApp(defineApp({ ...definition, migrations: old }), env, harness);
    started.apps.push({ url: "", stop: () => v1.stop() });
    await bridge.control.waitForClaim(30_000);
    await v1.stop().catch(() => {});

    // 2. old rows, written as 0.2.9 wrote them (no product, no withdraw columns)
    const agent = bridge.ids.agents[0]?.id ?? "";
    const now = Date.now();
    const raw = new DatabaseSync(join(dir, "app.db"));
    try {
      const insert = raw.prepare(
        `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at)
         VALUES (?, 'approval', ?, NULL, '["approve","deny","clarify"]', ?, ?, ?, 'open', 'normal', 1, NULL, NULL, ?, ?, ?)`,
      );
      insert.run("itm_old_agent", "Old agent item", "agent", agent, "Scout", now - 1000, now - 1000, now + DAY);
      insert.run("itm_old_app", "Old app item", "app", CREATIVE_1, "Creative", now - 1000, now - 1000, now + DAY);
    } finally {
      raw.close();
    }

    // 3. the new code on the same data dir: the SDK applies 0002
    const { client } = await bootNew(bridge, dir, base);
    await bridge.control.listCompanionCaller({ product: "creative", ins: CREATIVE_1 as never, name: "Creative" });
    const sess = await client.signIn();
    assert.ok(sess, "the owner signs in after the upgrade");
    const listed = (await client.personOp(sess, "items_list", { view: "all" })).output as { items: { id: string; withdrawn: boolean; status: string }[] };
    assert.deepEqual(listed.items.map((i) => [i.id, i.withdrawn, i.status]).sort(), [["itm_old_agent", false, "open"], ["itm_old_app", false, "open"]]);

    const out = async (itemId: string, who: Record<string, unknown>) => ((await client.callOp("inbox_withdraw", { itemId }, { ...who, idempotencyKey: `up-${ulid()}` })).body as { output: Output }).output;
    // the old app item has no recorded product: the same app cannot withdraw it
    assert.equal((await out("itm_old_app", { caller: CREATIVE_1, prd: "creative", held: [] })).result, "unknown");
    // the old agent item: its agent can (the agent id was recorded), another agent cannot
    assert.equal((await out("itm_old_agent", { agent: bridge.ids.agents[1]?.id })).result, "unknown");
    assert.equal((await out("itm_old_agent", { agent })).result, "withdrawn");
    const after = (await client.personOp(sess, "item_get", { itemId: "itm_old_agent" })).output as { status: string; withdrawal: unknown };
    assert.equal(after.status, "expired");
    assert.ok(after.withdrawal);
    // a NEW item of that app records the product and can be withdrawn
    const fresh = ((await client.callOp("inbox_ask", { kind: "question", title: "New" }, { caller: CREATIVE_1 as never, prd: "creative", held: [], idempotencyKey: `up-${ulid()}` })).body as { output: Output }).output.itemId;
    assert.equal((await out(fresh, { caller: CREATIVE_1, prd: "creative", held: [] })).result, "withdrawn");
  });
});
