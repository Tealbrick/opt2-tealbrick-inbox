// The `eventsProbe` fixture of tealbrick-conformance.json (conformance >= 0.1.28, SDK-API §20, rows A-EV-1..8). The suite
// drives a PERSON op with {case, key?, kind?}; a manifest that declares events without such an op FAILS every A-EV row.
//
// The op exists ONLY under conformance: `probeManifest` adds it to a copy of tealbrick.manifest.json, which
// scripts/conformance-manifest.ts writes to conformance.manifest.json (git-ignored, never in the image) for `pnpm run
// conformance`, and conformance.start.ts serves that manifest with this handler. The shipped manifest and app have no probe op.
//
// "emit" goes through the real Inbox path: an item asked by a probe AGENT, answered with store.decide inside one transaction,
// so A-EV-1/2/4/5 exercise the same emit the owner's answer does (item.answered to the asking agent). Inbox declares no
// scoped event, so the scoped cases (A-EV-6/7) are not_applicable and answer probe_case_unsupported.
import { type AppDefinition, type HandlerSpec, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import * as store from "./src/store.ts";

type Manifest = AppDefinition["manifest"];
type Operation = Manifest["operations"][number];

export const PROBE_OP = "events_probe";
/** A well-formed agent id that is in no slice: the event is accepted by the bridge and delivered to nobody. */
export const PROBE_AGENT = "agt_0000000000000000000000PRBE";

const PROBE_OPERATION = {
  id: PROBE_OP,
  title: "Events probe (conformance only)",
  description: "Conformance harness only: drives ctx.emit for the A-EV rows. Not in the shipped manifest.",
  input: { type: "object" },
  output: { type: "object" },
  crud: ["update"],
  effect: "write",
  idempotency: "supported",
  receipt: false,
  audience: "person",
} as unknown as Operation;

/** tealbrick.manifest.json plus the probe op (a copy; the input is not changed). */
export function probeManifest(m: Manifest): Manifest {
  if (m.operations.some((o) => o.id === PROBE_OP)) throw new Error(`${PROBE_OP} is already declared`);
  return { ...m, operations: [...m.operations, PROBE_OPERATION] };
}

interface ProbeInput {
  case?: string;
  key?: string;
  kind?: string;
}

/** One agent item, answered by the owner: exactly one item.answered (the decide's emit). */
function answerOne(ctx: OpContext, emit: store.Emit, key: string | undefined, now: number): void {
  const item = store.ask(ctx.db, { type: "agent", id: PROBE_AGENT, name: "Conformance probe" }, { kind: "approval", title: "Conformance probe item" }, now);
  store.decide(ctx.db, { itemId: item.id, version: item.version, response: "approve" }, ctx.caller.id, now, emit, key);
}

async function run(input: ProbeInput, ctx: OpContext): Promise<{ code?: string | null }> {
  const emit = ctx.emit;
  if (!emit) throw new TbError("probe_no_emit", "The SDK gave no ctx.emit (miniapp-sdk >= 0.1.38 sets it).", 500);
  const now = Date.now();
  switch (input.case) {
    case undefined:
      return {};
    case "emit":
      ctx.db.transaction(() => answerOne(ctx, emit, input.key, now));
      return {};
    case "rollback":
      try {
        ctx.db.transaction(() => {
          answerOne(ctx, emit, input.key, now);
          throw new Error("rolled back on purpose");
        });
      } catch {
        // A-EV-2: the transaction, its item and its outbox row are gone
      }
      return {};
    case "commit_throw":
      ctx.db.transaction(() => answerOne(ctx, emit, input.key, now));
      throw new TbError("probe_after_commit", "The probe fails after its transaction committed.", 409);
    case "invalid": {
      const subject = { kind: "inbox_item", id: "itm_conformance_probe" };
      try {
        if (input.kind === "payload") emit(store.ANSWERED_EVENT, { itemKind: "approval", status: "not_a_status", response: null }, { subject, to: [PROBE_AGENT] });
        else if (input.kind === "undeclared") emit("item.unknown", {}, { subject, to: [PROBE_AGENT] });
        else emit("tb.hold.decided", {}, { subject });
      } catch (e) {
        return { code: e instanceof TbError ? e.code : null };
      }
      return { code: null };
    }
    default:
      // scoped, purge, grant: Inbox has no scoped event (A-EV-6/7 not_applicable)
      throw new TbError("probe_case_unsupported", `Inbox declares no scoped event: case ${JSON.stringify(input.case)} is not supported.`, 400);
  }
}

export const probeHandler: HandlerSpec = { run: run as unknown as HandlerSpec["run"] };
