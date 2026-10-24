// IN-2 (C322(9), C331(3)): Approve / Deny buttons in the Slack or Telegram DM alert. Inbox mints the button values and
// is the only one that decides; Connect only shows the buttons and relays a click (op item_decide_dm) with the person
// who clicked. A value is signed and single-use, and bound to one item, one item version, one choice, the recipient of
// the alert and an expiry. Every refusal leaves the item and the token unchanged.
//
// Value (≤ 64 bytes: Telegram callback_data): `ib1.<tid>.<c>.<mac>`. tid = 12 random bytes, c = a (approve) | d (deny),
// mac = the first 16 bytes of HMAC-SHA256(key, "ib1|tid|c|item|version|account|person|expiresAt"), all base64url.
// The key is 32 random bytes in the app secrets (never in the database, never logged).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type AppSecrets, type Db, type Logger, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type Family, INBOX_ONLY_FAMILIES, type Kind, type Response } from "./store.ts";

export const KEY_NAME = "dm-token-key";
/** A button works for at most this long (and never past the item's expiry). */
export const TOKEN_TTL_MS = 24 * 3600 * 1000;
/**
 * C334(1): wrong signatures on one token id before the token is locked for good. The row is the real guard (single use,
 * recipient, expiry); the lock stops a guess-the-signature run against a known token id.
 */
export const MAX_BAD_MACS = 5;
const VALUE = /^ib1\.([A-Za-z0-9_-]{16})\.([ad])\.([A-Za-z0-9_-]{22})$/;
const CHOICE: Record<string, Response> = { a: "approve", d: "deny" };
const SERVICES: ReadonlySet<string> = new Set(["slack", "teams", "telegram", "discord"]);
const LETTER: Partial<Record<Response, string>> = { approve: "a", deny: "d" };

export type Secrets = Pick<AppSecrets, "get" | "put">;

/** Who the alert went to, exactly as the alert setting named them at mint time. */
export interface Recipient {
  /** the Connect `account` input of the alert (a service name or a channel connection id) */
  account: string;
  /** the person id in that service (Slack user id, Telegram user id) */
  person: string;
}

/** The answers the DM may offer as buttons; [] = no buttons (DM-3: questions, words, money/delete, undeclared family). */
export function buttonChoices(kind: Kind, family: Family | null, responses: readonly Response[]): Response[] {
  if (kind !== "approval" || family === null || INBOX_ONLY_FAMILIES.has(family)) return [];
  return responses.filter((r) => r === "approve" || r === "deny");
}

async function key(secrets: Secrets): Promise<Buffer> {
  let v = await secrets.get(KEY_NAME);
  if (!v) {
    await secrets.put(KEY_NAME, randomBytes(32).toString("base64url"));
    // read back: two first mints at once keep the one value that was stored last
    v = await secrets.get(KEY_NAME);
    if (!v) throw new TbError("dm_key_unavailable", "Inbox cannot store its button key.", 503);
  }
  return Buffer.from(v, "base64url");
}

function mac(k: Buffer, tid: string, c: string, itemId: string, version: number, r: Recipient, expiresAt: number): string {
  return createHmac("sha256", k).update(`ib1|${tid}|${c}|${itemId}|${version}|${r.account}|${r.person}|${expiresAt}`).digest().subarray(0, 16).toString("base64url");
}

export interface Minted {
  tokenId: string;
  expiresAt: number;
  buttons: { response: Response; value: string }[];
}

/** Records one token row for the alert of `item` and returns one signed value per choice. */
export async function mint(
  db: Db,
  secrets: Secrets,
  item: { id: string; version: number; expiresAt: number },
  to: Recipient,
  choices: readonly Response[],
  now: number,
): Promise<Minted> {
  const k = await key(secrets);
  const tokenId = randomBytes(12).toString("base64url");
  const expiresAt = Math.min(item.expiresAt, now + TOKEN_TTL_MS);
  db.prepare("INSERT INTO inbox_dm_tokens (id, item_id, item_version, account, person, expires_at, used_at, used_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)").run(
    tokenId,
    item.id,
    item.version,
    to.account,
    to.person,
    expiresAt,
    now,
  );
  const buttons = choices.flatMap((response) => {
    const c = LETTER[response];
    return c ? [{ response, value: `ib1.${tokenId}.${c}.${mac(k, tokenId, c, item.id, item.version, to, expiresAt)}` }] : [];
  });
  return { tokenId, expiresAt, buttons };
}

