// Optional owner alert (C84): a direct message through Connect when an agent puts a new item in the inbox.
// Off by default. The send is a companion call (manifest `companions[]`, product `connect`); it is outward, so
// Connect may hold it for the owner's approval. A held send is repeated later with the SAME input and idempotency
// key (SDK-API §4.3), which runs it once after approval. A refusal is recorded and never retried.
// An alert never fails or delays the agent's ask beyond SEND_TIMEOUT_MS.
// G6 I2 (C263): `delivery: digest` sends one DM per window (count + titles + Inbox link, never the context) instead of
// one per item, and quiet hours in the owner's time zone hold every alert until the window ends.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { buttonChoices, mint, type Recipient, retire, retireAll, type Secrets, seal, unsigned } from "./dm.ts";
import { inQuiet, type QuietHours, quietEnd, validHhmm, validTimeZone } from "./quiet.ts";
import type { Family, ItemSummary, Kind, Response } from "./store.ts";
import { readSetting, writeSetting } from "./store.ts";

export const DIGEST_EVERY_MIN = [60, 180, 720, 1440] as const;
export type DigestEveryMin = (typeof DIGEST_EVERY_MIN)[number];

export interface Alerts {
  dm: "off" | "buzz" | "channel";
  buzzTo: string | null;
  channelAccount: string | null;
  channelPerson: string | null;
  delivery: "each" | "digest";
  digestEveryMin: DigestEveryMin;
  quietHours: QuietHours | null;
  timeZone: string | null;
  /** IN-2: Approve / Deny buttons in the channel DM (off by default; only with dm = channel and one DM per item) */
  buttons: boolean;
}
/** What alerts_set takes: only `dm` is required (QA LOW on 0.3.0); left-out fields take their defaults. */
export type AlertsInput = Pick<Alerts, "dm"> & Partial<Omit<Alerts, "dm">>;

export const ALERTS_OFF: Alerts = { dm: "off", buzzTo: null, channelAccount: null, channelPerson: null, delivery: "each", digestEveryMin: 60, quietHours: null, timeZone: null, buttons: false };
const KEY = "alerts";
/** The end of the last digest window (ms); set when digest delivery is turned on, moved by every digest build. */
const DIGEST_CURSOR = "alerts_digest_cursor";
/** A window left open when the owner switched from the digest to one DM per item: the next tick still sends it, once. */
const DIGEST_FLUSH = "alerts_digest_flush";
/** One sender at a time per row (the tick, an op's retry, a new ask): a send takes this lease first (> SEND_TIMEOUT_MS). */
const LEASE_MS = 30_000;
/** At most this many items are named (and counted) in one digest. */
export const DIGEST_MAX_ITEMS = 1000;
/** Sent or failed digests older than this are removed by the tick. */
export const DIGEST_KEEP_MS = 90 * 24 * 3600 * 1000;
export const CONNECT = "connect";
export const SEND_TIMEOUT_MS = 5000;
/** Retry schedule for pending/held sends (a hold lives 15 min by default; give up after about an hour). */
const RETRY_AFTER_MS = 60_000;
export const MAX_ATTEMPTS = 60;
/** A digest names at most this many titles; the rest is "+N more". */
export const DIGEST_TITLES = 10;
/** Connect's refusal for a send to someone never written to → the op that asks the owner for first contact (C57). */
export const FIRST_CONTACT: Record<string, string> = {
  buzz_first_contact_required: "buzz_dm_first",
  channel_first_contact_required: "channel_dm_first",
};

const NPUB = /^(npub1[02-9ac-hj-np-z]{58}|[0-9a-f]{64})$/;

