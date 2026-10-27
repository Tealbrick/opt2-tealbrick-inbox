// C277 A2 (QA row RU-11): "Allow always…" on a Rules hold of the All approvals page. The server builds the link
// (ctx.ownerLinkFor("rules", "/?new=allow&…")); Inbox decides and saves nothing. Good cases and bad cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handlers } from "../src/app.ts";
import { allowAlwaysLink, RULES_GATE } from "../src/holds.ts";
import { AGENT, ctxFor, memoryDb, OWNER, PORTAL, WS } from "./helpers.ts";

type Item = Parameters<typeof allowAlwaysLink>[0];
type LinkFor = Parameters<typeof allowAlwaysLink>[2];

const HOLD = "hld_01M4R00000000000000000S001";
const AGT = "agt_01J00000000000000000000A01";
const rulesHold = (extra: Record<string, unknown> = {}): Item =>
  ({ id: HOLD, op: "buzz_dm_first", family: "policy", heldBy: RULES_GATE, caller: { type: "agent", id: AGT, name: "Scout" }, ...extra }) as Item;
/** the shared launch rule, minus the portal: the link names the product and the URL-encoded path */
const portalLink: LinkFor = (product, path) => `${PORTAL}/w/${WS}/open?product=${product}&path=${encodeURIComponent(path)}`;
/** what the builder asked for: the product and the decoded path with its query */
function asked(item: Item, product = "connect"): { product: string; path: string; query: URLSearchParams } | null {
  const seen: { product: string; path: string }[] = [];
  const url = allowAlwaysLink(item, product, (p, path) => {
    seen.push({ product: p, path });
    return portalLink(p, path);
  });
  const g = seen[0];
  if (url === null || g === undefined) return null;
  assert.ok(g.path.startsWith("/?"), g.path);
  return { ...g, query: new URLSearchParams(g.path.slice(2)) };
}

test("the exact heldBy of a Rules hold is rules/rules_gate", () => {
  assert.equal(RULES_GATE, "rules/rules_gate");
});

test("agent caller: link to Rules, new=allow, product, op, agent, hold; no tool, no callerProduct", () => {
  const a = asked(rulesHold());
  assert.ok(a);
  assert.equal(a.product, "rules");
  assert.deepEqual([...a.query.entries()], [["new", "allow"], ["product", "connect"], ["op", "buzz_dm_first"], ["agent", AGT], ["hold", HOLD]]);
  assert.equal(allowAlwaysLink(rulesHold(), "connect", portalLink), `${PORTAL}/w/${WS}/open?product=rules&path=${encodeURIComponent(`/?new=allow&product=connect&op=buzz_dm_first&agent=${AGT}&hold=${HOLD}`)}`);
});

test("app caller: callerProduct (its verified product), never agent", () => {
  const a = asked(rulesHold({ caller: { type: "app", id: "ins_01J00000000000000000000E01", name: "Observer", product: "observer" } }));
  assert.ok(a);
  assert.deepEqual([...a.query.entries()], [["new", "allow"], ["product", "connect"], ["op", "buzz_dm_first"], ["callerProduct", "observer"], ["hold", HOLD]]);
  assert.equal(a.query.has("agent"), false);
});

test("an app caller without a verified product, or an agent id that is not well formed: no link (never a wider rule)", () => {
  assert.equal(allowAlwaysLink(rulesHold({ caller: { type: "app", id: "ins_1", name: "Observer" } }), "connect", portalLink), null);
  assert.equal(allowAlwaysLink(rulesHold({ caller: { type: "app", id: "ins_1", name: "Observer", product: "Bad Product" } }), "connect", portalLink), null);
  assert.equal(allowAlwaysLink(rulesHold({ caller: { type: "agent", id: "", name: "Scout" } }), "connect", portalLink), null);
  assert.equal(allowAlwaysLink(rulesHold({ caller: { type: "agent", id: "a&agent=agt_x", name: "Scout" } }), "connect", portalLink), null);
  assert.equal(allowAlwaysLink(rulesHold({ caller: { type: "person", id: "per_1", name: "Owner" } }), "connect", portalLink), null);
});

test("tool only when the row carries one; an empty or unprintable tool is left out", () => {
  assert.equal(asked(rulesHold({ tool: "issues.create" }))?.query.get("tool"), "issues.create");
  for (const tool of [undefined, null, "", 7, "has space", "x".repeat(129)]) assert.equal(asked(rulesHold({ tool }))?.query.has("tool"), false, String(tool));
});

