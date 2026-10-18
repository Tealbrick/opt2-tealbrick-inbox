// Inbox domain over the app's own tables (migrations/0001_init.sql). Plain functions over the SDK's Db with an
// explicit `now`, so handlers stay thin and tests drive them directly. Every state change is one transaction and is
// guarded in SQL (`WHERE status = 'open' …`, changes === 1): a duplicate, stale or expired answer fails closed.
import { ulid } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";

export const KINDS = ["approval", "question"] as const;
export const RESPONSES = ["approve", "deny", "answer", "clarify"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Kind = (typeof KINDS)[number];
export type Response = (typeof RESPONSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Status = "open" | "answered" | "expired";

/** Allowed answers per kind; the first list is also the default. */
export const KIND_RESPONSES: Record<Kind, readonly Response[]> = {
  approval: ["approve", "deny", "clarify"],
  question: ["answer", "clarify"],
};
/** These answers carry the owner's words; without a message they are refused. */
export const NEEDS_MESSAGE: ReadonlySet<Response> = new Set(["answer", "clarify"]);

export const DEFAULT_EXPIRY_S = 7 * 24 * 3600;
export const MAX_SNOOZE_MS = 30 * 24 * 3600 * 1000;
/** Open items one caller may have at a time (a looping agent must not flood the owner). */
export const MAX_OPEN_PER_CALLER = 100;

export interface From {
  type: "agent" | "app" | "person";
  id: string;
  name: string;
}

/**
 * The VERIFIED caller of an agent op, as the SDK hands it over (ctx.caller): the type, the id (agent id or app
 * instance id) and, for an app, the product from the verified grant. `name` is display text and never an identity.
 */
export interface Actor extends From {
  /** the verified product of an app caller; null for an agent and for an app whose product is not known */
  product: string | null;
}

export interface ItemSummary {
  id: string;
  kind: Kind;
  title: string;
  from: From;
  status: Status;
  priority: Priority;
  acked: boolean;
  snoozedUntil: string | null;
  response: Response | null;
  version: number;
  /** closed by its raiser through inbox_withdraw (status is `expired`) */
  withdrawn: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface Message {
  id: string;
  author: "agent" | "owner";
  body: string;
  createdAt: string;
}

export interface Decision {
  response: Response;
  message: string | null;
  decidedBy: string;
  decidedAt: string;
}

export interface DeliveryView {
  id: string;
  channel: "buzz" | "channel";
  status: "pending" | "sent" | "held" | "failed";
  holdId: string | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

export interface Withdrawal {
  at: string;
  reason: string | null;
}

/** One line of the item history: a withdraw, or a refused attempt to withdraw (the caller as the SDK verified it). */
export interface ActivityView {
  id: string;
  kind: "withdrawn" | "withdraw_refused";
  actor: { type: From["type"]; id: string; product: string | null; name: string };
  detail: string | null;
  /** how many identical entries this line stands for (refused attempts of one actor with one cause are folded); 1 for a withdraw */
  count: number;
  /** the time of the newest entry of the line */
  at: string;
}

export interface ItemDetail extends ItemSummary {
  context: string | null;
  responses: Response[];
  messages: Message[];
  decision: Decision | null;
  deliveries: DeliveryView[];
  withdrawal: Withdrawal | null;
  activity: ActivityView[];
  /** R5: the raising app's page for this item (inbox_ask open), or null */
  open: { url: string; app: string } | null;
}

/** Builds the Portal link to `path` in `product` (ctx.ownerLinkFor); null when unknown. May throw on a bad product or path. */
export type LinkFor = (product: string, path: string) => string | null;

type Row = Record<string, unknown>;
const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function notFound(): never {
  throw new TbError("item_not_found", "No such item.", 404);
}

function toSummary(r: Row, now: number): ItemSummary {
  const snoozed = r.snoozed_until === null || r.snoozed_until === undefined ? null : Number(r.snoozed_until);
  return {
    id: String(r.id),
    kind: r.kind as Kind,
    title: String(r.title),
    from: { type: r.from_type as From["type"], id: String(r.from_id), name: String(r.from_name) },
    status: r.status as Status,
    priority: r.priority as Priority,
    acked: r.acked_at !== null && r.acked_at !== undefined,
    // a passed snooze is no snooze: the item is pending again without a write
    snoozedUntil: r.status === "open" && snoozed !== null && snoozed > now ? iso(snoozed) : null,
    response: (str(r.response) as Response | null) ?? null,
    version: Number(r.version),
    withdrawn: r.withdrawn_at !== null && r.withdrawn_at !== undefined,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    expiresAt: iso(r.expires_at),
  };
}

const SELECT = `SELECT i.*, d.response AS response FROM inbox_items i LEFT JOIN inbox_decisions d ON d.item_id = i.id`;

function row(db: Db, id: string): Row | undefined {
  return db.prepare(`${SELECT} WHERE i.id = ?`).get(id);
}

/** Expires every open item whose time has passed (lazy sweep, run at the start of each op). */
export function expireDue(db: Db, now: number): number {
  return Number(db.prepare("UPDATE inbox_items SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at <= ?").run(now, now).changes);
}

// ── agent side ──

export interface AskInput {
  kind: Kind;
  title: string;
  context?: string;
  responses?: Response[];
  priority?: Priority;
  expiresInS?: number;
  /** R5: a page of the calling app; the handler accepts it only from an app with a verified product and a valid launch path */
  open?: { path: string };
}

/** `from.product` (an app's VERIFIED product) is recorded with the item: inbox_withdraw matches on it. */
export function ask(db: Db, from: From & { product?: string | null }, input: AskInput, now: number): ItemSummary {
  const allowed = KIND_RESPONSES[input.kind];
  const responses = input.responses ?? [...allowed];
  const wrong = responses.filter((r) => !allowed.includes(r));
  if (wrong.length > 0)
    throw new TbError("response_not_allowed", `A ${input.kind} item allows only ${allowed.join(", ")}; not ${wrong.join(", ")}.`, 400);
  if (input.kind === "approval" && !responses.some((r) => r === "approve" || r === "deny"))
    throw new TbError("response_not_allowed", "An approval item must allow approve or deny.", 400);
  const open = Number(db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE from_id = ? AND status = 'open'").get(from.id)?.n ?? 0);
  if (open >= MAX_OPEN_PER_CALLER)
    throw new TbError("too_many_open_items", `You have ${open} open items. Wait for answers or let some expire before asking again.`, 429);
  const id = `itm_${ulid(now)}`;
  const expiresAt = now + (input.expiresInS ?? DEFAULT_EXPIRY_S) * 1000;
  db.prepare(
    `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, from_product, open_path, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.title,
    input.context ?? null,
    JSON.stringify(responses),
    from.type,
    from.id,
    from.name,
    from.type === "app" && from.product ? from.product : null,
    // a page of the raising app only: never stored without the verified product it will be linked to
    from.type === "app" && from.product && input.open ? input.open.path : null,
    input.priority ?? "normal",
    now,
    now,
    expiresAt,
  );
  return toSummary(row(db, id) as Row, now);
}

/** The caller of an agent op as the SDK verified it: type, id, and an app's verified product (null when not known). */
export type Caller = Pick<Actor, "type" | "id" | "product">;

/**
 * An item belongs to the caller that raised it: the same type and the same id (agent id or app instance id); for an app
 * also the same verified product when the item recorded one. A recorded product never matches a caller without that
 * verified product (fail closed). Items without a recorded product (raised before migration 0002, or through a bridge
 * that did not sign the product yet, C243) match on type and instance id, as before; the instance id comes from the
 * verified grant too, so only an instance id collision could cross products there. A caller that arrives WITHOUT a
 * product (e.g. through an older bridge) reads `unknown` on an item that recorded one: it should retry or ask again, never
 * treat `unknown` as a refusal. inbox_withdraw is stricter (raisedBy): it needs a recorded product for an app.
 * Refused status/reply calls leave no history row (read path, no write); only inbox_withdraw records refused attempts.
 */
function ownedBy(r: Row, c: Caller): boolean {
  if (c.type === "person" || r.from_type !== c.type || r.from_id !== c.id) return false;
  if (c.type === "agent") return true;
  const recorded = r.from_product === null || r.from_product === undefined || r.from_product === "" ? null : String(r.from_product);
  return recorded === null || recorded === c.product;
}

/** An item as its creator sees it; another caller's item is "not found" (no existence leak). */
function ownRow(db: Db, caller: Caller, itemId: string): Row {
  const r = row(db, itemId);
  if (!r || !ownedBy(r, caller)) notFound();
  return r;
}

export interface AgentStatus {
  itemId: string;
  kind: Kind | null;
  status: Status | "unknown";
  seenByOwner: boolean;
  response: Response | null;
  message: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
}

/** An unknown id, or another caller's item, reads as `unknown` (no existence leak; never an approval). */
export function status(db: Db, caller: Caller, itemId: string): AgentStatus {
  const r = row(db, itemId);
  if (!r || !ownedBy(r, caller))
    return { itemId, kind: null, status: "unknown", seenByOwner: false, response: null, message: null, decidedAt: null, expiresAt: null };
  const d = db.prepare("SELECT response, message, decided_at FROM inbox_decisions WHERE item_id = ?").get(itemId);
  return {
    itemId,
    kind: r.kind as Kind,
    status: r.status as Status,
    seenByOwner: r.acked_at !== null || d !== undefined,
    response: d ? (String(d.response) as Response) : null,
    message: d ? str(d.message) : null,
    decidedAt: d ? iso(d.decided_at) : null,
    expiresAt: iso(r.expires_at),
  };
}

export function reply(db: Db, caller: Caller, itemId: string, body: string, now: number): { itemId: string; messageId: string } {
  return db.transaction(() => {
    const r = ownRow(db, caller, itemId);
    if (r.status !== "open") throw new TbError("item_closed", `The item is ${r.status}; ask a new question instead.`, 409);
    // the version bump makes an answer the owner gave on the older text stale
    const changed = db.prepare("UPDATE inbox_items SET version = version + 1, updated_at = ? WHERE id = ? AND status = 'open'").run(now, itemId).changes;
    if (changed !== 1) throw new TbError("item_closed", "The item is no longer open.", 409);
    const messageId = `msg_${ulid(now)}`;
    db.prepare("INSERT INTO inbox_messages (id, item_id, author, author_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ?)").run(messageId, itemId, caller.id, body, now);
    return { itemId, messageId };
  });
}

// ── withdraw (OD-1) ──

export const WITHDRAW_RESULTS = ["withdrawn", "not_open", "unknown"] as const;
export type WithdrawResult = (typeof WITHDRAW_RESULTS)[number];
export interface WithdrawOutcome {
  itemId: string;
  result: WithdrawResult;
  /** the item as inbox_status would show it to this caller after the call */
  status: "expired" | "answered" | "unknown";
}

/**
 * Refused attempts are written to the history at most this often (the answer is the same; the owner needs the trace, not a flood).
 * The hourly cap is counted per actor and per class: attempts on ids that do not exist (`unknown_item`) have their own cap,
 * so junk ids can never use up the budget that records a probe of a real item.
 */
export const REFUSAL_PER_ACTOR_HOUR = 20;
/** item_get shows at most this many refused-attempt lines (newest first by time); withdraw rows are always all shown. */
export const REFUSAL_LINES_SHOWN = 50;
export const REFUSAL_SAME_ITEM_MS = 10 * 60_000;
/** Refused-attempt rows older than this are removed by the background tick. */
export const REFUSAL_KEEP_MS = 30 * 24 * 3600 * 1000;
/**
 * The tick also keeps at most this many refused-attempt rows per class (newest stay), whatever the number of actors.
 * Junk ids have their own, smaller cap, so a flood of made-up ids never pushes out the trace of a probe of a real item.
 */
export const REFUSAL_CAP = 5000;
export const REFUSAL_CAP_UNKNOWN = 2000;
const DETAIL_MAX = 500;

export type RefusalCode = "unknown_item" | "not_raiser" | "no_product";

/**
 * Only the RAISER may withdraw. The match is on the verified identity recorded by inbox_ask: the same type and the
 * same id (agent id or app instance id); for an app also the same verified PRODUCT. An item whose product was never
 * recorded (raised before migration 0002), and a caller without a product, never match an app (fail closed).
 */
function raisedBy(r: Row, a: Actor): boolean {
  if (a.type === "person" || r.from_type !== a.type || r.from_id !== a.id) return false;
  if (a.type === "agent") return true;
  return a.product !== null && a.product !== "" && r.from_product !== null && r.from_product !== undefined && r.from_product === a.product;
}

/** Writes the audit row of a refused attempt, throttled; the throttle only skips the row, it never changes the answer. */
export function recordRefusal(db: Db, a: Actor, itemId: string, code: RefusalCode, now: number): void {
  // a refused call on an id that does not exist is junk whatever the cause, so it never uses the budget (or the cap)
  // that keeps the trace of a probe of a real item
  const cause: RefusalCode = code !== "unknown_item" && !row(db, itemId) ? "unknown_item" : code;
  const junk = cause === "unknown_item";
  const recent = Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM inbox_activity WHERE actor_id = ? AND kind = 'withdraw_refused' AND created_at > ? AND (detail = 'unknown_item') = ?`)
      .get(a.id, now - 3600_000, junk ? 1 : 0)?.n ?? 0,
  );
  if (recent >= REFUSAL_PER_ACTOR_HOUR) return;
  const same = db.prepare("SELECT 1 AS x FROM inbox_activity WHERE actor_id = ? AND item_id = ? AND kind = 'withdraw_refused' AND created_at > ? LIMIT 1").get(a.id, itemId.slice(0, 64), now - REFUSAL_SAME_ITEM_MS);
  if (same) return;
  db.prepare("INSERT INTO inbox_activity (id, item_id, kind, actor_type, actor_id, actor_product, actor_name, detail, created_at) VALUES (?, ?, 'withdraw_refused', ?, ?, ?, ?, ?, ?)").run(
    `act_${ulid(now)}`,
    itemId.slice(0, 64),
    a.type,
    a.id,
    a.product,
    a.name,
    cause,
    now,
  );
}

/**
 * Removes refused-attempt rows older than REFUSAL_KEEP_MS, then all but the newest rows of each class over its cap.
 * Withdraw rows are the item's history and always stay.
 */
export function pruneActivity(db: Db, now: number): number {
  let n = Number(db.prepare("DELETE FROM inbox_activity WHERE kind = 'withdraw_refused' AND created_at < ?").run(now - REFUSAL_KEEP_MS).changes);
  for (const [junk, cap] of [
    [1, REFUSAL_CAP_UNKNOWN],
    [0, REFUSAL_CAP],
  ] as const)
    n += Number(
      db
        .prepare(
          `DELETE FROM inbox_activity WHERE id IN (
             SELECT id FROM inbox_activity WHERE kind = 'withdraw_refused' AND (IFNULL(detail, '') = 'unknown_item') = ?
             ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`,
        )
        .run(junk, cap).changes,
    );
  return n;
}

/**
 * Closes an OPEN item its raiser created: status `expired`, the reason kept, one history row, unsent alerts stopped.
 * The answer for a caller that is not the raiser is exactly the answer for an id that does not exist (`unknown`, no
 * oracle). Idempotent: a second withdraw of the same item answers `withdrawn` again and changes nothing (the first
 * reason and the first history row stay). An item that is already answered, or expired by time, answers `not_open`
 * with its status. One transaction; the guarded UPDATE is the real guard.
 */
export function withdraw(db: Db, a: Actor, itemId: string, reason: string | undefined, now: number): WithdrawOutcome {
  return db.transaction(() => {
    const r = row(db, itemId);
    if (!r || !raisedBy(r, a)) {
      recordRefusal(db, a, itemId, r ? "not_raiser" : "unknown_item", now);
      return { itemId, result: "unknown" as const, status: "unknown" as const };
    }
    if (r.withdrawn_at !== null && r.withdrawn_at !== undefined) return { itemId, result: "withdrawn" as const, status: "expired" as const };
    if (r.status !== "open" || Number(r.expires_at) <= now) return { itemId, result: "not_open" as const, status: r.status === "answered" ? ("answered" as const) : ("expired" as const) };
    const why = reason?.trim() ? reason.trim().slice(0, DETAIL_MAX) : null;
    const changed = db
      .prepare("UPDATE inbox_items SET status = 'expired', withdrawn_at = ?, withdrawn_reason = ?, expires_at = MIN(expires_at, ?), snoozed_until = NULL, updated_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?")
      .run(now, why, now, now, itemId, now).changes;
    if (changed !== 1) return { itemId, result: "not_open" as const, status: "expired" as const };
    db.prepare("INSERT INTO inbox_activity (id, item_id, kind, actor_type, actor_id, actor_product, actor_name, detail, created_at) VALUES (?, ?, 'withdrawn', ?, ?, ?, ?, ?, ?)").run(
      `act_${ulid(now)}`,
      itemId,
      a.type,
      a.id,
      a.product,
      a.name,
      why,
      now,
    );
    // an alert that has not been sent yet is moot now; a sent one cannot be taken back
    db.prepare("UPDATE inbox_deliveries SET status = 'failed', error = 'withdrawn', updated_at = ? WHERE item_id = ? AND status IN ('pending', 'held')").run(now, itemId);
    return { itemId, result: "withdrawn" as const, status: "expired" as const };
  });
}

// ── owner side ──

export type View = "pending" | "snoozed" | "done" | "all";

const RANK = "CASE i.priority WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END";
const VIEWS: Record<View, { where: string; order: string; withNow: boolean }> = {
  pending: { where: "i.status = 'open' AND (i.snoozed_until IS NULL OR i.snoozed_until <= ?)", order: `${RANK} DESC, i.created_at ASC, i.id ASC`, withNow: true },
  snoozed: { where: "i.status = 'open' AND i.snoozed_until > ?", order: "i.snoozed_until ASC, i.id ASC", withNow: true },
  done: { where: "i.status <> 'open'", order: "i.updated_at DESC, i.id DESC", withNow: false },
  all: { where: "1 = 1", order: "i.created_at DESC, i.id DESC", withNow: false },
};

export function list(db: Db, view: View, limit: number, offset: number, now: number): { items: ItemSummary[]; nextCursor: string | null; counts: { pending: number; snoozed: number } } {
  const v = VIEWS[view];
  const params: unknown[] = v.withNow ? [now] : [];
  const rows = db.prepare(`${SELECT} WHERE ${v.where} ORDER BY ${v.order} LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
  const more = rows.length > limit;
  const c = db
    .prepare(
      `SELECT SUM(CASE WHEN snoozed_until IS NULL OR snoozed_until <= ? THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN snoozed_until > ? THEN 1 ELSE 0 END) AS snoozed
       FROM inbox_items WHERE status = 'open'`,
    )
    .get(now, now);
  return {
    items: rows.slice(0, limit).map((r) => toSummary(r, now)),
    nextCursor: more ? String(offset + limit) : null,
    counts: { pending: Number(c?.pending ?? 0), snoozed: Number(c?.snoozed ?? 0) },
  };
}

/** Open items, pending first (as the owner's list orders them), for the holds overview. */
export function openItems(db: Db, now: number, limit: number): ItemSummary[] {
  return db
    .prepare(`${SELECT} WHERE i.status = 'open' ORDER BY (i.snoozed_until IS NOT NULL AND i.snoozed_until > ?) ASC, ${RANK} DESC, i.created_at ASC LIMIT ?`)
    .all(now, limit)
    .map((r) => toSummary(r, now));
}

/**
 * The item history for the owner: every withdraw row, plus the refused attempts folded into one line per actor and cause
 * (with a count and the newest time), at most REFUSAL_LINES_SHOWN lines, newest first. Oldest line first in the result.
 */
function activityOf(db: Db, itemId: string): ActivityView[] {
  const withdrawn = db
    .prepare("SELECT id, actor_type, actor_id, actor_product, actor_name, detail, created_at FROM inbox_activity WHERE item_id = ? AND kind = 'withdrawn'")
    .all(itemId)
    .map((x) => ({
      id: String(x.id),
      kind: "withdrawn" as const,
      actor: { type: x.actor_type as From["type"], id: String(x.actor_id), product: str(x.actor_product), name: String(x.actor_name) },
      detail: str(x.detail),
      count: 1,
      at: Number(x.created_at),
    }));
  const refused = db
    .prepare(
      `SELECT MAX(id) AS id, actor_type, actor_id, actor_product, MAX(actor_name) AS actor_name, detail, COUNT(*) AS n, MAX(created_at) AS last
       FROM inbox_activity WHERE item_id = ? AND kind = 'withdraw_refused'
       GROUP BY actor_type, actor_id, actor_product, detail ORDER BY last DESC, id DESC LIMIT ?`,
    )
    .all(itemId, REFUSAL_LINES_SHOWN)
    .map((x) => ({
      id: String(x.id),
      kind: "withdraw_refused" as const,
      actor: { type: x.actor_type as From["type"], id: String(x.actor_id), product: str(x.actor_product), name: String(x.actor_name) },
      detail: str(x.detail),
      count: Number(x.n),
      at: Number(x.last),
    }));
  return [...withdrawn, ...refused].sort((p, q) => p.at - q.at || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)).map((x) => ({ ...x, at: iso(x.at) }));
}

/**
 * R5: the raising app's page, linked through its RECORDED verified product (never a product from any input). The label
 * is the app's name as the Portal-signed slice gave it at ask time (Core takes it from the app's signed release); the SDK
 * falls back to the instance id when the slice had no name, and then the product id is shown instead.
 */
function openOf(r: Row, linkFor: LinkFor | undefined): ItemDetail["open"] {
  const product = str(r.from_product);
  const path = str(r.open_path);
  if (!linkFor || r.from_type !== "app" || !product || !path) return null;
  let url: string | null;
  try {
    url = linkFor(product, path);
  } catch {
    return null; // product_invalid / path_invalid: never link what the launch rule refuses
  }
  if (!url) return null;
  const name = String(r.from_name);
  return { url, app: name && name !== String(r.from_id) ? name : product };
}

export function get(db: Db, itemId: string, now: number, linkFor?: LinkFor): ItemDetail {
  const r = row(db, itemId);
  if (!r) notFound();
  const messages = db
    .prepare("SELECT id, author, body, created_at FROM inbox_messages WHERE item_id = ? ORDER BY created_at ASC, id ASC")
    .all(itemId)
    .map((m) => ({ id: String(m.id), author: m.author as Message["author"], body: String(m.body), createdAt: iso(m.created_at) }));
  const d = db.prepare("SELECT response, message, decided_by, decided_at FROM inbox_decisions WHERE item_id = ?").get(itemId);
  const deliveries = db
    .prepare("SELECT id, channel, status, hold_id, error, attempts, updated_at FROM inbox_deliveries WHERE item_id = ? ORDER BY created_at ASC, id ASC")
    .all(itemId)
    .map((x) => ({
      id: String(x.id),
      channel: x.channel as DeliveryView["channel"],
      status: x.status as DeliveryView["status"],
      holdId: str(x.hold_id),
      error: str(x.error),
      attempts: Number(x.attempts),
      updatedAt: iso(x.updated_at),
    }));
  const activity = activityOf(db, itemId);
  return {
    ...toSummary(r, now),
    context: str(r.context),
    responses: JSON.parse(String(r.responses)) as Response[],
    messages,
    decision: d ? { response: String(d.response) as Response, message: str(d.message), decidedBy: String(d.decided_by), decidedAt: iso(d.decided_at) } : null,
    deliveries,
    withdrawal: r.withdrawn_at !== null && r.withdrawn_at !== undefined ? { at: iso(r.withdrawn_at), reason: str(r.withdrawn_reason) } : null,
    activity,
    open: openOf(r, linkFor),
  };
}

export interface DecideInput {
  itemId: string;
  version: number;
  response: Response;
  message?: string;
}

/**
 * The owner's answer. Fails closed, in this order: unknown item (404), expired (409 item_expired), already answered
 * (409 already_decided), the owner saw an older version (409 stale_version), a response the item does not allow
 * (409 response_not_allowed), answer/clarify without words (400 message_required). One transaction; the guarded
 * UPDATE (status open + same version) is the real duplicate guard.
 */
export function decide(db: Db, input: DecideInput, decidedBy: string, now: number): { itemId: string; status: Status; response: Response; decidedAt: string } {
  return db.transaction(() => {
    const r = row(db, input.itemId);
    if (!r) notFound();
    // (the lazy sweep at the start of each op writes the expiry; here only the check, so a rollback loses nothing)
    if (r.status === "expired" || (r.status === "open" && Number(r.expires_at) <= now)) throw new TbError("item_expired", "The item expired before it was answered. The agent must ask again.", 409);
    if (r.status !== "open") throw new TbError("already_decided", `The item was already answered (${String(r.response)}).`, 409);
    if (Number(r.version) !== input.version)
      throw new TbError("stale_version", "The agent added to this item after you opened it. Read the new message, then answer again.", 409, { version: Number(r.version) });
    const allowed = JSON.parse(String(r.responses)) as Response[];
    if (!allowed.includes(input.response))
      throw new TbError("response_not_allowed", `This item allows only ${allowed.join(", ")}.`, 409);
    const message = input.message?.trim() ? input.message.trim() : null;
    if (NEEDS_MESSAGE.has(input.response) && !message) throw new TbError("message_required", `"${input.response}" needs a message for the agent.`, 400);
    const changed = db
      .prepare("UPDATE inbox_items SET status = 'answered', version = version + 1, updated_at = ?, snoozed_until = NULL WHERE id = ? AND status = 'open' AND version = ?")
      .run(now, input.itemId, input.version).changes;
    if (changed !== 1) throw new TbError("already_decided", "The item changed while you answered. Reload it.", 409);
    db.prepare("INSERT INTO inbox_decisions (id, item_id, response, message, decided_by, decided_at, item_version) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      `dcs_${ulid(now)}`,
      input.itemId,
      input.response,
      message,
      decidedBy,
      now,
      input.version,
    );
    if (message)
      db.prepare("INSERT INTO inbox_messages (id, item_id, author, author_id, body, created_at) VALUES (?, ?, 'owner', ?, ?, ?)").run(`msg_${ulid(now)}`, input.itemId, decidedBy, message, now);
    return { itemId: input.itemId, status: "answered" as const, response: input.response, decidedAt: iso(now) };
  });
}

/** Triage changes on OPEN items only (a closed item never re-opens or changes). */
function triage(db: Db, itemId: string, set: string, params: unknown[], now: number): ItemSummary {
  const changed = db.prepare(`UPDATE inbox_items SET ${set}, updated_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?`).run(...params, now, itemId, now).changes;
  if (changed !== 1) {
    const r = row(db, itemId);
    if (!r) notFound();
    throw new TbError("item_closed", `The item is ${r.status === "open" ? "expired" : String(r.status)}.`, 409);
  }
  return toSummary(row(db, itemId) as Row, now);
}

export function ack(db: Db, itemId: string, now: number): ItemSummary {
  return triage(db, itemId, "acked_at = COALESCE(acked_at, ?)", [now], now);
}

export function setPriority(db: Db, itemId: string, priority: Priority, now: number): ItemSummary {
  return triage(db, itemId, "priority = ?", [priority], now);
}

export function snooze(db: Db, itemId: string, until: string | null, now: number): ItemSummary {
  if (until === null) return triage(db, itemId, "snoozed_until = NULL", [], now);
  const t = Date.parse(until);
  if (!Number.isFinite(t) || !/^\d{4}-\d{2}-\d{2}T/.test(until)) throw new TbError("until_invalid", "until must be an ISO 8601 date and time.", 400);
  if (t <= now) throw new TbError("until_invalid", "until must be in the future.", 400);
  if (t - now > MAX_SNOOZE_MS) throw new TbError("until_invalid", "Snooze for at most 30 days.", 400);
  return triage(db, itemId, "snoozed_until = ?", [t], now);
}

// ── settings ──

export function readSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.prepare("SELECT value FROM inbox_settings WHERE key = ?").get(key);
  return r ? (JSON.parse(String(r.value)) as T) : fallback;
}

export function writeSetting(db: Db, key: string, value: unknown): void {
  db.prepare("INSERT INTO inbox_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

/** Items that wait for the owner now (open, not expired, not snoozed): Inbox's share of the TBD badge (C86). */
export function waitingCount(db: Db, now: number): number {
  return Number(
    db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE status = 'open' AND expires_at > ? AND (snoozed_until IS NULL OR snoozed_until <= ?)").get(now, now)?.n ?? 0,
  );
}