/** The stored setting with the I2 defaults filled in; a stored value this build cannot use reads as its default (L24). */
export function readAlerts(db: Db): Alerts {
  const s = readSetting<Partial<Alerts>>(db, KEY, ALERTS_OFF);
  const q = s.quietHours;
  const quietHours = q && validHhmm(q.start) && validHhmm(q.end) && q.start !== q.end ? { start: q.start, end: q.end } : null;
  const timeZone = validTimeZone(s.timeZone) ? s.timeZone : null;
  return {
    dm: s.dm === "buzz" || s.dm === "channel" ? s.dm : "off",
    buzzTo: s.buzzTo ?? null,
    channelAccount: s.channelAccount ?? null,
    channelPerson: s.channelPerson ?? null,
    delivery: s.delivery === "digest" ? "digest" : "each",
    digestEveryMin: DIGEST_EVERY_MIN.includes(s.digestEveryMin as DigestEveryMin) ? (s.digestEveryMin as DigestEveryMin) : 60,
    // quiet hours without a usable zone are no quiet hours (the writer never stores that)
    quietHours: quietHours && timeZone ? quietHours : null,
    timeZone,
    // a setting stored before IN-2 has no `buttons`: off
    buttons: (s.dm === "channel" || s.dm === "buzz") && s.buttons === true,
  };
}

/** The recipient chat buttons are bound to now, or null when buttons are off (every outstanding token then stops working). */
export function buttonRecipient(a: Alerts): Recipient | null {
  if (!a.buttons) return null;
  if (a.dm === "channel" && a.channelAccount && a.channelPerson) return { account: a.channelAccount, person: a.channelPerson };
  // C343a: Buzz has no buttons; Connect reads the owner's signed ✅ / ❌ reaction on the alert instead
  if (a.dm === "buzz" && a.buzzTo) return { account: BUZZ_ACCOUNT, person: a.buzzTo };
  return null;
}

/** The recipient account of a Buzz alert's token (Connect relays a Buzz reaction with this account). */
export const BUZZ_ACCOUNT = "buzz";

/** Validates and stores the setting. Fields of the other channel are cleared, so nothing stale lingers. */
export function writeAlerts(db: Db, input: AlertsInput, now = Date.now()): Alerts {
  const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  let next: Alerts;
  if (input.dm === "off") next = ALERTS_OFF;
  else {
    const delivery = input.delivery ?? "each";
    if (delivery !== "each" && delivery !== "digest") throw new AlertsError("delivery must be each or digest.");
    const digestEveryMin = input.digestEveryMin ?? 60;
    if (!DIGEST_EVERY_MIN.includes(digestEveryMin)) throw new AlertsError(`digestEveryMin must be one of ${DIGEST_EVERY_MIN.join(", ")}.`);
    const q = input.quietHours ?? null;
    if (q && (!validHhmm(q.start) || !validHhmm(q.end))) throw new AlertsError("Quiet hours need a start and an end as HH:MM (24 h).");
    if (q && q.start === q.end) throw new AlertsError("Quiet hours need different start and end times.");
    const tz = blank(input.timeZone);
    if (tz !== null && !validTimeZone(tz)) throw new AlertsError("timeZone must be a time zone name such as Europe/Berlin.", "time_zone_invalid");
    if (q && tz === null) throw new AlertsError("Quiet hours need your time zone.", "time_zone_invalid");
    const common = { delivery, digestEveryMin, quietHours: q ? { start: q.start, end: q.end } : null, timeZone: tz } as const;
    if (input.dm === "buzz") {
      const to = blank(input.buzzTo);
      if (!to || !NPUB.test(to)) throw new AlertsError("buzzTo must be your Buzz key (npub1… or 64 hex characters).");
      next = { dm: "buzz", buzzTo: to, channelAccount: null, channelPerson: null, ...common, buttons: input.buttons === true };
    } else {
      const account = blank(input.channelAccount);
      const person = blank(input.channelPerson);
      if (!account || !person) throw new AlertsError("A channel DM needs the Connect channel account and your handle in it.");
      next = { dm: "channel", buzzTo: null, channelAccount: account, channelPerson: person, ...common, buttons: input.buttons === true };
    }
  }
  db.transaction(() => {
    const before = readAlerts(db);
    writeSetting(db, KEY, next);
    // QA-INBOX17-1: buttons off, or a new recipient: the buttons already sent never work again (also after buttons go on again)
    const was = buttonRecipient(before);
    const now2 = buttonRecipient(next);
    if (was && (!now2 || now2.account !== was.account || now2.person !== was.person)) retireAll(db, now);
    // a send that still waits for the old target, or for alerts that are now off, never goes out
    if (targetOf(before) !== targetOf(next)) closeUnsent(db, next.dm === "off" ? "alerts_off" : "alerts_changed", now);
    const wasDigest = before.dm !== "off" && before.delivery === "digest";
    const isDigest = next.dm !== "off" && next.delivery === "digest";
    // turning the digest on starts its first window now: items alerted one by one before are not repeated
    if (isDigest && !wasDigest) writeSetting(db, DIGEST_CURSOR, now);
    // leaving the digest for one DM per item: the open window is still sent, once, by the next tick
    // (an earlier unsent flush is widened, never replaced: its items are still owed one message)
    if (wasDigest && !isDigest && next.dm !== "off") {
      const owed = readSetting<{ from: number; to: number } | null>(db, DIGEST_FLUSH, null);
      writeSetting(db, DIGEST_FLUSH, { from: owed?.from ?? readSetting<number>(db, DIGEST_CURSOR, now), to: now });
    }
    if (next.dm === "off") writeSetting(db, DIGEST_FLUSH, null);
  });
  return next;
}

