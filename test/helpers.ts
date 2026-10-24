// Test helpers: a migrated in-memory database shaped like the SDK's Db (transactions roll back on throw, as the
// SDK's do), and a minimal OpContext for calling handlers directly.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isValidLaunchPath } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

/** An in-memory database with every migration applied in order (`upTo`: only the migrations up to that number, for upgrade tests). */
export function memoryDb(upTo = Number.POSITIVE_INFINITY): Db {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) if (Number(f.slice(0, 4)) <= upTo) raw.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  return shaped(raw);
}

/** Applies one migration file by number to an existing database (the upgrade step). */
export function migrate(db: Db, n: number): void {
  const f = readdirSync(MIGRATIONS).find((x) => x.startsWith(String(n).padStart(4, "0")));
  if (!f) throw new Error(`no migration ${n}`);
  db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
}

function shaped(raw: DatabaseSync): Db {
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      const sp = `sp${depth}`;
      raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const out = fn();
        raw.exec(depth === 1 ? "COMMIT" : `RELEASE ${sp}`);
        return out;
      } catch (e) {
        raw.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
  } as unknown as Db;
}

export type CallApp = OpContext["callApp"];
export interface Sent {
  product: string;
  op: string;
  input: Json;
  key: string | undefined;
}

export const AGENT = { type: "agent", id: "agt_01J0000000000000000000000A", name: "Scout", mode: "free" } as const;
export const OTHER = { type: "agent", id: "agt_01J0000000000000000000000B", name: "Other", mode: "free" } as const;
export const OWNER = { type: "person", id: "per_01J00000000000000000000000", name: "Owner", mode: "free" } as const;

export const PORTAL = "https://portal.example.test";
export const WS = "wsp_01J00000000000000000000000";

/** App secrets per database (SDK: one store per deployment), so a mint and a later check see the same key. */
const SECRETS = new WeakMap<Db, Map<string, string>>();
export function secretsFor(db: Db) {
  const store = SECRETS.get(db) ?? new Map<string, string>();
  SECRETS.set(db, store);
  return {
    get: async (name: string) => store.get(name) ?? null,
    put: async (name: string, value: string) => void store.set(name, value),
    delete: async (name: string) => void store.delete(name),
  };
}

export interface CtxExtras {
  targets?: string[];
  portal?: boolean;
  status?: { pushes: number };
}

export function ctxFor(db: Db, caller: { type: string; id: string; name: string; mode: string; product?: string }, callApp?: CallApp, x: CtxExtras = {}): OpContext {
  const noApp: CallApp = async () => {
    throw Object.assign(new Error("no grant"), { code: "no_grant" });
  };
  return {
    db,
    caller,
    callApp: callApp ?? noApp,
    secrets: secretsFor(db),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    receipt: { summary() {}, meta() {} },
    statusChanged() {
      if (x.status) x.status.pushes++;
    },
    // the SDK's rule: <portalUrl>/w/<ws>/open?product=<own>&path=<path>
    ownerLink: (path: string) => (x.portal === false ? null : `${PORTAL}/w/${WS}/open?product=inbox&path=${encodeURIComponent(path)}`),
    // the SDK rule for another app (miniapp-sdk 0.1.20): product id and launch path checked, null until portalUrl
    ownerLinkFor: (product: string, path: string) => {
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(product)) throw Object.assign(new Error("not a product id"), { code: "product_invalid" });
      if (!isValidLaunchPath(path)) throw Object.assign(new Error("bad path"), { code: "path_invalid" });
      return x.portal === false ? null : `${PORTAL}/w/${WS}/open?product=${encodeURIComponent(product)}&path=${encodeURIComponent(path)}`;
    },
    companionTargets: () => x.targets ?? [],
  } as unknown as OpContext;
}
