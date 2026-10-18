// The Operator Inbox pages (Inbox + item, All approvals, Settings) against the real SDK client and a stub server.
// RUL-01 (every Approve / Deny / answer / ack / priority / snooze / save failure shows a plain message, never a dropped
// rejection), RUL-14 (a failed load is an error with Try again), one call at a time per item. The pages are compiled with
// the build tsconfig into dist/ui-test-inbox (JSX needs a compile) and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-inbox");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/inbox/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// ── stub server (the person ops under /a/inbox/tb/v1/) ──────────────────────
const ITEM = "itm_01JI1000000000000000000000";
const now = new Date().toISOString();
const later = new Date(Date.now() + 86_400_000).toISOString();
const item = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  kind: "approval",
  title: "Publish the release notes?",
  from: { type: "agent", id: "agt_1", name: "Scout" },
  status: "open",
  priority: "high",
  acked: false,
  snoozedUntil: null,
  response: null,
  version: 1,
  withdrawn: false,
  createdAt: now,
  updatedAt: now,
  expiresAt: later,
  context: "Draft attached.",
  responses: ["approve", "deny", "clarify"],
  messages: [],
  decision: null,
  deliveries: [],
  withdrawal: null,
  activity: [],
  open: null,
  digest: null,
  ...over,
});
const overview = {
  source: "all_apps",
  unavailable: null,
  rows: [
    { product: "kanban", id: "hld_1", op: "issue_delete", family: null, reason: null, summary: "Delete issue “Old price list”", caller: { type: "agent", id: "a", name: "Research partner" }, createdAt: now, ageS: 60, decidePath: "/holds/hld_1", openUrl: "https://portal.example.test/open" },
    { product: "inbox", id: ITEM, op: "inbox_ask", family: null, reason: "approval requested", summary: "Publish the release notes?", caller: { type: "agent", id: "a", name: "Scout" }, createdAt: now, ageS: 60, decidePath: `/items/${ITEM}`, openUrl: null },
    { product: "connect", id: "hld_2", op: "dm_send", family: null, reason: null, summary: "DM #1", caller: { type: "agent", id: "a", name: "Scout" }, createdAt: now, ageS: 60, decidePath: "/holds/hld_2", openUrl: null },
  ],
  errors: [{ product: "rules", code: "app_unavailable" }],
};