test("not a Rules hold: other family, or heldBy other than rules/rules_gate → no link", () => {
  for (const family of ["first_contact", "delete", "caps", "outward", "identity", null]) assert.equal(allowAlwaysLink(rulesHold({ family }), "connect", portalLink), null, String(family));
  for (const heldBy of [null, "", "rules", "rules/other_hook", "rules/rules_gate2", "Rules/rules_gate", "connect/rules_gate", " rules/rules_gate", "other/rules_gate"])
    assert.equal(allowAlwaysLink(rulesHold({ heldBy }), "connect", portalLink), null, String(heldBy));
  assert.equal(allowAlwaysLink(rulesHold({ family: "caps", heldBy: RULES_GATE }), "connect", portalLink), null);
});

test("Rules not installed (ownerLinkFor answers null) or a path the launch rule refuses → no link", () => {
  assert.equal(allowAlwaysLink(rulesHold(), "connect", () => null), null);
  assert.equal(
    allowAlwaysLink(rulesHold(), "connect", () => {
      throw Object.assign(new Error("bad path"), { code: "path_invalid" });
    }),
    null,
  );
  assert.equal(allowAlwaysLink(rulesHold(), "Not A Product", portalLink), null);
  assert.equal(allowAlwaysLink(rulesHold({ op: "" }), "connect", portalLink), null);
});

test("URL encoding: values with &, =, #, space, unicode and + cannot add or change a parameter", () => {
  const tool = "a&agent=agt_evil #x=1+é/ü?";
  const a = asked(rulesHold({ op: "op&new=deny", tool }));
  assert.ok(a);
  assert.equal(a.query.get("op"), "op&new=deny");
  assert.equal(a.query.get("tool"), null, "a tool with a space is not a tool name");
  const b = asked(rulesHold({ op: "dm?send=1#frag", tool: "a&b=c+d%e" }));
  assert.ok(b);
  assert.equal(b.query.get("op"), "dm?send=1#frag");
  assert.equal(b.query.get("tool"), "a&b=c+d%e");
  assert.deepEqual([...b.query.keys()], ["new", "product", "op", "tool", "agent", "hold"]);
  assert.ok(!b.path.slice(2).includes("#") && !b.path.slice(2).includes("&b=c"), b.path);
  assert.equal(b.query.get("new"), "allow");
});

// ── through the op (the person op that serves the approvals list) ─────────────────────────────────────────────────
const h = handlers as Record<string, { run(input: any, ctx: any): Promise<any> }>;
const pending = (id: string, extra: Record<string, unknown>) => ({
  id,
  product: "connect",
  op: "buzz_dm_first",
  family: "first_contact",
  reason: "first message to this person",
  heldBy: null,
  summary: "DM",
  caller: { type: "agent", id: AGENT.id, name: AGENT.name },
  createdAt: "2026-10-12T09:00:00.000Z",
  ageS: 10,
  decidePath: `/holds/${id}`,
  ...extra,
});

test("holds_overview: the row of a Rules hold carries allowAlwaysUrl (server-built); every other row carries null; Inbox's own rows null", async () => {
  const db = memoryDb();
  await h.inbox_ask.run({ kind: "approval", title: "Inbox item" }, ctxFor(db, AGENT));
  const rules = pending(HOLD, { family: "policy", heldBy: RULES_GATE, reason: "needs owner review" });
  const other = pending("hld_01M4R00000000000000000S002", { family: "policy", heldBy: "someapp/their_hook" });
  const plain = pending("hld_01M4R00000000000000000S003", {});
  const callApp = (async () => ({ status: "ok", output: { items: [rules, other, plain], nextCursor: null } })) as never;
  const o = await h.holds_overview.run({}, ctxFor(db, OWNER, callApp, { targets: ["connect"] }));
  const by = Object.fromEntries(o.rows.map((r: { id: string; allowAlwaysUrl: string | null }) => [r.id, r.allowAlwaysUrl]));
  const path = `/?new=allow&product=connect&op=buzz_dm_first&agent=${encodeURIComponent(AGENT.id)}&hold=${HOLD}`;
  assert.equal(by[HOLD], `${PORTAL}/w/${WS}/open?product=rules&path=${encodeURIComponent(path)}`);
  assert.equal(by.hld_01M4R00000000000000000S002, null);
  assert.equal(by.hld_01M4R00000000000000000S003, null);
  assert.equal(o.rows.filter((r: { product: string }) => r.product === "inbox").every((r: { allowAlwaysUrl: unknown }) => r.allowAlwaysUrl === null), true);
});

test("holds_overview: no Portal origin yet (Rules not reachable) → no Allow always link, the hold still lists", async () => {
  const db = memoryDb();
  const callApp = (async () => ({ status: "ok", output: { items: [pending(HOLD, { family: "policy", heldBy: RULES_GATE })], nextCursor: null } })) as never;
  const o = await h.holds_overview.run({}, ctxFor(db, OWNER, callApp, { targets: ["connect"], portal: false }));
  assert.equal(o.rows.length, 1);
  assert.equal(o.rows[0].allowAlwaysUrl, null);
});
