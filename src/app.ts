// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, backups and status from it. This file registers exactly one handler per
// manifest operation id. Op ids and input/output types come from the kit `tb-gen kit` generates (`#kit`).
//
// Agent side: inbox_ask (create an item; idempotency is the SDK's: same key + same input → the first result,
// different input → 409), inbox_status (poll the answer), inbox_reply (add to an open item), inbox_withdraw (the
// raiser closes its own open item; an app is matched on the verified product and instance, never on a name).
// Owner side (person session = the workspace owner only, SDK-API §5): list/get, decide, snooze, priority, ack,
// holds overview and the alert setting.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidLaunchPath } from "@opt2-tealbrick/manifest";
import { type AppDefinition, defineApp, type HandlerSpec, type OpContext, type SdkAppDefinition, type SdkOpContext, type StartContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type AlertsGetInput,
  type AlertsGetOutput,
  type AlertsSetInput,
  type AlertsSetOutput,
  type HoldsOverviewInput,
  type HoldsOverviewOutput,
  type InboxAskInput,
  type InboxAskOutput,
  type InboxReplyInput,
  type InboxReplyOutput,
  type InboxStatusInput,
  type InboxStatusOutput,
  type InboxWithdrawInput,
  type InboxWithdrawOutput,
  type ItemAckInput,
  type ItemAckOutput,
  type ItemDecideDmInput,
  type ItemDecideDmOutput,
  type ItemDecideInput,
  type ItemDecideOutput,
  type ItemGetInput,
  type ItemGetOutput,
  type ItemPriorityInput,
  type ItemPriorityOutput,
  type ItemSnoozeInput,
  type ItemSnoozeOutput,
  type ItemsListInput,
  type ItemsListOutput,
  OP,
  type OpId,
} from "#kit";
import { AlertsError, alertNewItem, buttonRecipient, digestOf, digestTick, pruneDigests, readAlerts, retryDue, writeAlerts } from "./alerts.ts";
import * as dm from "./dm.ts";
import { overview } from "./holds.ts";
import * as store from "./store.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Clock seam for tests. */
export const clock = { now: () => Date.now() };

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

/**
 * C274 S4: the emit of the start context (no call, so no `causedBy`), kept for the expiry sweep. An item expires because its
 * time passed, not because of whoever's op ran the sweep: with the op's own `ctx.emit` an agent that happened to call would be
 * the event's cause, and the bridge never wakes the cause, so the asker could miss its own expiry. Same outbox, same connection.
 * Keyed by the app's Db handle (the SDK hands the SAME handle to op and start contexts), so several apps in one test process
 * never share one.
 */
const sweepEmits = new WeakMap<object, store.Emit>();

/** Every op starts with the lazy expiry and snooze sweeps, so no handler ever reads an item past its time as open. */
function begin(ctx: OpContext): number {
  const now = clock.now();
  if (store.expireDue(ctx.db, now, sweepEmits.get(ctx.db) ?? ctx.emit) + store.wakeDue(ctx.db, now) > 0) ctx.statusChanged();
  return now;
}

/** Background tick (C85 app-initiated calls): expiry and snooze sweeps (badge), due alert sends, the alert digest (C263). */
export const TICK_MS = 60_000;
type TickCtx = Pick<StartContext, "db" | "log" | "callApp" | "statusChanged"> & Partial<Pick<StartContext, "ownerLink" | "emit">> & { secrets?: dm.Secrets };
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * C331(11): a snooze that ends between two ticks pushes the status at its end, not at the next tick or periodic report.
 * One timer at most, for the next snooze end inside the tick window.
 */
