// Upgrade test (UPGRADE-SAFETY M7, C274 S4 DONE-DEFINITION §3.3): a data dir as inbox 0.3.1 (stable, ostra) left it moves to
// this release and every existing item reads the same; the SDK outbox (SDK schema 11) exists and the first events flow.
//
// 0.3.1 = the 0.3.0 line + a Node image (tag v0.3.1, not on main): app migrations 0001 + 0002 under miniapp-sdk 0.1.28,
// whose SDK migration set is schema 1..6. Those six SDK migrations are byte-identical in the SDK this release pins (the SDK
// verifies the sha256 of every applied migration at boot, so a different one would refuse to start). The test therefore boots
// the real SDK on 0001 + 0002, then takes the SDK part back to schema 6 (drops exactly what SDK migrations 7..11 add), writes
// rows the way 0.3.1 wrote them, and boots this release on the same data dir: SDK 7..11 and app 0003..0005 run.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type AppClient, appEnv, createFakeBridge, type FakeBridge, TEST_ROOTS_ENV } from "@opt2-tealbrick/conformance";
import { ulid } from "@opt2-tealbrick/manifest";
import { defineApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import start, { harnessDefinition, servedManifest } from "../conformance.start.ts";

type Running = { url: string; stop(): Promise<void> };
const DAY = 86_400_000;
const APP_INS = `ins_${ulid()}`;

const started: { apps: Running[]; bridges: FakeBridge[]; dirs: string[] } = { apps: [], bridges: [], dirs: [] };
after(async () => {
  for (const app of started.apps.splice(0)) await app.stop().catch(() => {});
  for (const b of started.bridges.splice(0)) await b.close().catch(() => {});
  for (const d of started.dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});
const tmp = (what: string): string => {
  const d = mkdtempSync(join(tmpdir(), `inbox-${what}-`));
  started.dirs.push(d);
  return d;
};

/** What SDK migrations 7..11 (miniapp-sdk 0.1.31 .. 0.1.38) add; 0.1.28 stopped at schema 6. */
const SDK_AFTER_6 = [
  "DROP INDEX tb_event_outbox_age",
  "DROP TABLE tb_event_outbox",
  "ALTER TABLE tb_scopes DROP COLUMN crud_snapshot",
  "ALTER TABLE tb_receipts DROP COLUMN admitted_by",
  "ALTER TABLE tb_scopes DROP COLUMN authority",
  "ALTER TABLE tb_scopes DROP COLUMN granted_by_op",
  "ALTER TABLE tb_scopes DROP COLUMN source",
  "DELETE FROM tb_migrations WHERE scope = 'sdk' AND version > 6",
];

const schema = (raw: DatabaseSync) => {
  const rows = raw.prepare("SELECT scope, max(version) AS v FROM tb_migrations GROUP BY scope").all() as { scope: string; v: number }[];
  return Object.fromEntries(rows.map((r) => [r.scope, Number(r.v)]));
};
const hasTable = (raw: DatabaseSync, name: string) => raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

describe("upgrade from an inbox 0.3.1 data dir (app 0001-0002, SDK schema 6)", () => {
  it("old items read the same after 0003-0005 + SDK 7-11; the outbox exists; answers and expiries of old agent items emit item.answered", async () => {
    const bridge = await createFakeBridge({ manifest: servedManifest });
    started.bridges.push(bridge);
    await bridge.control.publishKeySet();
    const dir = tmp("up031");
    const env = appEnv(bridge, dir, { [TEST_ROOTS_ENV]: JSON.stringify(bridge.testRootJwks()), TBCONF_PORT: "0" });

    // 1. the 0.3.1 app migrations only
    const old = tmp("migrations-031");
    mkdirSync(old, { recursive: true });
    for (const f of ["0001_init.sql", "0002_withdraw.sql"]) cpSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), join(old, f));
    const v031 = await startApp(defineApp({ ...harnessDefinition, migrations: old }), { TB_DATA_EPHEMERAL: "1", ...env }, {
      portalRootKeys: bridge.testRootJwks(),
      port: 0,
    } as Parameters<typeof startApp>[2]);
    started.apps.push({ url: "", stop: () => v031.stop() });
    await bridge.control.waitForClaim(30_000);
    // claimed AND running (it reports a slice): the claim record is on disk before the stop, so the next boot does not re-enrol
    await bridge.control.waitForSliceRevision(1, 30_000);
    await v031.stop().catch(() => {});

    // 2. SDK schema back to 6 (0.1.28) and rows as 0.3.1 wrote them
    const agent = bridge.ids.agents[0]?.id ?? "";
    assert.match(agent, /^agt_/);
    const now = Date.now();
    const raw = new DatabaseSync(join(dir, "app.db"));
    try {
      for (const sql of SDK_AFTER_6) raw.exec(sql);
      assert.deepEqual(schema(raw), { app: 2, sdk: 6 }, "the 0.3.1 shape");
      assert.equal(hasTable(raw, "tb_event_outbox"), false);
      const item = raw.prepare(
        `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at, from_product, withdrawn_at, withdrawn_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      );
      const AP = '["approve","deny","clarify"]';
      const QU = '["answer","clarify"]';
      item.run("itm_031_open", "approval", "Old open approval", "Some context", AP, "agent", agent, "Scout", "open", "high", 2, now - 500, now - 3000, now - 2000, now + DAY, null, null, null);
      item.run("itm_031_answered", "question", "Old answered question", null, QU, "agent", agent, "Scout", "answered", "normal", 2, null, now - 5000, now - 4000, now + DAY, null, null, null);
      item.run("itm_031_app", "approval", "Old app approval", null, AP, "app", APP_INS, "Creative", "open", "normal", 1, null, now - 3000, now - 3000, now + DAY, "creative", null, null);
      item.run("itm_031_withdrawn", "approval", "Old withdrawn", null, AP, "agent", agent, "Scout", "expired", "normal", 1, null, now - 3000, now - 2500, now - 2500, null, now - 2500, "not needed");
      item.run("itm_031_due", "question", "Old item past its time", null, QU, "agent", agent, "Scout", "open", "low", 1, null, now - 2 * DAY, now - 2 * DAY, now - DAY, null, null, null);
      raw
        .prepare("INSERT INTO inbox_messages (id, item_id, author, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("msg_031_a", "itm_031_open", "agent", agent, "More detail from the agent.", now - 2000);
      raw
        .prepare("INSERT INTO inbox_messages (id, item_id, author, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("msg_031_b", "itm_031_answered", "owner", "per_owner", "Use the blue one.", now - 4000);
      raw
        .prepare("INSERT INTO inbox_decisions (id, item_id, response, message, decided_by, decided_at, item_version) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("dcs_031", "itm_031_answered", "answer", "Use the blue one.", "per_owner", now - 4000, 1);
      raw
        .prepare("INSERT INTO inbox_activity (id, item_id, kind, actor_type, actor_id, actor_product, actor_name, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("act_031", "itm_031_withdrawn", "withdrawn", "agent", agent, null, "Scout", "not needed", now - 2500);
      raw
        .prepare(
          "INSERT INTO inbox_deliveries (id, item_id, channel, op, input, idem_key, status, hold_id, error, attempts, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
        )
        .run("dlv_031", "itm_031_open", "buzz", "buzz_dm", "{}", "inbox-alert-dlv_031", "sent", 1, now - 3000, now - 3000, now - 3000);
    } finally {
      raw.close();
    }

    // 3. this release on the same data dir, with a bridge that has the events cap
    const rev = await bridge.control.setBridgeCaps(["owner_rows", "events"]);
    const app = await start(env);
    started.apps.push(app);
    // the new process reports this slice revision (the old one stopped before it was published): it is up and has the cap
    await bridge.control.waitForSliceRevision(rev, 30_000);
    const client: AppClient = bridge.client(app.url);
    const sess = await client.signIn();
    assert.ok(sess, "the owner signs in after the upgrade");

    const check = new DatabaseSync(join(dir, "app.db"), { readOnly: true });
    try {
      assert.deepEqual(schema(check), { app: 5, sdk: 11 }, "app 0003-0005 and SDK 7-11 applied");
      assert.equal(hasTable(check, "tb_event_outbox"), true, "SDK schema 11: the event outbox");
    } finally {
      check.close();
    }

    // 4. the old items read the same (owner list, owner detail, agent status)
    type Summary = { id: string; kind: string; title: string; status: string; priority: string; version: number; acked: boolean; withdrawn: boolean; from: { type: string; id: string } };
    const all = (await client.personOp(sess, "items_list", { view: "all" })).output as { items: Summary[] };
    const byId = Object.fromEntries(all.items.map((i) => [i.id, i]));
    assert.deepEqual(Object.keys(byId).sort(), ["itm_031_answered", "itm_031_app", "itm_031_due", "itm_031_open", "itm_031_withdrawn"]);
    assert.deepEqual(
      ["itm_031_open", "itm_031_answered", "itm_031_app", "itm_031_withdrawn", "itm_031_due"].map((id) => {
        const i = byId[id] as Summary;
        return [i.kind, i.title, i.status, i.priority, i.version, i.acked, i.withdrawn, i.from.type, i.from.id];
      }),
      [
        ["approval", "Old open approval", "open", "high", 2, true, false, "agent", agent],
        ["question", "Old answered question", "answered", "normal", 2, false, false, "agent", agent],
        ["approval", "Old app approval", "open", "normal", 1, false, false, "app", APP_INS],
        ["approval", "Old withdrawn", "expired", "normal", 1, false, true, "agent", agent],
        ["question", "Old item past its time", "expired", "low", 1, false, false, "agent", agent],
      ],
    );
    const open = (await client.personOp(sess, "item_get", { itemId: "itm_031_open" })).output as { context: string; family: unknown; open: unknown; messages: { body: string }[]; deliveries: { id: string; status: string }[] };
    assert.equal(open.context, "Some context");
    assert.equal(open.family, null, "0004: no family for old rows (no DM buttons)");
    assert.equal(open.open, null, "0003: no open link for old rows");
    assert.deepEqual(
      open.messages.map((m) => m.body),
      ["More detail from the agent."],
    );
    assert.deepEqual(
      open.deliveries.map((d) => [d.id, d.status]),
      [["dlv_031", "sent"]],
    );
    const withdrawn = (await client.personOp(sess, "item_get", { itemId: "itm_031_withdrawn" })).output as { withdrawal: { reason: string } | null; activity: { kind: string }[] };
    assert.equal(withdrawn.withdrawal?.reason, "not needed");
    assert.deepEqual(
      withdrawn.activity.map((a) => a.kind),
      ["withdrawn"],
    );
    const status = async (itemId: string) => ((await client.callOp("inbox_status", { itemId }, { agent: agent as never })).body as { output: Record<string, unknown> }).output;
    const answered = await status("itm_031_answered");
    assert.deepEqual([answered.status, answered.response, answered.message, answered.seenByOwner], ["answered", "answer", "Use the blue one.", true]);

    // 5. events: the old item that was past its time expired at boot (start-context sweep: no causedBy) → expired event;
    //    the owner answers the old open agent item → answered event; the old app item → none
    const items = () => bridge.control.eventItems().map((x) => x.item) as { name?: string; subject?: { id: string }; to?: string[]; data?: unknown; causedBy?: string; untrusted?: boolean }[];
    const waitFor = async (pred: () => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      return pred();
    };
    assert.ok(await waitFor(() => items().some((i) => i.subject?.id === "itm_031_due")), "the expiry event of the old item arrives");
    const due = items().find((i) => i.subject?.id === "itm_031_due");
    assert.deepEqual([due?.name, due?.to, due?.data, due?.causedBy, due?.untrusted], ["item.answered", [agent], { itemKind: "question", status: "expired", response: null }, undefined, true]);

    const d1 = await client.personOp(sess, "item_decide", { itemId: "itm_031_open", version: 2, response: "approve" });
    assert.equal(d1.status, 200);
    const d2 = await client.personOp(sess, "item_decide", { itemId: "itm_031_app", version: 1, response: "deny" });
    assert.equal(d2.status, 200);
    assert.ok(await waitFor(() => items().some((i) => i.subject?.id === "itm_031_open")), "the answered event of the old item arrives");
    await new Promise((r) => setTimeout(r, 500));
    const opened = items().filter((i) => i.subject?.id === "itm_031_open");
    assert.equal(opened.length, 1);
    assert.deepEqual([opened[0]?.to, opened[0]?.data], [[agent], { itemKind: "approval", status: "answered", response: "approve" }]);
    assert.equal(
      items().some((i) => i.subject?.id === "itm_031_app"),
      false,
      "no event for an app asker",
    );
    assert.equal(items().filter((i) => i.name === "item.answered").length, 2, "exactly two item.answered events");
    assert.equal((await status("itm_031_open")).response, "approve");
  });
});
