// C274 S4: the app event `inbox.item.answered` (manifest `events`, MANIFEST §16, SDK-API §20). One event per owner decision
// (every decide path: Portal / TBM item_decide here, chat buttons item_decide_dm in dm-decide.test.ts), and one per expiry the sweep writes; only to an
// AGENT asker; never for app askers, refused or rolled-back decisions, or a withdraw. The outbox stand-in (helpers.ts) writes in
// the same transaction, so a rollback is observable. The real SDK path: conformance A-EV rows and test/upgrade-0.3.1.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_SUMMARY_MAX, eventDecl, validateEventPayload } from "@opt2-tealbrick/manifest";
import type { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { clock, handlers, manifest, tick } from "../src/app.ts";
import * as store from "../src/store.ts";
import { AGENT, ctxFor, type Emitted, memoryDb, OTHER, OWNER, recordingOutbox } from "./helpers.ts";

const h = handlers as any;
const T0 = Date.parse("2026-10-27T10:00:00Z");
const HOUR = 3_600_000;
const APP = { type: "app", id: "ins_01J00000000000000000000CRE", name: "Creative", mode: "free", product: "creative" } as const;
const code = (c: string) => (e: unknown) => (e as TbError).code === c;

function setup() {
  clock.now = () => T0;
  const db = memoryDb();
  const out = recordingOutbox(db, manifest);
  return { db, ...out };
}
const askAs = async (db: ReturnType<typeof memoryDb>, who: Parameters<typeof ctxFor>[1], input: Record<string, unknown> = { kind: "approval", title: "Send the invoice?" }) =>
  (await h.inbox_ask.run(input, ctxFor(db, who))) as { itemId: string };
const decide = (db: ReturnType<typeof memoryDb>, emit: ReturnType<typeof recordingOutbox>["emit"], input: Record<string, unknown>) => h.item_decide.run(input, ctxFor(db, OWNER, undefined, { emit }));

test("the manifest declares item.answered: target, visibleWith inbox_status, ids/enums only, no summary property", () => {
  const decl = eventDecl(manifest, store.ANSWERED_EVENT);
  assert.ok(decl);
  assert.equal(decl.audience, "target");
  assert.equal(decl.visibleWith, "inbox_status");
  const schema = decl.payloadSchema as unknown as { additionalProperties: boolean; required: string[]; properties: Record<string, { enum: unknown[] }> };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["itemKind", "status", "response"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["itemKind", "response", "status"]);
  assert.deepEqual(schema.properties.itemKind?.enum, [...store.KINDS]);
  assert.deepEqual(schema.properties.status?.enum, ["answered", "expired"]);
  assert.deepEqual(schema.properties.response?.enum, [...store.RESPONSES, null]);
  // every combination Inbox emits validates; anything else does not
  for (const itemKind of store.KINDS)
    for (const response of [...store.RESPONSES, null]) assert.ok(validateEventPayload(decl, { itemKind, status: response === null ? "expired" : "answered", response }).ok);
  assert.equal(validateEventPayload(decl, { itemKind: "approval", status: "answered", response: "approve", message: "text" }).ok, false, "no free text");
  assert.equal(validateEventPayload(decl, { itemKind: "approval", status: "open", response: null }).ok, false);
});

test("owner decides an agent's item: exactly one item.answered to that agent, ids and enums only, title as untrusted summary", async () => {
  const { db, emit, rows } = setup();
  const { itemId } = await askAs(db, AGENT);
  assert.equal(rows().length, 0, "asking emits nothing");
  await decide(db, emit, { itemId, version: 1, response: "deny", message: "Not this month." });
  const ev = rows();
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], {
    name: "item.answered",
    data: { itemKind: "approval", status: "answered", response: "deny" },
    opts: { subject: { kind: "inbox_item", id: itemId }, to: [AGENT.id], summary: "Send the invoice?", untrusted: true },
  } satisfies Emitted);
  assert.equal(JSON.stringify(ev[0]?.data).includes("Not this month"), false, "the owner's message is never in the event");
  // the agent reads the answer through visibleWith
  const s = await h.inbox_status.run({ itemId }, ctxFor(db, AGENT));
  assert.deepEqual([s.status, s.response, s.message], ["answered", "deny", "Not this month."]);
});