interface Stub {
  calls: { op: string; input: Record<string, unknown> }[];
  fail: Record<string, { status: number; code: string; message?: string } | undefined>;
  gate: Record<string, Promise<void> | undefined>;
  networkDown: boolean;
  answers: Record<string, unknown>;
}
const stub: Stub = { calls: [], fail: {}, gate: {}, networkDown: false, answers: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reset = (answers: Record<string, unknown> = {}) => {
  stub.calls = [];
  stub.fail = {};
  stub.gate = {};
  stub.networkDown = false;
  stub.answers = { item_get: item(), holds_overview: overview, alerts_get: { dm: "buzz", buzzTo: "npub1abc", channelAccount: null, channelPerson: null, delivery: "each", digestEveryMin: 60, quietHours: null, timeZone: null }, alerts_set: { dm: "buzz", buzzTo: "npub1abc", channelAccount: null, channelPerson: null, delivery: "each", digestEveryMin: 60, quietHours: null, timeZone: null }, item_decide: {}, item_ack: item(), item_priority: item(), item_snooze: item(), ...answers };
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (stub.networkDown) throw new TypeError("fetch failed");
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/inbox/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  stub.calls.push({ op, input: body.input ?? {} });
  await stub.gate[op];
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: failure.message ?? `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op in stub.answers) return json(200, { status: "ok", output: stub.answers[op] });
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "inbox" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (host: Element, text: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const alerts = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const decides = () => stub.calls.filter((c) => c.op === "item_decide");

type Pages = { InboxPage: (p: { selected: string | null; onSelect: (id: string) => void; onCounts: (n: number) => void; hrefOf: (id: string) => string }) => ReactElement; ApprovalsPage: (p: { onOpenItem: (id: string) => void; itemHref: (id: string) => string }) => ReactElement; SettingsPage: () => ReactElement };
let pages: Pages;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const at = (f: string) => import(pathToFileURL(join(outDir, "ui", f)).href);
  pages = { ...(await at("inbox.js")), ...(await at("approvals.js")), ...(await at("settings.js")) } as Pages;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const inbox = () => h(pages.InboxPage, { selected: ITEM, onSelect: () => {}, onCounts: () => {}, hrefOf: (id: string) => `items/${id}` });
const pick = async (host: Element, label: string, option: string) => {
  const trigger = [...host.querySelectorAll('[role="combobox"]')].find((t) => t.closest(".tb-field")?.querySelector(".tb-label")?.textContent === label);
  assert.ok(trigger, `select "${label}"`);
  await click(trigger);
  const opt = [...host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(option));
  assert.ok(opt, `option "${option}"`);
  await click(opt);
  await flush();
};

describe("Inbox item", () => {
  it("shows the item, the thread and Approve (primary) / Deny (danger) / Ask for clarification", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } }, item_get: item({ messages: [{ id: "m1", author: "agent", body: "Also tag v0.2.0.", createdAt: now }] }) });
    const m = await mount(inbox());
    assert.equal(m.host.querySelector(".detail h2")?.textContent, "Publish the release notes?");
    assert.match(m.host.querySelector(".msgs")?.textContent ?? "", /Also tag v0\.2\.0\./);
    assert.ok(button(m.host, "Approve").className.includes("primary"));
    assert.ok(button(m.host, "Deny").className.includes("danger"));
    assert.ok(button(m.host, "Ask for clarification").disabled, "clarify needs a message");
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("RUL-01: a refused Approve shows the server's plain sentence in an alert; the buttons come back", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } } });
    stub.fail.item_decide = { status: 409, code: "already_decided", message: "The item was already answered (deny)." };
    const m = await mount(inbox());
    await click(button(m.host, "Approve"));
    await flush();
    assert.deepEqual(alerts(m.host), ["The item was already answered (deny)."]);
    assert.ok(!button(m.host, "Approve").disabled);
    await m.unmount();
  });

  it("RUL-01: Deny, Mark as seen and the selects show a plain message for an upstream error, a lost network and a signed-out session", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } } });
    const m = await mount(inbox());
    stub.fail.item_decide = { status: 500, code: "internal_error" };
    await click(button(m.host, "Deny"));
    await flush();
    assert.deepEqual(alerts(m.host), ["Something went wrong. Try again in a moment."]);
    stub.fail.item_ack = { status: 401, code: "session_required" };
    await click(button(m.host, "Mark as seen"));
    await flush();
    assert.match(alerts(m.host)[0] ?? "", /signed out/);
    stub.fail.item_ack = undefined;
    stub.networkDown = true;
    await pick(m.host, "Priority", "Low");
    assert.match(alerts(m.host)[0] ?? "", /reach the app/);
    await pick(m.host, "Snooze", "1 hour");
    assert.match(alerts(m.host)[0] ?? "", /reach the app/);
    for (const text of alerts(m.host)) assert.doesNotMatch(text, /raw upstream/);
    await m.unmount();
  });

  it("an answer sends the read version and the message, then says so; a double click sends one call", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } } });
    let release = () => {};
    stub.gate.item_decide = new Promise<void>((r) => {
      release = r;
    });
    const m = await mount(inbox());
    const approve = button(m.host, "Approve");
    await act(async () => {
      approve.click();
      approve.click();
    });
    assert.ok(approve.disabled && button(m.host, "Deny").disabled);
    release();
    await flush();
    assert.equal(decides().length, 1);
    assert.deepEqual(decides()[0]?.input, { itemId: ITEM, version: 1, response: "approve" });
    assert.match(m.host.querySelector(".detail .tb-notice.live")?.textContent ?? "", /Answer sent/);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("a stale answer asks the owner to read the new message first", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } } });
    stub.answers.item_get = item();
    const m = await mount(inbox());
    stub.fail.item_decide = { status: 409, code: "stale_version", message: "x" };
    stub.answers.item_get = item({ version: 2, messages: [{ id: "m2", author: "agent", body: "New fact.", createdAt: now }] });
    await click(button(m.host, "Approve"));
    await flush();
    const texts = alerts(m.host);
    assert.ok(texts.some((t) => t.includes("The agent added a message while you were reading. Read it, then answer again.")), texts.join(" | "));
    assert.ok(texts.some((t) => t.includes("Read it before you answer.")), texts.join(" | "));
    assert.match(m.host.querySelector(".msgs")?.textContent ?? "", /New fact\./);
    await click(button(m.host, "I have read it"));
    assert.equal(m.host.querySelector(".tb-notice.needs-you button"), null, "the unread notice is gone once read");
    await m.unmount();
  });
});

describe("Open in <app> (R5, inbox_ask open)", () => {
  it("an item with open shows one Open in <app> link to the Portal URL (new tab, no opener); the label is text", async () => {
    const url = "https://portal.example.test/w/wsp_1/open?product=observer&path=%2Freview%2Frec_1";
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } }, item_get: item({ from: { type: "app", id: "ins_9", name: "Observer" }, open: { url, app: "<b>Observer</b>" } }) });
    const m = await mount(inbox());
    const links = [...m.host.querySelectorAll(".detail a")].filter((x) => x.textContent?.startsWith("Open in "));
    assert.equal(links.length, 1);
    assert.equal(links[0]?.textContent, "Open in <b>Observer</b>");
    assert.equal(links[0]?.getAttribute("href"), url);
    assert.equal(links[0]?.getAttribute("target"), "_blank");
    assert.match(links[0]?.getAttribute("rel") ?? "", /noopener/);
    assert.equal(m.host.querySelector(".detail a b"), null, "the label is never parsed as markup");
    await m.unmount();
  });

  it("an item without open shows no Open in link", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } }, item_get: item() });
    const m = await mount(inbox());
    assert.ok(![...m.host.querySelectorAll(".detail a")].some((x) => x.textContent?.startsWith("Open in ")));
    await m.unmount();
  });
});

describe("Inbox list", () => {
  it("RUL-14: a failed list load is an alert with Try again, not an empty state", async () => {
    reset();
    stub.fail.items_list = { status: 500, code: "internal_error" };
    const m = await mount(h(pages.InboxPage, { selected: null, onSelect: () => {}, onCounts: () => {}, hrefOf: (id: string) => `items/${id}` }));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".inbox .ruled .tb-empty"), null);
    assert.equal(m.host.querySelectorAll(".inbox-row").length, 0);
    stub.fail.items_list = undefined;
    stub.answers.items_list = { items: [{ ...item(), snoozedUntil: null }], nextCursor: null, counts: { pending: 1, snoozed: 0 } };
    await click(button(m.host, "Try again"));
    await flush();
    assert.equal(m.host.querySelectorAll(".inbox-row").length, 1);
    await m.unmount();
  });
});

describe("Withdrawn item (inbox_withdraw)", () => {
  const MARKUP = `<img src=x onerror="globalThis.__pwned = 1"> Answered in <b>Creative</b>`;
  const withdrawn = (over: Record<string, unknown> = {}) =>
    item({
      from: { type: "app", id: "ins_1", name: "Creative" },
      status: "expired",
      withdrawn: true,
      withdrawal: { at: now, reason: MARKUP },
      activity: [
        { id: "act_1", kind: "withdraw_refused", actor: { type: "app", id: "ins_2", product: "kanban", name: "Task Board" }, detail: "not_raiser", count: 1, at: now },
        { id: "act_2", kind: "withdrawn", actor: { type: "app", id: "ins_1", product: "creative", name: "Creative" }, detail: MARKUP, count: 1, at: now },
      ],
      ...over,
    });

  it("shows Withdrawn by <app label> with the reason as text (escaped), no answer buttons, and no timeout notice", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } }, item_get: withdrawn() });
    const m = await mount(inbox());
    const detail = m.host.querySelector(".detail");
    assert.ok(detail);
    const notice = detail.querySelector(".tb-notice");
    assert.match(notice?.textContent ?? "", /^Withdrawn by Creative .*\. It no longer needs an answer\. Reason: /);
    assert.ok(notice?.textContent?.includes(MARKUP), "the reason is shown as written");
    assert.equal(detail.querySelector("img"), null, "agent-supplied markup is never parsed");
    assert.equal((globalThis as Record<string, unknown>).__pwned, undefined);
    assert.ok([...detail.querySelectorAll(".tb-tag")].some((t) => t.textContent === "withdrawn"));
    assert.doesNotMatch(detail.textContent ?? "", /expired before it was answered/);
    for (const label of ["Approve", "Deny", "Ask for clarification", "Mark as seen"]) assert.ok(![...detail.querySelectorAll("button")].some((b) => b.textContent?.trim() === label), `${label} is gone`);
    await m.unmount();
  });

  it("the item history names the withdraw and the refused attempt with the verified product, and escapes every value", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } }, item_get: withdrawn({ activity: [{ id: "act_3", kind: "withdraw_refused", actor: { type: "app", id: "ins_2", product: "kanban", name: "<script>x</script>Board" }, detail: "not_raiser", count: 7, at: now }, { id: "act_4", kind: "withdrawn", actor: { type: "app", id: "ins_1", product: "creative", name: "Creative" }, detail: null, count: 1, at: now }] }) });
    const m = await mount(inbox());
    const lines = [...m.host.querySelectorAll('.msgs[aria-label="History"] li')].map((li) => li.textContent ?? "");
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /^Withdraw refused for <script>x<\/script>Board \(kanban\).*not the caller that raised this item \(7 attempts\)$/);
    assert.match(lines[1] ?? "", /^Withdrawn by Creative/);
    assert.equal(m.host.querySelector(".msgs script"), null);
    await m.unmount();
  });

  it("a timed-out item (not withdrawn) still shows the timeout notice and no history", async () => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } }, item_get: item({ status: "expired" }) });
    const m = await mount(inbox());
    assert.match(m.host.querySelector(".detail")?.textContent ?? "", /This item expired before it was answered/);
    assert.equal(m.host.querySelector('.msgs[aria-label="History"]'), null);
    await m.unmount();
  });

  it("the list row of a withdrawn item reads Withdrawn, not Expired", async () => {
    reset({ items_list: { items: [withdrawn(), item({ id: "itm_02", status: "expired" })], nextCursor: null, counts: { pending: 0, snoozed: 0 } } });
    const m = await mount(h(pages.InboxPage, { selected: null, onSelect: () => {}, onCounts: () => {}, hrefOf: (id: string) => `items/${id}` }));
    const tags = [...m.host.querySelectorAll(".inbox-row")].map((r) => [...r.querySelectorAll(".tb-tag")].map((t) => t.textContent).join(","));
    assert.ok(tags[0]?.includes("Withdrawn"), tags.join(" | "));
    assert.ok(tags[1]?.includes("Expired") && !tags[1].includes("Withdrawn"), tags.join(" | "));
    await m.unmount();
  });
});

describe("All approvals", () => {
  it("names each app (production names), links to its decision page, shows the per-app read error", async () => {
    reset();
    const m = await mount(h(pages.ApprovalsPage, { onOpenItem: () => {}, itemHref: (id: string) => `items/${id}` }));
    const rows = [...m.host.querySelectorAll(".item")];
    assert.equal(rows.length, 3);
    assert.match(rows[0]?.textContent ?? "", /Task Board/);
    assert.equal(rows[0]?.querySelector("a")?.textContent, "Open in Task Board");
    assert.equal(rows[0]?.querySelector("a")?.getAttribute("href"), "https://portal.example.test/open");
    assert.equal(rows[1]?.querySelector("a")?.textContent, "Open");
    assert.match(rows[2]?.textContent ?? "", /Open Connect from Portal to decide/);
    assert.match(alerts(m.host)[0] ?? "", /Rules & Approvals: its approvals could not be read \(app_unavailable\)/);
    await m.unmount();
  });

  it("RUL-14: a failed load is an alert with Try again", async () => {
    reset();
    stub.fail.holds_overview = { status: 500, code: "internal_error" };
    const m = await mount(h(pages.ApprovalsPage, { onOpenItem: () => {}, itemHref: (id: string) => id }));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    stub.fail.holds_overview = undefined;
    await click(button(m.host, "Try again"));
    await flush();
    assert.equal(m.host.querySelectorAll(".item").length, 3);
    await m.unmount();
  });
});

describe("Settings: digest and quiet hours (C263)", () => {
  it("quiet hours On pre-fills the browser zone as a suggestion; nothing is sent before Save; Save sends the window and the zone", async () => {
    reset();
    const m = await mount(h(pages.SettingsPage, {}));
    await pick(m.host, "Quiet hours", "On, every day");
    const zone = [...m.host.querySelectorAll(".tb-field")].find((x) => x.querySelector(".tb-label")?.textContent === "Your time zone")?.querySelector("input") as HTMLInputElement | null;
    assert.ok(zone, `the time zone field is shown: ${[...m.host.querySelectorAll(".tb-label")].map((l) => l.textContent).join("|")}`);
    assert.equal(zone.value, Intl.DateTimeFormat().resolvedOptions().timeZone, "the browser zone is the suggestion");
    assert.equal(stub.calls.filter((c) => c.op === "alerts_set").length, 0, "a suggestion is not saved");
    await click(button(m.host, "Save"));
    await flush();
    const sent = stub.calls.filter((c) => c.op === "alerts_set");
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0]?.input.quietHours, sent[0]?.input.timeZone], [{ start: "22:00", end: "07:00" }, Intl.DateTimeFormat().resolvedOptions().timeZone]);
    await m.unmount();
  });

  it("a digest shows the window choice and saves delivery digest with the chosen window; dm Off hides all of it", async () => {
    reset();
    const m = await mount(h(pages.SettingsPage, {}));
    assert.ok(![...m.host.querySelectorAll(".tb-label")].some((l) => l.textContent === "Digest"), "no window choice for one DM per item");
    await pick(m.host, "Send", "A digest");
    await pick(m.host, "Digest", "Every 3 hours");
    await click(button(m.host, "Save"));
    await flush();
    const sent = stub.calls.filter((c) => c.op === "alerts_set");
    assert.deepEqual([sent[0]?.input.delivery, sent[0]?.input.digestEveryMin], ["digest", 180]);
    await pick(m.host, "Direct message", "Off");
    assert.ok(![...m.host.querySelectorAll(".tb-label")].some((l) => l.textContent === "Send" || l.textContent === "Quiet hours"));
    await m.unmount();
  });
});

describe("Item alert line (C263)", () => {
  const line = async (digest: unknown, deliveries: unknown[] = []) => {
    reset({ items_list: { items: [], nextCursor: null, counts: { pending: 0, snoozed: 0 } }, item_get: item({ digest, deliveries }) });
    const m = await mount(inbox());
    const text = [...m.host.querySelectorAll(".detail .tb-hint")].map((p) => p.textContent ?? "").filter((t) => t.startsWith("Alert:"));
    await m.unmount();
    return text;
  };
  it("names the digest state; a delivery waiting for quiet hours says so; no line without either", async () => {
    assert.match((await line({ status: "next", at: later, error: null }))[0] ?? "", /^Alert: in the next digest \(about /);
    assert.match((await line({ status: "sent", at: now, error: null }))[0] ?? "", /^Alert: sent in the digest /);
    assert.equal((await line({ status: "held", at: now, error: null }))[0], "Alert: the digest waits for your approval in Connect");
    assert.equal((await line({ status: "failed", at: now, error: "no_grant" }))[0], "Alert: the digest failed (Connect is not in this workspace)");
    const quiet = await line(null, [{ id: "dlv_1", channel: "buzz", status: "pending", holdId: null, error: "quiet_hours", attempts: 0, updatedAt: now }]);
    assert.equal(quiet[0], "Alert: Buzz DM pending (waits for your quiet hours to end)");
    assert.deepEqual(await line(null), []);
  });
});

describe("Settings", () => {
  it("saves the alert settings; a refused save shows the server's sentence in an alert", async () => {
    reset();
    const m = await mount(h(pages.SettingsPage, {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Settings");
    await click(button(m.host, "Save"));
    await flush();
    assert.equal(stub.calls.filter((c) => c.op === "alerts_set").length, 1);
    assert.match(m.host.querySelector(".tb-notice.live")?.textContent ?? "", /Saved\./);
    stub.fail.alerts_set = { status: 400, code: "alerts_invalid", message: "buzzTo must be your Buzz key (npub1… or 64 hex characters)." };
    await click(button(m.host, "Save"));
    await flush();
    assert.deepEqual(alerts(m.host), ["buzzTo must be your Buzz key (npub1… or 64 hex characters)."]);
    await m.unmount();
  });

  it("RUL-14: a failed load is an alert with Try again, not a blank form", async () => {
    reset();
    stub.fail.alerts_get = { status: 500, code: "internal_error" };
    const m = await mount(h(pages.SettingsPage, {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".tb-section"), null);
    stub.fail.alerts_get = undefined;
    await click(button(m.host, "Try again"));
    await flush();
    assert.ok(m.host.querySelector(".tb-section"));
    await m.unmount();
  });
});
