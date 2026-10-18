// Optional owner alert (C84): a direct message through Connect when an agent puts a new item in the inbox.
// Off by default. The send is a companion call (manifest `companions[]`, product `connect`); it is outward, so
// Connect may hold it for the owner's approval. A held send is repeated later with the SAME input and idempotency
// key (SDK-API §4.3), which runs it once after approval. A refusal is recorded and never retried.
// An alert never fails or delays the agent's ask beyond SEND_TIMEOUT_MS.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { type ItemSummary, readSetting, writeSetting } from "./store.ts";

export interface Alerts {
  dm: "off" | "buzz" | "channel";
  buzzTo: string | null;
  channelAccount: string | null;
  channelPerson: string | null;
}

export const ALERTS_OFF: Alerts = { dm: "off", buzzTo: null, channelAccount: null, channelPerson: null };
const KEY = "alerts";
export const CONNECT = "connect";
export const SEND_TIMEOUT_MS = 5000;
/** Retry schedule for pending/held sends (a hold lives 15 min by default; give up after about an hour). */
const RETRY_AFTER_MS = 60_000;
export const MAX_ATTEMPTS = 60;

/** Connect's refusal for a send to someone never written to → the op that asks the owner for first contact (C57). */
export const FIRST_CONTACT: Record<string, string> = {
  buzz_first_contact_required: "buzz_dm_first",
  channel_first_contact_required: "channel_dm_first",
};

const NPUB = /^(npub1[02-9ac-hj-np-z]{58}|[0-9a-f]{64})$/;

export function readAlerts(db: Db): Alerts {
  return readSetting(db, KEY, ALERTS_OFF);
}

/** Validates and stores the setting. Fields of the other channel are cleared, so nothing stale lingers. */
export function writeAlerts(db: Db, input: Alerts): Alerts {
  const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  let next: Alerts;
  if (input.dm === "off") next = ALERTS_OFF;
  else if (input.dm === "buzz") {
    const to = blank(input.buzzTo);
    if (!to || !NPUB.test(to)) throw new AlertsError("buzzTo must be your Buzz key (npub1… or 64 hex characters).");
    next = { dm: "buzz", buzzTo: to, channelAccount: null, channelPerson: null };
  } else {
    const account = blank(input.channelAccount);
    const person = blank(input.channelPerson);
    if (!account || !person) throw new AlertsError("A channel DM needs the Connect channel account and your handle in it.");
    next = { dm: "channel", buzzTo: null, channelAccount: account, channelPerson: person };
  }
  writeSetting(db, KEY, next);
  return next;
}

export class AlertsError extends Error {}

/** The text the owner receives. Title only (the agent wrote it for the owner); never the context. */
export function alertText(item: ItemSummary): string {
  const what = item.kind === "approval" ? "asks for your approval" : "has a question";
  const urgent = item.priority === "urgent" || item.priority === "high" ? ` (${item.priority})` : "";
  return `${item.from.name} ${what}${urgent}: ${item.title}\nOpen Operator Inbox to answer.`;
}

function companionInput(a: Alerts, text: string): { channel: "buzz" | "channel"; op: string; input: Json } | null {
  if (a.dm === "buzz" && a.buzzTo) return { channel: "buzz", op: "buzz_dm", input: { to: a.buzzTo, content: text } };
  if (a.dm === "channel" && a.channelAccount && a.channelPerson)
    return { channel: "channel", op: "channel_dm", input: { account: a.channelAccount, person: a.channelPerson, text } };
  return null;
}

type Send = OpContext["callApp"];

/** Records a delivery for a new item (when alerts are on) and makes the first attempt. */
export async function alertNewItem(db: Db, callApp: Send, item: ItemSummary, now: number): Promise<void> {
  const target = companionInput(readAlerts(db), alertText(item));
  if (!target) return;
  const id = `dlv_${ulid(now)}`;
  db.prepare(
    `INSERT INTO inbox_deliveries (id, item_id, channel, op, input, idem_key, status, hold_id, error, attempts, next_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?, ?)`,
  ).run(id, item.id, target.channel, target.op, JSON.stringify(target.input), `inbox-alert-${id}`, now, now, now);
  await attempt(db, callApp, id, now);
}

/** Repeats due pending/held sends (called lazily from ops; at most `max` per call). */
export async function retryDue(db: Db, callApp: Send, now: number, max = 3): Promise<void> {
  // (a withdrawn item's deliveries are stopped by the withdraw; the filter keeps any straggler from starving the others)
  const due = db
    .prepare(
      "SELECT d.id FROM inbox_deliveries d WHERE d.status IN ('pending', 'held') AND d.next_at <= ? AND d.item_id NOT IN (SELECT id FROM inbox_items WHERE withdrawn_at IS NOT NULL) ORDER BY d.next_at ASC LIMIT ?",
    )
    .all(now, max);
  for (const d of due) await attempt(db, callApp, String(d.id), now);
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && code ? code.slice(0, 64) : "send_failed";
}

async function attempt(db: Db, callApp: Send, id: string, now: number): Promise<void> {
  // no send for a withdrawn item (inbox_withdraw closes its deliveries; this is the read-side guard)
  const d = db
    .prepare(
      "SELECT d.op, d.input, d.idem_key, d.attempts, d.hold_id FROM inbox_deliveries d JOIN inbox_items i ON i.id = d.item_id WHERE d.id = ? AND d.status IN ('pending', 'held') AND i.withdrawn_at IS NULL",
    )
    .get(id);
  if (!d) return;
  const attempts = Number(d.attempts) + 1;
  // The send is awaited, so a withdraw can close this delivery meanwhile (status failed, error withdrawn). Every write here
  // is guarded on the delivery still being pending or held: the result of a send never overwrites a closed delivery.
  const set = (status: string, holdId: string | null, error: string | null) =>
    db
      .prepare("UPDATE inbox_deliveries SET status = ?, hold_id = COALESCE(?, hold_id), error = ?, attempts = ?, next_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')")
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
    const r = await Promise.race([callApp(CONNECT, String(d.op), JSON.parse(String(d.input)) as Json, { idempotencyKey: String(d.idem_key) }), timeout]);
    // A timed-out send may still land; the retry with the same key then returns the stored result.
    if (r === "timeout") set("pending", null, "timeout");
    // While the hold waits, the same key answers the same holdId. A NEW holdId means the first hold was decided
    // without running (denied or expired): stop, so a refused alert never turns into a stream of new holds.
    else if (r.status === "held" && d.hold_id && r.holdId !== d.hold_id) set("failed", null, "denied");
    else if (r.status === "held") set("held", r.holdId, null);
    else set("sent", null, null);
  } catch (e) {
    const code = errorCode(e);
    const first = FIRST_CONTACT[code];
    if (first && String(d.op) !== first) {
      // Connect: the owner's address was never written to from the workspace sender. Switch to the first-contact op
      // (Connect holds it for the owner's approval), same input and key, and try it at once.
      db.prepare("UPDATE inbox_deliveries SET op = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')").run(first, now, id);
      clearTimeout(timer);
      return attempt(db, callApp, id, now);
    }
    // denied hold, no grant (Connect not deployed), no sender identity, paused…: final, shown to the owner
    set("failed", null, code);
  } finally {
    clearTimeout(timer);
  }
}