/** Closes a token that never reached the owner (the alert went out without buttons). */
export function retire(db: Db, tokenId: string, now: number): void {
  db.prepare("UPDATE inbox_dm_tokens SET used_at = ?, used_by = 'retired' WHERE id = ? AND used_at IS NULL").run(now, tokenId);
}

export interface Click {
  /** the button value Connect relays */
  token: string;
  /** the person who clicked, as the chat service reports it to Connect */
  clicker: { service: string; id: string };
  /** the `account` input of the send that carried the buttons (Connect's record of that message) */
  account: string;
}

export interface Checked {
  tokenId: string;
  itemId: string;
  version: number;
  response: Response;
  by: string;
}

const invalid = (): never => {
  throw new TbError("token_invalid", "This button does not work. Open Operator Inbox to decide.", 403);
};

/**
 * Checks a click in the plan's order (PLAN-DM-DECIDE §3): shape, row, signature, buttons still on for the same
 * recipient, the person who clicked, single use, expiry. A wrong person never uses the token up. The caller then uses
 * the token and decides in one transaction (`consume`).
 */
export async function check(db: Db, secrets: Secrets, current: Recipient | null, click: Click, now: number, log?: Pick<Logger, "warn">): Promise<Checked> {
  const m = VALUE.exec(click.token);
  if (!m) throw new TbError("token_invalid", "This button does not work. Open Operator Inbox to decide.", 400);
  const [, tid, c] = m as unknown as [string, string, string, string];
  const r = db.prepare("SELECT * FROM inbox_dm_tokens WHERE id = ?").get(tid);
  if (!r) throw new TbError("token_invalid", "This button does not work. Open Operator Inbox to decide.", 404);
  const k = await secrets.get(KEY_NAME);
  if (!k) invalid();
  const minted: Recipient = { account: String(r.account), person: String(r.person) };
  const want = Buffer.from(mac(Buffer.from(String(k), "base64url"), tid, c, String(r.item_id), Number(r.item_version), minted, Number(r.expires_at)));
  const got = Buffer.from(click.token.slice(-22));
  if (r.used_by === "locked") throw new TbError("token_locked", "This button was locked after wrong attempts. Open Operator Inbox to decide.", 429);
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    // counted outside any transaction, so a refusal still records the attempt
    db.prepare("UPDATE inbox_dm_tokens SET bad_macs = bad_macs + 1 WHERE id = ?").run(tid);
    const bad = Number(db.prepare("SELECT bad_macs FROM inbox_dm_tokens WHERE id = ?").get(tid)?.bad_macs ?? 0);
    log?.warn("inbox dm token: wrong signature", { token: tid, item: String(r.item_id), attempts: bad });
    if (bad >= MAX_BAD_MACS) {
      db.prepare("UPDATE inbox_dm_tokens SET used_at = COALESCE(used_at, ?), used_by = 'locked' WHERE id = ?").run(now, tid);
      log?.warn("inbox dm token locked", { token: tid, item: String(r.item_id) });
      throw new TbError("token_locked", "This button was locked after wrong attempts. Open Operator Inbox to decide.", 429);
    }
    invalid();
  }
  if (!current || current.account !== minted.account || current.person !== minted.person)
    throw new TbError("buttons_off", "Chat buttons are off for this alert. Open Operator Inbox to decide.", 409);
  // a service-named recipient (slack, sender:slack) also pins the service; an account id is pinned by Connect's record
  const named = minted.account.replace(/^sender:/, "");
  const service = SERVICES.has(named) ? named : null;
  if (click.account !== minted.account || click.clicker.id !== minted.person || (service !== null && click.clicker.service !== service))
    throw new TbError("wrong_person", "Only the person this alert went to can decide here.", 403);
  if (r.used_at !== null && r.used_at !== undefined) throw new TbError("token_used", "This was already decided from the chat.", 409);
  if (Number(r.expires_at) <= now) throw new TbError("token_expired", "This button expired. Open Operator Inbox to decide.", 409);
  return { tokenId: tid, itemId: String(r.item_id), version: Number(r.item_version), response: CHOICE[c] as Response, by: `${click.clicker.service}:${click.clicker.id}` };
}

/** Uses the token up (inside the decide transaction); false when another click used it first. */
export function consume(db: Db, tokenId: string, by: string, now: number): boolean {
  return db.prepare("UPDATE inbox_dm_tokens SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL").run(now, by, tokenId).changes === 1;
}