const targetOf = (a: Alerts): string => (a.dm === "off" ? "off" : JSON.stringify([a.dm, a.buzzTo, a.channelAccount, a.channelPerson]));

/** Every send that has not gone out yet (pending or held, item DMs and digests) is closed with `error`. */
function closeUnsent(db: Db, error: string, now: number): void {
  for (const t of ["inbox_deliveries", "inbox_digests"] as const)
    db.prepare(`UPDATE ${t} SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('pending', 'held')`).run(error, now);
}

export class AlertsError extends Error {
  readonly code: string;
  constructor(message: string, code = "alerts_invalid") {
    super(message);
    this.code = code;
  }
}

/** The text the owner receives. Title only (the agent wrote it for the owner); never the context. */
export function alertText(item: ItemSummary): string {
  return `${lineOf(item)}\n${OPEN_LINE}`;
}

const OPEN_LINE = "Open Operator Inbox to answer.";
export const BUTTONS_LINE = "Tap Approve or Deny below, or open Operator Inbox to answer.";
/** C343a: the Buzz alert's instruction (reactions instead of buttons; a text reply never decides). */
export const BUZZ_REACT_LINE = "React ✅ to approve or ❌ to deny (once, within 24 hours; the first reaction counts). A text reply does not decide.";
export const INBOX_ONLY_LINE = "Decide this in Operator Inbox (Portal, Tealbrick desktop or mobile).";

/** The alert text with its last line for the DM: buttons, Inbox only (buttons on, but this item gets none), or the plain line. */
function textWith(item: ItemSummary, line: string): string {
  return `${lineOf(item)}\n${line}`;
}

/** One line per item: line breaks in the caller's name or title are collapsed, so they can never forge a line of the DM. */
const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();

function lineOf(item: Pick<ItemSummary, "kind" | "priority" | "title" | "from">): string {
  const what = item.kind === "approval" ? "asks for your approval" : "has a question";
  const urgent = item.priority === "urgent" || item.priority === "high" ? ` (${item.priority})` : "";
  return `${oneLine(item.from.name)} ${what}${urgent}: ${oneLine(item.title)}`;
}

/** The digest text (C263 D2): count, up to DIGEST_TITLES lines, "+N more", the Inbox link when known. Never the context. */
export function digestText(items: readonly Pick<ItemSummary, "kind" | "priority" | "title" | "from">[], link: string | null): string {
  const n = items.length;
  const lines = [`Operator Inbox: ${n} new ${n === 1 ? "item waits" : "items wait"} for you.`, ...items.slice(0, DIGEST_TITLES).map((i) => `- ${lineOf(i)}`)];
  if (n > DIGEST_TITLES) lines.push(`+${n - DIGEST_TITLES} more`);
  lines.push(link ? `Open: ${link}` : "Open Operator Inbox to answer.");
  return lines.join("\n");
}

function companionInput(a: Alerts, text: string): { channel: "buzz" | "channel"; op: string; input: Json } | null {
  if (a.dm === "buzz" && a.buzzTo) return { channel: "buzz", op: "buzz_dm", input: { to: a.buzzTo, content: text } };
  if (a.dm === "channel" && a.channelAccount && a.channelPerson)
    return { channel: "channel", op: "channel_dm", input: { account: a.channelAccount, person: a.channelPerson, text } };
  return null;
}

