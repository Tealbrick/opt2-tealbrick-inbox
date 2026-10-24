// Optional owner alert (C84): a direct message through Connect when an agent puts a new item in the inbox.
// Off by default. The send is a companion call (manifest `companions[]`, product `connect`); it is outward, so
// Connect may hold it for the owner's approval. A held send is repeated later with the SAME input and idempotency
// key (SDK-API §4.3), which runs it once after approval. A refusal is recorded and never retried.
// An alert never fails or delays the agent's ask beyond SEND_TIMEOUT_MS.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { buttonChoices, mint, type Recipient, retire, retireAll, type Secrets, seal, unsigned } from "./dm.ts";
import type { Family, ItemSummary, Kind, Response } from "./store.ts";
import { readSetting, writeSetting } from "./store.ts";

export interface Alerts {
  dm: "off" | "buzz" | "channel";
  buzzTo: string | null;
  channelAccount: string | null;
  channelPerson: string | null;
  /** IN-2: Approve / Deny buttons in the channel DM (off by default; only with dm = channel) */
  buttons: boolean;
}

export const ALERTS_OFF: Alerts = { dm: "off", buzzTo: null, channelAccount: null, channelPerson: null, buttons: false };
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
  // a setting stored before IN-2 has no `buttons`: off
  return { ...ALERTS_OFF, ...readSetting<Partial<Alerts>>(db, KEY, ALERTS_OFF) };
}

/** The recipient chat buttons are bound to now, or null when buttons are off (every outstanding token then stops working). */
export function buttonRecipient(a: Alerts): Recipient | null {
  return a.dm === "channel" && a.buttons && a.channelAccount && a.channelPerson ? { account: a.channelAccount, person: a.channelPerson } : null;
}

/** Validates and stores the setting. Only `dm` is required; the other channel's fields may be left out. They are cleared, so nothing stale lingers. */
export function writeAlerts(db: Db, input: Pick<Alerts, "dm"> & Partial<Alerts>, now = Date.now()): Alerts {
  const before = buttonRecipient(readAlerts(db));
  const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  let next: Alerts;
  if (input.dm === "off") next = ALERTS_OFF;
  else if (input.dm === "buzz") {
    const to = blank(input.buzzTo);
    if (!to || !NPUB.test(to)) throw new AlertsError("buzzTo must be your Buzz key (npub1… or 64 hex characters).");
    next = { dm: "buzz", buzzTo: to, channelAccount: null, channelPerson: null, buttons: false };
  } else {
    const account = blank(input.channelAccount);
    const person = blank(input.channelPerson);
    if (!account || !person) throw new AlertsError("A channel DM needs the Connect channel account and your handle in it.");
    next = { dm: "channel", buzzTo: null, channelAccount: account, channelPerson: person, buttons: input.buttons === true };
  }
  writeSetting(db, KEY, next);
  // QA-INBOX17-1: buttons off, or a new recipient: the buttons already sent never work again (also after buttons go on again)
  const after = buttonRecipient(next);
  if (before && (!after || after.account !== before.account || after.person !== before.person)) retireAll(db, now);
  return next;
}

export class AlertsError extends Error {}

/** The text the owner receives. Title only (the agent wrote it for the owner); never the context. */
export function alertText(item: ItemSummary): string {
  const what = item.kind === "approval" ? "asks for your approval" : "has a question";
  const urgent = item.priority === "urgent" || item.priority === "high" ? ` (${item.priority})` : "";
  return `${item.from.name} ${what}${urgent}: ${item.title}\n${OPEN_LINE}`;
}

const OPEN_LINE = "Open Operator Inbox to answer.";
export const BUTTONS_LINE = "Tap Approve or Deny below, or open Operator Inbox to answer.";
export const INBOX_ONLY_LINE = "Decide this in Operator Inbox (Portal, Tealbrick desktop or mobile).";

/** The alert text with its last line for the DM: buttons, Inbox only (buttons on, but this item gets none), or the plain line. */
function textWith(item: ItemSummary, line: string): string {
  return `${alertText(item).slice(0, -OPEN_LINE.length)}${line}`;
}

function companionInput(a: Alerts, text: string): { channel: "buzz" | "channel"; op: string; input: Json } | null {
  if (a.dm === "buzz" && a.buzzTo) return { channel: "buzz", op: "buzz_dm", input: { to: a.buzzTo, content: text } };
  if (a.dm === "channel" && a.channelAccount && a.channelPerson)
    return { channel: "channel", op: "channel_dm", input: { account: a.channelAccount, person: a.channelPerson, text } };
  return null;
}

type Send = OpContext["callApp"];

