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
import { AlertsError, alertNewItem, digestOf, digestTick, readAlerts, retryDue, writeAlerts } from "./alerts.ts";
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

/** Every op starts with the lazy expiry sweep, so no handler ever reads an item past its time as open. */
function begin(ctx: OpContext): number {
  const now = clock.now();
  if (store.expireDue(ctx.db, now) > 0) ctx.statusChanged();
  return now;
}

/** Background tick (C85 app-initiated calls): expiry sweep (badge), due alert sends, the alert digest (C263). */
export const TICK_MS = 60_000;
export async function tick(ctx: Pick<StartContext, "db" | "log" | "callApp" | "statusChanged"> & Partial<Pick<StartContext, "ownerLink">>, now = clock.now()): Promise<void> {
  try {
    if (store.expireDue(ctx.db, now) > 0) ctx.statusChanged();
    try {
      store.pruneActivity(ctx.db, now);
    } catch (e) {
      // a prune problem must never stop the alert retries of this tick
      ctx.log.warn("inbox activity prune failed", { error: e instanceof Error ? e.message : "unknown" });
    }
    await retryDue(ctx.db, ctx.callApp, now);
    await digestTick(ctx.db, ctx.callApp, (p) => ctx.ownerLink?.(p) ?? null, now);
  } catch (e) {
    ctx.log.warn("inbox tick failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

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
    await retryDue(ctx.db, ctx.callApp, now);
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
        await alertNewItem(ctx.db, ctx.callApp, item, now);
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
      const out = store.decide(ctx.db, input, who, begin(ctx));
      ctx.statusChanged();
      return out;
    },
  }),
  [OP.itemSnooze]: op<ItemSnoozeInput, ItemSnoozeOutput>({
    async run(input, ctx) {
      owner(ctx);
      const out = store.snooze(ctx.db, input.itemId, input.until, begin(ctx));
      ctx.statusChanged();
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
    await tick(ctx);
    setInterval(() => void tick(ctx), TICK_MS).unref();
  },
};

export const app = defineApp(definition);
