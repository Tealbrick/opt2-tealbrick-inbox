// The filter of the Inbox and All approvals pages (C382 batch 4). These lists hold what the owner must act on, so a filter
// that hides items says how many it hides (an alert), the Inbox list is paged (Show more reads the next page), and a
// remembered filter is visible after a reload. Each item stays its own decision: no bulk action and no default filter.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-lists-filter");

const win = new Window({ url: "http://localhost/a/inbox/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "localStorage", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date().toISOString();
const later = new Date(Date.now() + 86_400_000).toISOString();
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `itm_${String(n).padStart(26, "0")}`,
  kind: n % 2 ? "approval" : "question",
  title: `Item number ${n}`,
  from: { type: "agent", id: "agt_1", name: n % 3 ? "Scout" : "Front desk" },
  status: "open",
  priority: "normal",
  acked: false,
  snoozedUntil: null,
  response: null,
  version: 1,
  withdrawn: false,
  createdAt: now,
  updatedAt: now,
  expiresAt: later,
  ...over,
});
const approval = (n: number) => ({
  product: n % 2 ? "kanban" : "connect",
  id: `hld_${n}`,
  op: "issue_delete",
  family: null,
  reason: null,
  summary: `Approval number ${n}`,
  caller: { type: "agent", id: "a", name: n % 3 ? "Scout" : "Front desk" },
  createdAt: now,
  ageS: 60,
  decidePath: `/holds/hld_${n}`,
  openUrl: `https://portal.example.test/open/${n}`,
  allowAlwaysUrl: null,
});