const LABEL: Partial<Record<Response, { label: string; style: "primary" | "danger" }>> = {
  approve: { label: "Approve", style: "primary" },
  deny: { label: "Deny", style: "danger" },
};

/**
 * Records a delivery for a new item (when alerts are on) and makes the first attempt. With `secrets` and chat buttons
 * on, an item that may be decided from the chat (dm.ts buttonChoices) gets signed Approve / Deny buttons (IN-2).
 */
export async function alertNewItem(db: Db, callApp: Send, item: ItemSummary, now: number, secrets?: Secrets): Promise<void> {
  const alerts = readAlerts(db);
  const to = buttonRecipient(alerts);
  let text = alertText(item);
  let actions: { tokenId: string; input: Json } | null = null;
  if (to) {
    const r = db.prepare("SELECT family, responses FROM inbox_items WHERE id = ?").get(item.id);
    const family = (r?.family ?? null) as Family | null;
    const choices = buttonChoices(item.kind as Kind, family, r ? (JSON.parse(String(r.responses)) as Response[]) : []);
    if (choices.length > 0 && secrets) {
      const m = await mint(db, secrets, { id: item.id, version: item.version, expiresAt: Date.parse(item.expiresAt) }, to, choices, now);
      text = textWith(item, BUTTONS_LINE);
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
  const target = companionInput(alerts, text);
  if (!target) return;
  const input = actions ? { ...(target.input as Record<string, Json>), ...(actions.input as Record<string, Json>) } : target.input;
  const id = `dlv_${ulid(now)}`;
  db.prepare(
    `INSERT INTO inbox_deliveries (id, item_id, channel, op, input, idem_key, status, hold_id, error, attempts, next_at, created_at, updated_at, token_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?, ?, ?)`,
  ).run(id, item.id, target.channel, target.op, JSON.stringify(input), `inbox-alert-${id}`, now, now, now, actions?.tokenId ?? null);
  await attempt(db, callApp, id, now, secrets);
}

/** Connect before IN-2 refuses the unknown `actions` field: send the same alert as text only (new key; the token is retired). */
function toPlain(db: Db, id: string, input: Record<string, Json>, tokenId: string, now: number): void {
  const { actions: _a, actionsUntil: _u, ...rest } = input;
  const text = String(rest.text ?? "").replace(BUTTONS_LINE, OPEN_LINE);
  db.prepare("UPDATE inbox_deliveries SET input = ?, idem_key = idem_key || '-plain', token_id = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')").run(
    JSON.stringify({ ...rest, text }),
    now,
    id,
  );
  retire(db, tokenId, now);
}

/** Repeats due pending/held sends (called lazily from ops; at most `max` per call). */
export async function retryDue(db: Db, callApp: Send, now: number, max = 3, secrets?: Secrets): Promise<void> {
  // (a withdrawn item's deliveries are stopped by the withdraw; the filter keeps any straggler from starving the others)
  const due = db
    .prepare(
      "SELECT d.id FROM inbox_deliveries d WHERE d.status IN ('pending', 'held') AND d.next_at <= ? AND d.item_id NOT IN (SELECT id FROM inbox_items WHERE withdrawn_at IS NOT NULL) ORDER BY d.next_at ASC LIMIT ?",
    )
    .all(now, max);
  for (const d of due) await attempt(db, callApp, String(d.id), now, secrets);
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && code ? code.slice(0, 64) : "send_failed";
}

async function attempt(db: Db, callApp: Send, id: string, now: number, secrets?: Secrets): Promise<void> {
  // no send for a withdrawn item (inbox_withdraw closes its deliveries; this is the read-side guard)
  const d = db
    .prepare(
      "SELECT d.op, d.input, d.idem_key, d.attempts, d.hold_id, d.token_id FROM inbox_deliveries d JOIN inbox_items i ON i.id = d.item_id WHERE d.id = ? AND d.status IN ('pending', 'held') AND i.withdrawn_at IS NULL",
    )
    .get(id);
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
      return attempt(db, callApp, id, now, secrets);
    }
  }
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
      return attempt(db, callApp, id, now, secrets);
    }
    const first = FIRST_CONTACT[code];
    if (first && String(d.op) !== first) {
      // Connect: the owner's address was never written to from the workspace sender. Switch to the first-contact op
      // (Connect holds it for the owner's approval), same input and key, and try it at once.
      db.prepare("UPDATE inbox_deliveries SET op = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')").run(first, now, id);
      clearTimeout(timer);
      return attempt(db, callApp, id, now, secrets);
    }
    // denied hold, no grant (Connect not deployed), no sender identity, paused…: final, shown to the owner
    set("failed", null, code);
  } finally {
    clearTimeout(timer);
  }
}
