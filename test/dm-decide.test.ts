// IN-2: Approve / Deny buttons in the Slack or Telegram DM alert, decided through item_decide_dm (PLAN-DM-DECIDE §3, §6).
import assert from "node:assert/strict";
import test from "node:test";
import type { Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { BUTTONS_LINE, INBOX_ONLY_LINE } from "../src/alerts.ts";
import { clock, handlers, tick } from "../src/app.ts";
import { TOKEN_TTL_MS } from "../src/dm.ts";
import { AGENT, type CallApp, ctxFor, memoryDb, OWNER, type Sent } from "./helpers.ts";

const h = handlers as any;
const code = (c: string) => (e: unknown) => (e as TbError).code === c;
const NOW = Date.parse("2026-10-24T10:00:00Z");
const CONNECT = { type: "app", id: "ins_01J00000000000000000000C0N", name: "Connect", mode: "free", product: "connect" } as const;
const OBSERVER = { type: "app", id: "ins_01J00000000000000000000OBS", name: "Observer", mode: "free", product: "observer" } as const;
const OWNER_ID = "U0OWNER1";

function fakeConnect(script: (n: number, sent: Sent) => Json | Error = () => ({ status: "ok", output: { messageId: "1.2", conversation: "D1", actions: "shown" } })) {
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

type Action = { label: string; value: string; style: string };
/** The input of one recorded companion call. */
const inp = (s: Sent | undefined) => (s as Sent).input as Record<string, unknown> & { text: string; actions?: Action[]; actionsUntil?: string };

async function setup(buttons = true, account = "slack") {
  clock.now = () => NOW;
  const db = memoryDb();
  await h.alerts_set.run({ dm: "channel", channelAccount: account, channelPerson: OWNER_ID, buttons }, ctxFor(db, OWNER));
  return db;
}

async function ask(db: ReturnType<typeof memoryDb>, input: Record<string, unknown> = { kind: "approval", title: "Post the reply?", family: "none" }) {
  const c = fakeConnect();
  const out = await h.inbox_ask.run(input, ctxFor(db, AGENT, c.callApp));
  const sent = c.sent[0];
  const actions = sent ? (inp(sent).actions ?? []) : [];
  return { itemId: out.itemId as string, sent, actions };
}

const click = (db: ReturnType<typeof memoryDb>, token: string, extra: Record<string, unknown> = {}, caller: Parameters<typeof ctxFor>[1] = CONNECT) =>
  h.item_decide_dm.run({ token, clicker: { service: "slack", id: OWNER_ID }, account: "slack", ...extra }, ctxFor(db, caller));

test("buttons on + approval with family none: the DM carries signed Approve / Deny; a click decides once", async () => {
  const db = await setup();
  const { itemId, sent, actions } = await ask(db);
  assert.equal(sent?.op, "channel_dm");
  assert.deepEqual(
    actions.map((a) => [a.label, a.style]),
    [
      ["Approve", "primary"],
      ["Deny", "danger"],
    ],
  );
  for (const a of actions) assert.ok(a.value.length <= 64, "Telegram callback_data limit");
  assert.match(String(inp(sent).text), new RegExp(`${BUTTONS_LINE}$`));
  assert.equal(inp(sent).actionsUntil, new Date(NOW + TOKEN_TTL_MS).toISOString());

  const status = { pushes: 0 };
  const approve = actions[0]?.value as string;
  const out = await h.item_decide_dm.run({ token: approve, clicker: { service: "slack", id: OWNER_ID }, account: "slack" }, ctxFor(db, CONNECT, undefined, { status }));
  assert.deepEqual([out.status, out.response, out.decidedBy], ["answered", "approve", `slack:${OWNER_ID}`]);
  assert.equal(status.pushes, 1, "badge push");
  const agent = await h.inbox_status.run({ itemId }, ctxFor(db, AGENT));
  assert.deepEqual([agent.status, agent.response], ["answered", "approve"]);
  const detail = await h.item_get.run({ itemId }, ctxFor(db, OWNER));
  assert.equal(detail.decision.decidedBy, `slack:${OWNER_ID}`);
  assert.equal(detail.family, "none");

  // replay: the same button, the other button
  await assert.rejects(click(db, approve), code("token_used"));
  await assert.rejects(click(db, actions[1]?.value as string), code("token_used"));
});

test("no buttons: question, money, delete, no declared family, buttons off", async () => {
  const db = await setup();
  for (const input of [
    { kind: "question", title: "Which venue?", family: "none" },
    { kind: "approval", title: "Refund 500 EUR?", family: "money" },
    { kind: "approval", title: "Delete the list?", family: "destructive" },
    { kind: "approval", title: "No family" },
  ]) {
    const { sent, actions } = await ask(db, input);
    assert.deepEqual(actions, [], input.title);
    assert.equal(inp(sent).actionsUntil, undefined);
    assert.match(String(inp(sent).text), new RegExp(`${INBOX_ONLY_LINE.replace(/[().]/g, "\\$&")}$`), input.title);
  }
  const off = await setup(false);
  const plain = await ask(off);
  assert.deepEqual(plain.actions, []);
  assert.match(String(inp(plain.sent).text), /Open Operator Inbox to answer\.$/);
  // responses without approve/deny buttons: only clarify is not a button
  const onlyDeny = await ask(db, { kind: "approval", title: "Deny only", family: "public_link", responses: ["deny", "clarify"] });
  assert.deepEqual(
    onlyDeny.actions.map((a) => a.label),
    ["Deny"],
  );
});

test("forgery: changed choice, changed token id, made-up signature, another item's value, bad shape", async () => {
  const db = await setup();
  const a = await ask(db);
  const b = await ask(db, { kind: "approval", title: "Other", family: "identity" });
  const approve = a.actions[0]?.value as string;
  const [, tid, , mac] = approve.split(".") as [string, string, string, string];
  await assert.rejects(click(db, `ib1.${tid}.d.${mac}`), code("token_invalid"), "approve signature with deny choice");
  await assert.rejects(click(db, `ib1.${"A".repeat(16)}.a.${mac}`), code("token_invalid"), "unknown token id");
  await assert.rejects(click(db, `ib1.${tid}.a.${"B".repeat(22)}`), code("token_invalid"), "made-up signature");
  const otherMac = String(b.actions[0]?.value).split(".")[3];
  await assert.rejects(click(db, `ib1.${tid}.a.${otherMac}`), code("token_invalid"), "another item's signature");
  await assert.rejects(click(db, "approve"), code("token_invalid"));
  // nothing changed: the real button still works
  assert.equal((await click(db, approve)).response, "approve");
});

test("wrong person / service / account: refused, token stays valid for the owner", async () => {
  const db = await setup();
  const { actions } = await ask(db);
  const approve = actions[0]?.value as string;
  await assert.rejects(click(db, approve, { clicker: { service: "slack", id: "U0SOMEONE" } }), code("wrong_person"));
  await assert.rejects(click(db, approve, { clicker: { service: "telegram", id: OWNER_ID } }), code("wrong_person"));
  await assert.rejects(click(db, approve, { account: "acc_other" }), code("wrong_person"));
  assert.equal((await click(db, approve)).response, "approve");
});

test("only Connect relays: an agent, another app, the owner session are refused", async () => {
  const db = await setup();
  const { actions } = await ask(db);
  const approve = actions[0]?.value as string;
  await assert.rejects(click(db, approve, {}, AGENT), code("connect_only"));
  await assert.rejects(click(db, approve, {}, OBSERVER), code("connect_only"));
  await assert.rejects(click(db, approve, {}, OWNER), code("connect_only"));
  await assert.rejects(click(db, approve, {}, { ...CONNECT, product: undefined } as never), code("connect_only"));
});

test("expired token, expired item, stale version, buttons turned off, recipient changed", async () => {
  const db = await setup();
  const a = await ask(db);
  clock.now = () => NOW + TOKEN_TTL_MS;
  await assert.rejects(click(db, a.actions[0]?.value as string), code("token_expired"));

  clock.now = () => NOW;
  const short = await ask(db, { kind: "approval", title: "Short", family: "none", expiresInS: 60 });
  clock.now = () => NOW + 61_000;
  await assert.rejects(click(db, short.actions[0]?.value as string), code("token_expired"), "token never outlives the item");

  clock.now = () => NOW;
  const stale = await ask(db);
  await h.inbox_reply.run({ itemId: stale.itemId, message: "Changed the text" }, ctxFor(db, AGENT));
  await assert.rejects(click(db, stale.actions[0]?.value as string), code("stale_version"));
  // a refused decide does not use the token up (the transaction rolls back), and it stays refused
  await assert.rejects(click(db, stale.actions[0]?.value as string), code("stale_version"));

  const off = await ask(db);
  await h.alerts_set.run({ dm: "channel", channelAccount: "slack", channelPerson: OWNER_ID, buttons: false }, ctxFor(db, OWNER));
  await assert.rejects(click(db, off.actions[0]?.value as string), code("buttons_off"));
  await h.alerts_set.run({ dm: "channel", channelAccount: "slack", channelPerson: "U0NEWOWNER", buttons: true }, ctxFor(db, OWNER));
  await assert.rejects(click(db, off.actions[0]?.value as string), code("buttons_off"));
});

test("older Connect refuses `actions`: the alert goes out as text only and the token is retired", async () => {
  const db = await setup();
  const c = fakeConnect((n) => (n === 1 ? Object.assign(new Error("unknown field"), { code: "input_invalid" }) : { status: "ok", output: { messageId: "1", conversation: "D1" } }));
  const out = await h.inbox_ask.run({ kind: "approval", title: "Post?", family: "none" }, ctxFor(db, AGENT, c.callApp));
  assert.equal(c.sent.length, 2);
  const first = c.sent[0]?.input as { actions?: Action[] };
  const second = c.sent[1]?.input as Record<string, unknown>;
  assert.equal(second.actions, undefined);
  assert.match(String(second.text), /Open Operator Inbox to answer\.$/);
  assert.equal(c.sent[1]?.key, `${c.sent[0]?.key}-plain`);
  const d = (await h.item_get.run({ itemId: out.itemId }, ctxFor(db, OWNER))).deliveries;
  assert.equal(d[0].status, "sent");
  await assert.rejects(click(db, first.actions?.[0]?.value as string), code("token_used"), "retired token");
});

test("Teams / Discord: Connect answers actions unsupported → the token is retired", async () => {
  const db = await setup(true, "teams");
  const c = fakeConnect(() => ({ status: "ok", output: { messageId: "1", conversation: "c1", actions: "unsupported" } }));
  await h.inbox_ask.run({ kind: "approval", title: "Post?", family: "none" }, ctxFor(db, AGENT, c.callApp));
  const value = (inp(c.sent[0]).actions ?? [])[0]?.value as string;
  await assert.rejects(click(db, value, { account: "teams", clicker: { service: "teams", id: OWNER_ID } }), code("token_used"));
});

test("snooze end pushes the status at once (C331(11)), from the tick and from the wake timer", async () => {
  clock.now = () => NOW;
  const db = memoryDb();
  const { itemId } = await ask(db, { kind: "approval", title: "Later" });
  const status = { pushes: 0 };
  const owner = ctxFor(db, OWNER, undefined, { status });
  await h.item_snooze.run({ itemId, until: new Date(NOW + 30_000).toISOString() }, owner);
  const after = status.pushes;
  assert.equal((await h.items_list.run({ view: "pending" }, owner)).counts.pending, 0);

  // the tick after the snooze end pushes (before IN-2: no push until the next periodic report)
  clock.now = () => NOW + 31_000;
  const tickCtx = { db, log: { debug() {}, info() {}, warn() {}, error() {} }, callApp: (async () => ({})) as never, statusChanged: () => status.pushes++ };
  await tick(tickCtx as never, NOW + 31_000);
  assert.equal(status.pushes, after + 1);
  await tick(tickCtx as never, NOW + 32_000);
  assert.equal(status.pushes, after + 1, "one push per wake");

  // the wake timer fires at the snooze end between two ticks
  clock.now = () => Date.now();
  const start = Date.now();
  const { itemId: second } = await ask(db, { kind: "approval", title: "Soon" });
  await h.item_snooze.run({ itemId: second, until: new Date(start + 50).toISOString() }, ctxFor(db, OWNER));
  const before = status.pushes;
  await tick(tickCtx as never, start);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(status.pushes, before + 1, "timer push");
  clock.now = () => NOW;
});