type Send = OpContext["callApp"];
type Table = "inbox_deliveries" | "inbox_digests";

const LABEL: Partial<Record<Response, { label: string; style: "primary" | "danger" }>> = {
  approve: { label: "Approve", style: "primary" },
  deny: { label: "Deny", style: "danger" },
};

/**
 * Records a delivery for a new item (when alerts are on, one DM per item) and makes the first attempt. In quiet hours
 * the first attempt waits until the window ends (error `quiet_hours` until then). In digest mode no per-item row is made
 * (a digest names many items and never carries buttons). With `secrets` and chat buttons on, an item that may be decided
 * from the chat (dm.ts buttonChoices) gets signed Approve / Deny buttons (IN-2).
 */
export async function alertNewItem(db: Db, callApp: Send, item: ItemSummary, now: number, secrets?: Secrets): Promise<void> {
  const a = readAlerts(db);
  if (a.delivery === "digest") return;
  const to = buttonRecipient(a);
  let text = alertText(item);
  let actions: { tokenId: string; input: Json } | null = null;
  if (to) {
    const r = db.prepare("SELECT family, responses FROM inbox_items WHERE id = ?").get(item.id);
    const family = (r?.family ?? null) as Family | null;
    const choices = buttonChoices(item.kind as Kind, family, r ? (JSON.parse(String(r.responses)) as Response[]) : []);
    if (choices.length > 0 && secrets) {
      const m = await mint(db, secrets, { id: item.id, version: item.version, expiresAt: Date.parse(item.expiresAt) }, to, choices, now);
      text = textWith(item, a.dm === "buzz" ? BUZZ_REACT_LINE : BUTTONS_LINE);
      actions = {
        tokenId: m.tokenId,
        input: {
          // stored without the signature; attempt() signs right before each send (QA-INBOX17-2)
          actions: m.buttons.map((b) => ({ label: LABEL[b.response]?.label ?? b.response, value: unsigned(b.value), style: LABEL[b.response]?.style ?? "primary" })),
          actionsUntil: new Date(m.expiresAt).toISOString(),
        },
      };
    } else if (choices.length === 0) text = textWith(item, INBOX_ONLY_LINE);
  }
  const target = companionInput(a, text);
  if (!target) return;
  const input = actions ? { ...(target.input as Record<string, Json>), ...(actions.input as Record<string, Json>) } : target.input;
  const id = `dlv_${ulid(now)}`;
  const quiet = inQuiet(a.quietHours, a.timeZone, now);
  db.prepare(
    `INSERT INTO inbox_deliveries (id, item_id, channel, op, input, idem_key, status, hold_id, error, attempts, next_at, created_at, updated_at, token_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    item.id,
    target.channel,
    target.op,
    JSON.stringify(input),
    `inbox-alert-${id}`,
    quiet ? "quiet_hours" : null,
    quiet ? quietEnd(a.quietHours, a.timeZone, now) : now,
    now,
    now,
    actions?.tokenId ?? null,
  );
  if (!quiet) await attempt(db, callApp, "inbox_deliveries", id, now, false, secrets);
}

/** Connect before IN-2 refuses the unknown `actions` field: send the same alert as text only (new key; the token is retired). */
function toPlain(db: Db, id: string, input: Record<string, Json>, tokenId: string, now: number): void {
  const { actions: _a, actionsUntil: _u, ...rest } = input;
  // the channel DM's field is `text`, the Buzz DM's `content`
  const field = "content" in rest ? "content" : "text";
  const text = String(rest[field] ?? "")
    .replace(BUTTONS_LINE, OPEN_LINE)
    .replace(BUZZ_REACT_LINE, OPEN_LINE);
  db.prepare("UPDATE inbox_deliveries SET input = ?, idem_key = idem_key || '-plain', token_id = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')").run(
    JSON.stringify({ ...rest, [field]: text }),
    now,
    id,
  );
  retire(db, tokenId, now);
}

/**
 * Repeats due pending/held sends (called lazily from ops and from the tick; at most `max` per call). A PENDING send that
 * falls due in quiet hours is moved to the end of the window instead (a held one is only re-checked: it runs after the
 * owner approved it in Connect, which is the owner's own action).
 */
export async function retryDue(db: Db, callApp: Send, now: number, max = 3, secrets?: Secrets): Promise<void> {
  const a = readAlerts(db);
  const quiet = inQuiet(a.quietHours, a.timeZone, now);
  const defer = (table: Table, id: string) =>
    db.prepare(`UPDATE ${table} SET next_at = ?, error = 'quiet_hours', updated_at = ? WHERE id = ? AND status = 'pending'`).run(quietEnd(a.quietHours, a.timeZone, now), now, id);
  // (a withdrawn item's deliveries are stopped by the withdraw; the filter keeps any straggler from starving the others)
  const due = db
    .prepare(
      "SELECT d.id, d.status FROM inbox_deliveries d WHERE d.status IN ('pending', 'held') AND d.next_at <= ? AND d.item_id NOT IN (SELECT id FROM inbox_items WHERE withdrawn_at IS NOT NULL) ORDER BY d.next_at ASC LIMIT ?",
    )
    .all(now, max);
  for (const d of due) {
    if (quiet && d.status === "pending") defer("inbox_deliveries", String(d.id));
    else await attempt(db, callApp, "inbox_deliveries", String(d.id), now, false, secrets);
  }
  const digests = db.prepare("SELECT id, status FROM inbox_digests WHERE status IN ('pending', 'held') AND next_at <= ? ORDER BY next_at ASC LIMIT ?").all(now, max);
  for (const d of digests) {
    if (quiet && d.status === "pending") defer("inbox_digests", String(d.id));
    else await attempt(db, callApp, "inbox_digests", String(d.id), now);
  }
}

/**
 * The digest state of one item for the owner's view: the newest digest that names it, else "next" (with about when)
 * while the item is open, unsnoozed, asked after the current window started and alerts are in digest mode, else null.
 */
export function digestOf(
  db: Db,
  item: { id: string; status: string; createdAt: string; snoozedUntil: string | null },
  now: number,
): { status: "next" | "pending" | "held" | "sent" | "failed"; at: string; error: string | null } | null {
  const created = Date.parse(item.createdAt);
  const d = db
    .prepare("SELECT d.status, d.error, d.updated_at FROM inbox_digests d, json_each(d.item_ids) j WHERE d.window_to >= ? AND j.value = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 1")
    .get(created, item.id);
  if (d) return { status: d.status as "pending" | "held" | "sent" | "failed", at: new Date(Number(d.updated_at)).toISOString(), error: d.error === null || d.error === undefined ? null : String(d.error) };
  const cursor = readSetting<number | null>(db, DIGEST_CURSOR, null);
  const next = item.status === "open" && item.snoozedUntil === null && cursor !== null && created > cursor ? nextDigestAt(db, now) : null;
  return next === null ? null : { status: "next", at: new Date(next).toISOString(), error: null };
}

/** When the next digest is due (ms), or null when alerts are not in digest mode. */
export function nextDigestAt(db: Db, now: number): number | null {
  const a = readAlerts(db);
  if (a.dm === "off" || a.delivery !== "digest") return null;
  const due = readSetting<number>(db, DIGEST_CURSOR, now) + a.digestEveryMin * 60_000;
  return quietEnd(a.quietHours, a.timeZone, Math.max(due, now));
}

/** Removes sent and failed digests older than DIGEST_KEEP_MS (the item history keeps no reference to them). */
export function pruneDigests(db: Db, now: number): number {
  return Number(db.prepare("DELETE FROM inbox_digests WHERE status IN ('sent', 'failed') AND updated_at < ?").run(now - DIGEST_KEEP_MS).changes);
}

/** Inserts the digest row for the open items asked in (from, to]; null when there is none. Runs inside the caller's transaction. */
function buildDigest(db: Db, a: Alerts, from: number, to: number, now: number, link: string | null): string | null {
  const rows = db
    .prepare(
      `SELECT id, kind, priority, title, from_type, from_id, from_name FROM inbox_items
       WHERE created_at > ? AND created_at <= ? AND status = 'open' AND expires_at > ? AND withdrawn_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(from, to, now, now, DIGEST_MAX_ITEMS);
  if (rows.length === 0) return null;
  const items = rows.map((r) => ({
    kind: r.kind as ItemSummary["kind"],
    priority: r.priority as ItemSummary["priority"],
    title: String(r.title),
    from: { type: r.from_type as ItemSummary["from"]["type"], id: String(r.from_id), name: String(r.from_name) },
  }));
  const target = companionInput(a, digestText(items, link));
  if (!target) return null;
  const id = `dgs_${ulid(now)}`;
  db.prepare(
    `INSERT INTO inbox_digests (id, window_from, window_to, item_ids, channel, op, input, idem_key, status, hold_id, error, attempts, next_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?, ?)`,
  ).run(id, from, to, JSON.stringify(rows.map((r) => String(r.id))), target.channel, target.op, JSON.stringify(target.input), `inbox-digest-${id}`, now, now, now);
  return id;
}

/**
 * Background tick: (1) a window left open by a switch to one DM per item is sent once; (2) in digest mode, when the
 * window is over, it is not quiet and no earlier digest waits for the owner's approval in Connect, the open items asked
 * in the window are frozen into one digest row and sent. An empty window moves the cursor and sends nothing. A held
 * digest keeps the window open (the next digest then covers both windows), so unanswered holds never pile up. The
 * cursor move and the row insert are one transaction: a crash between them can never send a window twice or skip it.
 */
export async function digestTick(db: Db, callApp: Send, ownerLink: (path: string) => string | null, now: number): Promise<void> {
  let a = readAlerts(db);
  if (inQuiet(a.quietHours, a.timeZone, now)) return;
  let link: string | null = null;
  try {
    link = ownerLink("/");
  } catch {
    link = null;
  }
  const flush = readSetting<{ from: number; to: number } | null>(db, DIGEST_FLUSH, null);
  if (flush) {
    const fid = db.transaction(() => {
      writeSetting(db, DIGEST_FLUSH, null);
      return a.dm === "off" ? null : buildDigest(db, a, flush.from, flush.to, now, link);
    });
    if (fid) await attempt(db, callApp, "inbox_digests", fid, now);
    a = readAlerts(db); // the owner may have changed the settings while the flush was sent
  }
  if (a.dm === "off" || a.delivery !== "digest") return;
  const cursor = readSetting<number | null>(db, DIGEST_CURSOR, null);
  if (cursor === null) {
    writeSetting(db, DIGEST_CURSOR, now); // a digest setting without its window (written by hand or an old crash) starts now
    return;
  }
  if (now < cursor + a.digestEveryMin * 60_000) return;
  if (db.prepare("SELECT 1 AS x FROM inbox_digests WHERE status = 'held' LIMIT 1").get()) return;
  const id = db.transaction(() => {
    writeSetting(db, DIGEST_CURSOR, now);
    return buildDigest(db, a, cursor, now, now, link);
  });
  if (id) await attempt(db, callApp, "inbox_digests", id, now);
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && code ? code.slice(0, 64) : "send_failed";
}

async function attempt(db: Db, callApp: Send, table: Table, id: string, now: number, leased = false, secrets?: Secrets): Promise<void> {
  if (!leased) {
    // the lease: of two callers that found the same due row (the tick, an op's retry, a new ask), only one sends it
    const got = db.prepare(`UPDATE ${table} SET next_at = ? WHERE id = ? AND status IN ('pending', 'held') AND next_at <= ?`).run(now + LEASE_MS, id, now).changes;
    if (got !== 1) return;
  }
  const close = (error: string) => db.prepare(`UPDATE ${table} SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')`).run(error, now, id);
  if (table === "inbox_deliveries") {
    // an item DM only for an item that still waits: not withdrawn (inbox_withdraw closes it), not answered, not expired
    const i = db.prepare("SELECT i.status, i.expires_at, i.withdrawn_at FROM inbox_deliveries d JOIN inbox_items i ON i.id = d.item_id WHERE d.id = ?").get(id);
    if (!i || (i.withdrawn_at !== null && i.withdrawn_at !== undefined)) {
      close("withdrawn");
      return;
    }
    if (i.status !== "open" || Number(i.expires_at) <= now) {
      close("closed");
      return;
    }
  } else {
    // a digest's text is frozen at build time; before its FIRST send, drop it when every item it names is closed by now
    const g = db.prepare("SELECT attempts, item_ids FROM inbox_digests WHERE id = ?").get(id);
    const open = g
      ? Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE id IN (SELECT value FROM json_each(?)) AND status = 'open' AND withdrawn_at IS NULL AND expires_at > ?")
            .get(String(g.item_ids), now)?.n ?? 0,
        )
      : 0;
    if (g && Number(g.attempts) === 0 && open === 0) {
      close("closed");
      return;
    }
  }
  const tokenCol = table === "inbox_deliveries" ? ", token_id" : ", NULL AS token_id";
  const d = db.prepare(`SELECT op, input, idem_key, attempts, hold_id${tokenCol} FROM ${table} WHERE id = ? AND status IN ('pending', 'held')`).get(id);
  if (!d) return;
  let input = JSON.parse(String(d.input)) as Record<string, Json>;
  if (d.token_id && Array.isArray(input.actions)) {
    const actions = input.actions as { label: string; value: string; style: string }[];
    try {
      if (!secrets) throw new Error("no secrets");
      const values = await seal(db, secrets, String(d.token_id), actions.map((a) => a.value));
      input = { ...input, actions: actions.map((a, i) => ({ ...a, value: values[i] as string })) };
    } catch {
      // the key or the token is gone, or the buttons were turned off: the same alert as text only
      toPlain(db, id, input, String(d.token_id), now);
      return attempt(db, callApp, table, id, now, true, secrets);
    }
  }
  const attempts = Number(d.attempts) + 1;
  // The send is awaited, so a withdraw can close this delivery meanwhile (status failed, error withdrawn). Every write here
  // is guarded on the row still being pending or held: the result of a send never overwrites a closed row.
  const set = (status: string, holdId: string | null, error: string | null) =>
    db
      .prepare(`UPDATE ${table} SET status = ?, hold_id = COALESCE(?, hold_id), error = ?, attempts = ?, next_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')`)
      .run(status, holdId, error, attempts, now + RETRY_AFTER_MS, now, id);
  if (attempts > MAX_ATTEMPTS) {
    set("failed", null, "gave_up");
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS);
    });
    const r = await Promise.race([callApp(CONNECT, String(d.op), input as Json, { idempotencyKey: String(d.idem_key) }), timeout]);
    // A timed-out send may still land; the retry with the same key then returns the stored result.
    if (r === "timeout") set("pending", null, "timeout");
    // While the hold waits, the same key answers the same holdId. A NEW holdId means the first hold was decided
    // without running (denied or expired): stop, so a refused alert never turns into a stream of new holds.
    else if (r.status === "held" && d.hold_id && r.holdId !== d.hold_id) set("failed", null, "denied");
    else if (r.status === "held") set("held", r.holdId, null);
    else {
      set("sent", null, null);
      // Teams / Discord: Connect sent text only; the buttons never reached the owner
      // Teams / Discord, or buttons that expired while the send waited for approval (QA-CON23-2): no usable buttons
      const shown = (r.output as { actions?: unknown } | null)?.actions;
      if (d.token_id && (shown === "unsupported" || shown === "expired")) retire(db, String(d.token_id), now);
    }
  } catch (e) {
    const code = errorCode(e);
    // an older Connect (unknown field) or buttons Connect refuses (QA-INBOX17-3, e.g. late after a long hold): text only
    if ((code === "input_invalid" || code === "actions_invalid") && d.token_id) {
      clearTimeout(timer);
      toPlain(db, id, JSON.parse(String(d.input)) as Record<string, Json>, String(d.token_id), now);
      return attempt(db, callApp, table, id, now, true, secrets);
    }
    const first = FIRST_CONTACT[code];
    if (first && String(d.op) !== first) {
      // Connect: the owner's address was never written to from the workspace sender. Switch to the first-contact op
      // (Connect holds it for the owner's approval), same input and key, and try it at once.
      db.prepare(`UPDATE ${table} SET op = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')`).run(first, now, id);
      clearTimeout(timer);
      return attempt(db, callApp, table, id, now, true, secrets);
    }
    // denied hold, no grant (Connect not deployed), no sender identity, paused…: final, shown to the owner
    set("failed", null, code);
  } finally {
    clearTimeout(timer);
  }
}
