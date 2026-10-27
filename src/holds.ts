// Holds overview (C84, G4): everything that waits for the owner in one list.
// Spec 0.1.13: the standard op `tb.holds_pending` on every app, reached through the wildcard companion
// (`product: "*"`, M-CP-3) that Core grants only after the owner's explicit consent at deploy (revocable). The SDK's
// `ctx.companionTargets()` names the apps this instance holds grants for; without consent there are none (or the call
// is refused), and the overview says so. Deciding stays in the owning app: each row carries a Portal link
// (`/w/<ws>/open?product=<app>&path=/holds/<id>`, C86) that opens that app's decision page with a launch ticket.
import type { AppDefinition, HoldsPendingItem, HoldsPendingOutput, Json } from "@opt2-tealbrick/miniapp-sdk";
import type { ItemSummary } from "./store.ts";

type Manifest = AppDefinition["manifest"];

export const HOLDS_PENDING_OP = "tb.holds_pending";
export const SELF = "inbox";
/** Per app: at most this many pages of 100 (the overview shows the oldest first; more is a sign to open the app). */
const MAX_PAGES = 3;
export const CALL_TIMEOUT_MS = 5000;

export interface OverviewRow {
  product: string;
  id: string;
  op: string;
  family: string | null;
  reason: string | null;
  summary: string;
  caller: { type: "agent" | "app" | "person"; id: string; name: string };
  createdAt: string;
  ageS: number;
  decidePath: string;
  openUrl: string | null;
  /** C277 A2 (RU-11): Rules hold only: the Portal link that opens Rules with a NEW allow rule prefilled; null for every other row. */
  allowAlwaysUrl: string | null;
}

export interface Overview {
  source: "inbox_only" | "all_apps";
  unavailable: string | null;
  rows: OverviewRow[];
  errors: { product: string; code: string }[];
}

export interface OverviewDeps {
  manifest: Pick<Manifest, "companions">;
  companionTargets(): string[];
  callApp(product: string, op: string, input: Json): Promise<unknown>;
  ownerLink(path: string): string | null;
  /** ctx.ownerLinkFor: the Portal link to `path` in another app; null when that app is not installed; may throw on a bad product or path */
  ownerLinkFor(product: string, path: string): string | null;
  now: number;
}

/** True when this build declares the cross-app holds companion (spec 0.1.13 and later). */
export function holdsPendingDeclared(manifest: Pick<Manifest, "companions">): boolean {
  return (manifest.companions ?? []).some((c) => (c.product as string) === "*" && c.operations.includes(HOLDS_PENDING_OP));
}

export const NO_CONSENT =
  "Pending approvals of other apps appear here when you allow Operator Inbox to see them (Portal: Operator Inbox settings, “This app can see the pending approvals of all apps”). Until then, open each app's Holds page from Portal.";

export const itemPath = (id: string) => `/items/${id}`;

/** Portal link that opens `product` at `path`. ownerLink names this app; the same route takes any product (C86). */
export function linkFor(ownerLink: (path: string) => string | null, product: string, path: string): string | null {
  let own: string | null;
  try {
    own = ownerLink(path);
  } catch {
    return null; // path_invalid: never link a path the launch rule refuses
  }
  if (!own) return null;
  const url = new URL(own);
  url.searchParams.set("product", product);
  return url.toString();
}

const HOLD_ID = /^hld_[0-9A-HJKMNP-TV-Z]{26}$/;

export const RULES = "rules";
/** `heldBy` of a hold that the Rules app's before hook made (`<product>/<hookId>`, SDK receipts; C277 A2). */
export const RULES_GATE = "rules/rules_gate";
const AGENT_ID = /^agt_[0-9A-Za-z]{1,64}$/;
const PRODUCT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const TOOL = /^[\x21-\x7e]{1,128}$/;

/**
 * "Allow always…" (C277 A2, RU-11): for a hold that Rules made (family `policy`, heldBy `rules/rules_gate`) the Portal link
 * that opens Rules at "new allow rule" with the hold's app, op and caller prefilled. Inbox decides and saves nothing; the
 * owner reviews and saves the rule in Rules. Returns null for every other hold, for an app caller without a verified
 * product or an agent id that is not well formed (a rule must never be prefilled wider than the hold), and when Rules is
 * not installed (ownerLinkFor answers null) or refuses the path.
 */