test("question answered: response answer; clarify keeps the item kind", async () => {
  const { db, emit, rows } = setup();
  const q = await askAs(db, AGENT, { kind: "question", title: "Which venue?" });
  const a = await askAs(db, AGENT, { kind: "approval", title: "Book it?" });
  await decide(db, emit, { itemId: q.itemId, version: 1, response: "answer", message: "The small one." });
  await decide(db, emit, { itemId: a.itemId, version: 1, response: "clarify", message: "Which date?" });
  assert.deepEqual(
    rows().map((e) => e.data),
    [
      { itemKind: "question", status: "answered", response: "answer" },
      { itemKind: "approval", status: "answered", response: "clarify" },
    ],
  );
});

test("app askers get no event (v1), the decision itself is unchanged", async () => {
  const { db, emit, rows } = setup();
  const { itemId } = await askAs(db, APP);
  const out = await decide(db, emit, { itemId, version: 1, response: "approve" });
  assert.equal(out.status, "answered");
  assert.equal(rows().length, 0);
});

test("refused decisions emit nothing: unknown, stale version, not allowed, no message, already decided, expired", async () => {
  const { db, emit, rows } = setup();
  const { itemId } = await askAs(db, AGENT, { kind: "question", title: "Q?" });
  await assert.rejects(decide(db, emit, { itemId: "itm_nope", version: 1, response: "answer", message: "x" }), code("item_not_found"));
  await h.inbox_reply.run({ itemId, message: "More context." }, ctxFor(db, AGENT));
  await assert.rejects(decide(db, emit, { itemId, version: 1, response: "answer", message: "x" }), code("stale_version"));
  await assert.rejects(decide(db, emit, { itemId, version: 2, response: "approve" }), code("response_not_allowed"));
  await assert.rejects(decide(db, emit, { itemId, version: 2, response: "answer" }), code("message_required"));
  assert.equal(rows().length, 0);
  await decide(db, emit, { itemId, version: 2, response: "answer", message: "Yes." });
  assert.equal(rows().length, 1);
  await assert.rejects(decide(db, emit, { itemId, version: 3, response: "answer", message: "Again." }), code("already_decided"));
  assert.equal(rows().length, 1, "one event per decision, never a second");
});

test("rollback: a decide inside a transaction that fails leaves no event (and no answer)", () => {
  const { db, emit, rows } = setup();
  const item = store.ask(db, { type: "agent", id: AGENT.id, name: AGENT.name }, { kind: "approval", title: "Ship?" }, T0);
  assert.throws(() =>
    db.transaction(() => {
      store.decide(db, { itemId: item.id, version: 1, response: "approve" }, OWNER.id, T0, emit);
      throw new Error("a later step of the same transaction fails");
    }),
  );
  assert.equal(rows().length, 0);
  assert.equal(store.status(db, { type: "agent", id: AGENT.id, product: null }, item.id).status, "open");
});

test("an emit that fails rolls the decision back (the event and the answer share one transaction)", () => {
  const { db, rows } = setup();
  const item = store.ask(db, { type: "agent", id: AGENT.id, name: AGENT.name }, { kind: "approval", title: "Ship?" }, T0);
  const broken = (() => {
    throw Object.assign(new Error("outbox down"), { code: "outbox_down" });
  }) as unknown as store.Emit;
  assert.throws(() => store.decide(db, { itemId: item.id, version: 1, response: "approve" }, OWNER.id, T0, broken), /outbox down/);
  assert.equal(store.status(db, { type: "agent", id: AGENT.id, product: null }, item.id).status, "open");
  assert.equal(rows().length, 0);
});