const PAGE = 100;
const stub = { calls: [] as { op: string; input: Record<string, unknown> }[], items: [] as ReturnType<typeof item>[], approvals: [] as ReturnType<typeof approval>[] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/inbox/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  const inp = body.input ?? {};
  stub.calls.push({ op, input: inp });
  if (op === "items_list") {
    const from = inp.cursor ? Number(inp.cursor) : 0;
    const limit = Number(inp.limit ?? PAGE);
    const out = stub.items.slice(from, from + limit);
    return json(200, { status: "ok", output: { items: out, nextCursor: from + limit < stub.items.length ? String(from + limit) : null, counts: { pending: stub.items.length, snoozed: 0 } } });
  }
  if (op === "holds_overview") return json(200, { status: "ok", output: { source: "all_apps", unavailable: null, rows: stub.approvals, errors: [] } });
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
const open: { unmount: () => Promise<void> }[] = [];
// a test that fails before its own unmount must not leave a page (and its refresh timer) running
afterEach(async () => {
  for (const m of open.splice(0)) await m.unmount();
});
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "inbox" }, el)));
  await flush();
  let gone = false;
  const m = {
    host,
    unmount: async () => {
      if (gone) return;
      gone = true;
      await act(async () => r.unmount());
      host.remove();
    },
  };
  open.push(m);
  return m;
}
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const buttons = (host: Element, label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
const input = (host: Element) => host.querySelector("input") as HTMLInputElement;
const text = (host: Element) => (host.textContent ?? "").replace(/\s+/g, " ");
const alertText = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");
const KEY = "tb-filter:inbox:";
const remember = (screen: string, v: string) => localStorage.setItem(`${KEY}${screen}`, v);
const reset = () => {
  localStorage.clear();
  stub.calls = [];
  stub.items = [];
  stub.approvals = [];
};

type Pages = {
  InboxPage: (p: { selected: string | null; onSelect: (id: string) => void; onCounts: (n: number) => void; hrefOf: (id: string) => string }) => ReactElement;
  ApprovalsPage: (p: { onOpenItem: (id: string) => void; itemHref: (id: string) => string }) => ReactElement;
};
let pages: Pages;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const at = (f: string) => import(pathToFileURL(join(outDir, "ui", f)).href);
  pages = { ...(await at("inbox.js")), ...(await at("approvals.js")) } as Pages;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const inbox = () => mount(h(pages.InboxPage, { selected: null, onSelect: () => {}, onCounts: () => {}, hrefOf: (id: string) => `items/${id}` }));
const approvalsPage = () => mount(h(pages.ApprovalsPage, { onOpenItem: () => {}, itemHref: (id: string) => `items/${id}` }));
const rowsOf = (host: Element) => host.querySelectorAll("nav.ruled a.inbox-row");

describe("Inbox filter", () => {
  it("a short list shows no filter bar", async () => {
    reset();
    stub.items = [item(1), item(2)];
    const m = await inbox();
    assert.equal(rowsOf(m.host).length, 2);
    assert.equal(input(m.host), null);
    await m.unmount();
  });

  it("a long list: the filter shows N of M, announces the waiting items it hides, and Clear brings every item back", async () => {
    reset();
    stub.items = Array.from({ length: 10 }, (_, i) => item(i));
    const m = await inbox();
    assert.equal(rowsOf(m.host).length, 10);
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
    await type(input(m.host), "number 7");
    assert.equal(rowsOf(m.host).length, 1);
    assert.match(text(m.host), /Showing 1 of 10 items\./);
    assert.match(alertText(m.host), /9 items that wait for you are hidden by the filter\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(rowsOf(m.host).length, 10);
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
    await m.unmount();
  });

  it("a snoozed item that the filter hides is not counted as waiting; an answered one neither", async () => {
    reset();
    stub.items = [...Array.from({ length: 8 }, (_, i) => item(i)), item(20, { snoozedUntil: later }), item(21, { status: "answered", response: "approve" })];
    remember("inbox", "number 1\\b");
    const m = await inbox();
    assert.match(alertText(m.host), /7 items that wait for you are hidden by the filter\./);
    await m.unmount();
  });

  it("a remembered filter is on after a reload: the bar shows the text, N of M and the hidden count", async () => {
    reset();
    stub.items = [item(1), item(2), item(3)];
    remember("inbox", "number 2");
    const m = await inbox();
    assert.equal(input(m.host).value, "number 2");
    assert.match(text(m.host), /Showing 1 of 3 items\./);
    assert.match(alertText(m.host), /2 items that wait for you are hidden by the filter\./);
    await m.unmount();
  });

  it("a paged list: no match says the filter read only the loaded items; Show more reads the next page and finds it", async () => {
    reset();
    stub.items = Array.from({ length: PAGE + 20 }, (_, i) => item(i));
    remember("inbox", "number 115\\b");
    const m = await inbox();
    assert.equal(rowsOf(m.host).length, 0);
    assert.match(text(m.host), /No loaded item matches\./);
    assert.match(text(m.host), new RegExp(`The filter searches only the ${PAGE} items loaded so far\\.`));
    assert.match(text(m.host), new RegExp(`Showing 0 of ${PAGE} loaded items\\.`));
    assert.ok(buttons(m.host, "Show more").length >= 1, "Show more is in reach");
    await click(buttons(m.host, "Show more")[0] as Element);
    assert.deepEqual(stub.calls.filter((c) => c.op === "items_list").at(-1)?.input, { view: "pending", limit: PAGE, cursor: String(PAGE) });
    assert.equal(rowsOf(m.host).length, 1);
    assert.match(text(m.host), /Showing 1 of 120 items\./);
    assert.doesNotMatch(text(m.host), /loaded so far/, "everything is loaded now");
    assert.equal(buttons(m.host, "Show more").length, 0);
    await m.unmount();
  });

  it("a complete list with no match says all items were searched", async () => {
    reset();
    stub.items = [item(1), item(2), item(3)];
    remember("inbox", "zzz");
    const m = await inbox();
    assert.match(text(m.host), /No item matches\. The filter searched all 3 items\./);
    await m.unmount();
  });
});

describe("All approvals filter", () => {
  it("a short list shows no filter bar", async () => {
    reset();
    stub.approvals = [approval(1), approval(2)];
    const m = await approvalsPage();
    assert.equal(m.host.querySelectorAll(".item").length, 2);
    assert.equal(input(m.host), null);
    await m.unmount();
  });

  it("a long list: the filter shows N of M, counts the approvals it hides as an alert, keeps each row's own Open, Clear restores", async () => {
    reset();
    stub.approvals = Array.from({ length: 10 }, (_, i) => approval(i));
    const m = await approvalsPage();
    assert.equal(m.host.querySelectorAll(".item").length, 10);
    await type(input(m.host), "number 7");
    assert.equal(m.host.querySelectorAll(".item").length, 1);
    assert.match(text(m.host), /Showing 1 of 10 approvals\./);
    assert.match(alertText(m.host), /9 approvals that wait for you are hidden by the filter\./);
    assert.equal(m.host.querySelectorAll(".item a").length, 1, "one Open link per approval, no bulk action");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll(".item").length, 10);
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
    await m.unmount();
  });

  it("the app name is searched too, a remembered filter shows after a reload, no match says all approvals were searched", async () => {
    reset();
    stub.approvals = Array.from({ length: 9 }, (_, i) => approval(i));
    remember("approvals", "Task Board");
    const m = await approvalsPage();
    assert.equal(input(m.host).value, "Task Board");
    assert.equal(m.host.querySelectorAll(".item").length, 4);
    assert.match(text(m.host), /Showing 4 of 9 approvals\./);
    await m.unmount();
    remember("approvals", "zzz");
    const again = await approvalsPage();
    assert.match(text(again.host), /No approval matches\. The filter searched all 9 approvals\./);
    assert.match(alertText(again.host), /9 approvals that wait for you are hidden by the filter\./);
    await again.unmount();
  });
});