export function allowAlwaysLink(
  h: Pick<HoldsPendingItem, "id" | "op" | "family" | "heldBy" | "caller"> & { tool?: unknown },
  product: string,
  ownerLinkFor: OverviewDeps["ownerLinkFor"],
): string | null {
  if (h.family !== "policy" || h.heldBy !== RULES_GATE) return null;
  if (!PRODUCT_ID.test(product) || typeof h.op !== "string" || h.op === "" || h.op.length > 64) return null;
  const q = new URLSearchParams({ new: "allow", product, op: h.op });
  if (typeof h.tool === "string" && TOOL.test(h.tool)) q.set("tool", h.tool);
  if (h.caller?.type === "agent") {
    if (typeof h.caller.id !== "string" || !AGENT_ID.test(h.caller.id)) return null;
    q.set("agent", h.caller.id);
  } else if (h.caller?.type === "app") {
    const cp = h.caller.product as string | undefined;
    if (typeof cp !== "string" || !PRODUCT_ID.test(cp)) return null;
    q.set("callerProduct", cp);
  } else return null;
  if (typeof h.id === "string" && HOLD_ID.test(h.id)) q.set("hold", h.id);
  try {
    return ownerLinkFor(RULES, `/?${q.toString()}`);
  } catch {
    return null; // path_invalid / product_invalid: never link what the launch rule refuses
  }
}

export function inboxRows(items: readonly ItemSummary[], deps: Pick<OverviewDeps, "ownerLink" | "now">): OverviewRow[] {
  return items.map((i) => ({
    product: SELF,
    id: i.id,
    op: "inbox_ask",
    family: null,
    reason: i.kind === "approval" ? "approval requested" : "question",
    summary: i.title,
    caller: i.from,
    createdAt: i.createdAt,
    ageS: Math.max(0, Math.floor((deps.now - Date.parse(i.createdAt)) / 1000)),
    decidePath: itemPath(i.id),
    openUrl: linkFor(deps.ownerLink, SELF, itemPath(i.id)),
    allowAlwaysUrl: null,
  }));
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** Copies only the summary fields (never trusts the shape of another app's answer; no payload can pass through). */
function rowOf(product: string, h: HoldsPendingItem, deps: Pick<OverviewDeps, "ownerLink" | "ownerLinkFor" | "now">): OverviewRow | null {
  if (!h || typeof h.id !== "string" || !HOLD_ID.test(h.id)) return null;
  const decidePath = `/holds/${h.id}`;
  const created = typeof h.createdAt === "string" && Number.isFinite(Date.parse(h.createdAt)) ? h.createdAt : new Date(deps.now).toISOString();
  const ct = h.caller?.type === "app" ? "app" : "agent";
  return {
    product,
    id: h.id,
    op: text(h.op, 64) ?? "",
    family: text(h.family, 32),
    reason: text(h.reason, 280),
    summary: text(h.summary, 280) ?? "",
    caller: { type: ct, id: text(h.caller?.id, 64) ?? "", name: text(h.caller?.name, 80) ?? "" },
    createdAt: created,
    ageS: Math.max(0, Math.floor((deps.now - Date.parse(created)) / 1000)),
    decidePath,
    openUrl: linkFor(deps.ownerLink, product, decidePath),
    allowAlwaysUrl: allowAlwaysLink(h, product, deps.ownerLinkFor),
  };
}

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" && c ? c.slice(0, 64) : "unavailable";
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function pendingOf(product: string, deps: OverviewDeps): Promise<OverviewRow[]> {
  const rows: OverviewRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await withTimeout(deps.callApp(product, HOLDS_PENDING_OP, { limit: 100, ...(cursor ? { cursor } : {}) }), CALL_TIMEOUT_MS)) as
      | { status: "ok"; output: HoldsPendingOutput }
      | { status: "held" };
    // a policy may hold even this read; the owner sees that instead of a silent gap
    if (r?.status !== "ok") throw Object.assign(new Error("held"), { code: r?.status === "held" ? "held" : "bad_answer" });
    for (const h of Array.isArray(r.output?.items) ? r.output.items : []) {
      const row = rowOf(product, h, deps);
      if (row) rows.push(row);
    }
    cursor = typeof r.output?.nextCursor === "string" && r.output.nextCursor ? r.output.nextCursor : null;
    if (!cursor) break;
  }
  return rows;
}

export async function overview(deps: OverviewDeps, items: readonly ItemSummary[]): Promise<Overview> {
  const own = inboxRows(items, deps);
  if (!holdsPendingDeclared(deps.manifest)) return { source: "inbox_only", unavailable: NO_CONSENT, rows: own, errors: [] };
  const targets = deps.companionTargets().filter((p) => p !== SELF && p !== "*");
  if (targets.length === 0) return { source: "inbox_only", unavailable: NO_CONSENT, rows: own, errors: [] };
  const results = await Promise.allSettled(targets.map((p) => pendingOf(p, deps)));
  const rows = [...own];
  const errors: Overview["errors"] = [];
  results.forEach((r, i) => {
    const product = targets[i] as string;
    if (r.status === "fulfilled") rows.push(...r.value);
    else errors.push({ product, code: codeOf(r.reason) });
  });
  rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
  // every app refused (consent revoked: grants gone) → say so, like no consent
  const refusedAll = errors.length === targets.length && errors.every((e) => ["not_granted", "no_grant", "grant_invalid", "grant_revoked"].includes(e.code));
  return { source: "all_apps", unavailable: refusedAll ? NO_CONSENT : null, rows, errors };
}