function armWake(ctx: TickCtx, now: number): void {
  clearTimeout(wakeTimer);
  wakeTimer = undefined;
  const next = store.nextWake(ctx.db, now);
  if (next === null || next - now >= TICK_MS) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = undefined;
    try {
      const t = clock.now();
      if (store.wakeDue(ctx.db, t) > 0) ctx.statusChanged();
      armWake(ctx, t);
    } catch (e) {
      ctx.log.warn("inbox snooze wake failed", { error: e instanceof Error ? e.message : "unknown" });
    }
  }, next - now + 1);
  wakeTimer.unref?.();
}
export async function tick(ctx: TickCtx, now = clock.now()): Promise<void> {
  try {
    if (store.expireDue(ctx.db, now, ctx.emit) + store.wakeDue(ctx.db, now) > 0) ctx.statusChanged();
    armWake(ctx, now);
    try {
      store.pruneActivity(ctx.db, now);
      pruneDigests(ctx.db, now);
    } catch (e) {
      // a prune problem must never stop the alert retries of this tick
      ctx.log.warn("inbox activity prune failed", { error: e instanceof Error ? e.message : "unknown" });
    }
    await retryDue(ctx.db, ctx.callApp, now, 3, ctx.secrets);
    await digestTick(ctx.db, ctx.callApp, (p) => ctx.ownerLink?.(p) ?? null, now);
  } catch (e) {
    ctx.log.warn("inbox tick failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

/** The one app that may relay a chat button (manifest companions of Connect, IN-2). */
const CONNECT_PRODUCT = "connect";

/** Owner ops: only a person session reaches them (SDK); this guards the handler too (C84: approver = owner only). */
function owner(ctx: OpContext): string {
  if (ctx.caller.type !== "person") throw new TbError("owner_only", "Only the workspace owner can do this.", 403);
  return ctx.caller.id;
}

/**
 * The verified caller of an agent op. An app's product comes from `ctx.caller.product` (the SDK takes it from the verified
 * grant, miniapp-sdk 0.1.28); it is never read from the name or from the input. Absent or empty → null.
 */
function actorOf(ctx: OpContext): store.Actor {
  const c = ctx.caller;
  const product = c.type === "app" && typeof c.product === "string" && c.product !== "" ? c.product : null;
  return { type: c.type, id: c.id, name: c.name, product };
}

/** Retries due alert sends; an alert problem never fails the op that triggered the retry. */
async function retryAlerts(ctx: OpContext, now: number): Promise<void> {
  try {
    await retryDue(ctx.db, ctx.callApp, now, 3, ctx.secrets);
  } catch (e) {
    ctx.log.warn("alert retry failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const handlers = {
  [OP.inboxAsk]: op<InboxAskInput, InboxAskOutput>({
    redact: (input) => clip(`${input.kind}: ${input.title}`, 280),
    async run(input, ctx) {
      const now = begin(ctx);
      const actor = actorOf(ctx);
      if (input.open !== undefined) {
        // R5, fail closed: the link always opens the VERIFIED product of the caller, so only such a caller may name a page
        if (actor.type !== "app") throw new TbError("open_not_allowed", "Only an app can link an item to one of its pages.", 400);
        if (actor.product === null) throw new TbError("caller_unverified", "The calling app has no verified product, so it cannot link an item to a page.", 403);
        if (!isValidLaunchPath(input.open.path)) throw new TbError("path_invalid", "open.path must be a page of your app such as /review/<id> (no scheme, host, // or ..).", 400);
      }
      const item = store.ask(ctx.db, actor, input, now);
      ctx.statusChanged();
      try {
        await alertNewItem(ctx.db, ctx.callApp, item, now, ctx.secrets);
      } catch (e) {
        ctx.log.warn("alert failed", { item: item.id, error: e instanceof Error ? e.message : "unknown" });
      }
      return { itemId: item.id, status: item.status, expiresAt: item.expiresAt };
    },
  }),
  [OP.inboxStatus]: op<InboxStatusInput, InboxStatusOutput>({
    async run(input, ctx) {
      const now = begin(ctx);
      await retryAlerts(ctx, now);
      return store.status(ctx.db, actorOf(ctx), input.itemId);
    },
  }),
  [OP.inboxReply]: op<InboxReplyInput, InboxReplyOutput>({
    redact: (input) => clip(`reply to ${input.itemId}`, 280),
    async run(input, ctx) {
      const now = begin(ctx);
      return store.reply(ctx.db, actorOf(ctx), input.itemId, input.message, now);
    },
  }),
  [OP.inboxWithdraw]: op<InboxWithdrawInput, InboxWithdrawOutput>({
    redact: (input) => clip(`withdraw ${input.itemId}`, 280),
    async run(input, ctx) {
      const now = begin(ctx);
      const actor = actorOf(ctx);
      // fail closed: only an agent, or an app whose product the SDK verified, can be the raiser of an item
      if (actor.type === "person") throw new TbError("agent_only", "Only the agent or app that raised an item can withdraw it.", 403);
      if (actor.type === "app" && actor.product === null) {
        store.recordRefusal(ctx.db, actor, input.itemId, "no_product", now);
        throw new TbError("caller_unverified", "The calling app has no verified product, so it cannot withdraw an item.", 403);
      }
      const out = store.withdraw(ctx.db, actor, input.itemId, input.reason, now);
      if (out.result === "withdrawn") ctx.statusChanged();
      ctx.receipt.meta({ result: out.result });
      return out;
    },
  }),
  [OP.itemsList]: op<ItemsListInput, ItemsListOutput>({
    async run(input, ctx) {
      owner(ctx);
      const now = begin(ctx);
      await retryAlerts(ctx, now);
      return store.list(ctx.db, input.view ?? "pending", input.limit ?? 50, Number(input.cursor ?? 0), now);
    },
  }),
  [OP.itemGet]: op<ItemGetInput, ItemGetOutput>({
    async run(input, ctx) {
      owner(ctx);
      const c = ctx as SdkOpContext;
      const now = begin(ctx);
      const item = store.get(ctx.db, input.itemId, now, (product, path) => {
        try {
          return c.ownerLinkFor(product, path);
        } catch (e) {
          // a stored page the shared rule refuses is shown as no link; say why (never the path itself)
          ctx.log.warn("open link refused", { item: input.itemId, code: e instanceof TbError ? e.code : "unknown" });
          return null;
        }
      });
      return { ...item, digest: digestOf(ctx.db, item, now) };
    },
  }),
  [OP.itemDecide]: op<ItemDecideInput, ItemDecideOutput>({
    async run(input, ctx) {
      const who = owner(ctx);
      const out = store.decide(ctx.db, input, who, begin(ctx), ctx.emit);
      ctx.statusChanged();
      return out;
    },
  }),
  [OP.itemDecideDm]: op<ItemDecideDmInput, ItemDecideDmOutput>({
    redact: (input) => clip(`chat button by ${input.clicker.service}:${input.clicker.id}`, 280),
    async run(input, ctx) {
      // IN-2: only Connect relays a chat button, and only Inbox decides (PLAN-DM-DECIDE §3)
      const c = ctx.caller;
      if (c.type !== "app" || c.product !== CONNECT_PRODUCT) throw new TbError("connect_only", "Only Connect can relay a chat button.", 403);
      const now = begin(ctx);
      const click = await dm.check(ctx.db, ctx.secrets, buttonRecipient(readAlerts(ctx.db)), input, now, ctx.log);
      const item = store.familyOf(ctx.db, click.itemId);
      if (item === undefined || item.kind !== "approval" || item.family === null || store.INBOX_ONLY_FAMILIES.has(item.family))
        throw new TbError("decide_in_inbox", "Decide this in Operator Inbox.", 403);
      const out = ctx.db.transaction(() => {
        if (!dm.consume(ctx.db, click.tokenId, click.by, now)) throw new TbError("token_used", "This was already decided from the chat.", 409);
        return store.decide(ctx.db, { itemId: click.itemId, version: click.version, response: click.response }, click.by, now, ctx.emit);
      });
      ctx.statusChanged();
      ctx.receipt.meta({ via: input.clicker.service, response: out.response });
      return { ...out, decidedBy: click.by };
    },
  }),
  [OP.itemSnooze]: op<ItemSnoozeInput, ItemSnoozeOutput>({
    async run(input, ctx) {
      owner(ctx);
      const now = begin(ctx);
      const out = store.snooze(ctx.db, input.itemId, input.until, now);
      ctx.statusChanged();
      armWake(ctx, now);
      return out;
    },
  }),
  [OP.itemPriority]: op<ItemPriorityInput, ItemPriorityOutput>({
    async run(input, ctx) {
      owner(ctx);
      return store.setPriority(ctx.db, input.itemId, input.priority, begin(ctx));
    },
  }),
  [OP.itemAck]: op<ItemAckInput, ItemAckOutput>({
    async run(input, ctx) {
      owner(ctx);
      return store.ack(ctx.db, input.itemId, begin(ctx));
    },
  }),
  [OP.holdsOverview]: op<HoldsOverviewInput, HoldsOverviewOutput>({
    async run(_input, ctx) {
      owner(ctx);
      const now = begin(ctx);
      const c = ctx as SdkOpContext;
      return overview(
        { manifest, companionTargets: () => c.companionTargets(), callApp: (p, o, i) => c.callApp(p, o, i), ownerLink: (p) => c.ownerLink(p), now },
        store.openItems(ctx.db, now, 100),
      );
    },
  }),
  [OP.alertsGet]: op<AlertsGetInput, AlertsGetOutput>({
    async run(_input, ctx) {
      owner(ctx);
      return readAlerts(ctx.db);
    },
  }),
  [OP.alertsSet]: op<AlertsSetInput, AlertsSetOutput>({
    async run(input, ctx) {
      owner(ctx);
      try {
        return writeAlerts(ctx.db, input, clock.now());
      } catch (e) {
        if (e instanceof AlertsError) throw new TbError(e.code, e.message, 400);
        throw e;
      }
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  // C86: open, unsnoozed items count in the TBD badge (held receipts + this)
  pendingCount: async (db) => store.waitingCount(db, clock.now()),
  async onStart(ctx) {
    if (ctx.emit) sweepEmits.set(ctx.db, ctx.emit);
    await tick(ctx);
    setInterval(() => void tick(ctx), TICK_MS).unref();
  },
};

export const app = defineApp(definition);