test("the summary is the title, at most 280 characters, and always untrusted", () => {
  const { db, emit, rows } = setup();
  const long = "x".repeat(400);
  const item = store.ask(db, { type: "agent", id: AGENT.id, name: AGENT.name }, { kind: "approval", title: long }, T0);
  store.decide(db, { itemId: item.id, version: 1, response: "approve" }, OWNER.id, T0, emit);
  const [ev] = rows();
  assert.equal(ev?.opts.summary?.length, EVENT_SUMMARY_MAX);
  assert.ok(ev?.opts.summary?.endsWith("…"));
  assert.equal(ev?.opts.untrusted, true);
});

test("an agent id the SDK would refuse in `to` gets no event (never seen from a verified grant); the decision still stands", () => {
  const { db, emit, rows } = setup();
  const item = store.ask(db, { type: "agent", id: "agent-legacy", name: "Old" }, { kind: "approval", title: "Ship?" }, T0);
  store.decide(db, { itemId: item.id, version: 1, response: "approve" }, OWNER.id, T0, emit);
  assert.equal(rows().length, 0);
});

test("expiry: the sweep emits status expired (response null) once per agent item, never for app items or withdrawn ones", async () => {
  const { db, emit, rows } = setup();
  const a = await askAs(db, AGENT, { kind: "approval", title: "Short", expiresInS: 60 });
  const b = await askAs(db, OTHER, { kind: "question", title: "Short Q", expiresInS: 60 });
  await askAs(db, APP, { kind: "approval", title: "App item", expiresInS: 60 });
  const w = await askAs(db, AGENT, { kind: "approval", title: "Withdrawn", expiresInS: 60 });
  await askAs(db, AGENT, { kind: "approval", title: "Long" });
  await h.inbox_withdraw.run({ itemId: w.itemId }, ctxFor(db, AGENT, undefined, { emit }));
  assert.equal(rows().length, 0, "a withdraw is the asker's own act: no event");

  assert.equal(store.expireDue(db, T0 + HOUR, emit), 3, "three items expire (two agents, one app)");
  assert.deepEqual(
    rows().map((e) => [e.opts.subject.id, e.opts.to, e.data]),
    [
      [a.itemId, [AGENT.id], { itemKind: "approval", status: "expired", response: null }],
      [b.itemId, [OTHER.id], { itemKind: "question", status: "expired", response: null }],
    ],
  );
  assert.equal(store.expireDue(db, T0 + 2 * HOUR, emit), 0);
  assert.equal(rows().length, 2, "a second sweep emits nothing");
});

test("expiry through the op sweep and the background tick: each expired item once; a decide on it emits nothing", async () => {
  const { db, emit, rows } = setup();
  const a = await askAs(db, AGENT, { kind: "approval", title: "One", expiresInS: 60 });
  const b = await askAs(db, AGENT, { kind: "approval", title: "Two", expiresInS: 120 });
  // the op sweep (begin) of any op expires a; the owner's late decide is refused and emits nothing more
  clock.now = () => T0 + 90_000;
  await assert.rejects(decide(db, emit, { itemId: a.itemId, version: 1, response: "approve" }), code("item_expired"));
  assert.deepEqual(
    rows().map((e) => [e.opts.subject.id, e.data.status]),
    [[a.itemId, "expired"]],
  );
  // the background tick (start context emit) expires b
  await tick({ db, log: { debug() {}, info() {}, warn() {}, error() {} }, callApp: async () => ({}) as never, statusChanged() {}, emit } as never, T0 + 3 * HOUR);
  assert.deepEqual(
    rows().map((e) => [e.opts.subject.id, e.data.status]),
    [
      [a.itemId, "expired"],
      [b.itemId, "expired"],
    ],
  );
});

test("expiry sweep rollback: nothing is emitted when the sweep transaction fails", () => {
  const { db, emit, rows } = setup();
  store.ask(db, { type: "agent", id: AGENT.id, name: AGENT.name }, { kind: "approval", title: "Soon", expiresInS: 1 }, T0);
  assert.throws(() =>
    db.transaction(() => {
      store.expireDue(db, T0 + HOUR, emit);
      throw new Error("fail after the sweep");
    }),
  );
  assert.equal(rows().length, 0);
  assert.equal(store.expireDue(db, T0 + HOUR, emit), 1, "the item is still open and expires on the next sweep");
  assert.equal(rows().length, 1);
});
