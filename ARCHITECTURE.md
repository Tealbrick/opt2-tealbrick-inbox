# Operator Inbox (Tealbrick mini app): architecture

State: verified against the repo on 2026-10-17. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see `engineering/ARCHITECTURE.md` and `engineering/SYSTEM-OVERVIEW.md` in the private repo `Tealbrick/opt2-tealbrick-docs`.

## Common app pattern (verified for all seven apps)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler; content-hashed `assets-<hash>/`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Operator Inbox: what it does

Inbox lists holds from every app through the wildcard companion op `tb.holds_pending` (summaries only, never inputs or views; up to 3 pages of 100 per app, 5 s timeout, through `ctx.companionTargets()`). Deciding a hold stays in the owning app: Inbox opens it with a Portal deep link (`/w/<ws>/open?product=&path=`). Inbox contributes a `pendingCount` (open, unsnoozed, unexpired items) to the TBD badge.

## Operations (from `tealbrick.manifest.json`)

13 operations. No destructive ops and no hold families declared.
- Agent: `inbox_ask` and `inbox_reply` (write, idempotency required), `inbox_status` (read), `inbox_withdraw` (write, crud `update`, idempotency supported, receipt: the raiser closes its own open item; `src/store.ts` `withdraw`). Identity is the verified caller only: agent id, or app instance id AND verified product (`ctx.caller.product`); a non-raiser gets `unknown` exactly as for a missing id; an app without a product gets `caller_unverified` (403).
- Person read: `items_list`, `item_get`, `holds_overview`, `alerts_get`. Person write: `item_decide`, `item_snooze`, `item_priority`, `item_ack`, `alerts_set`.
- Fail-closed answers: `already_decided`, `stale_version`, `item_expired`, `response_not_allowed`, `message_required`, `item_closed`, `too_many_open_items` (429).

## Scopes, hooks and companions

- **Scopes:** None. No hooks. No agent directory.
- **Hooks:** None.
- **Companion grants it asks for:** (1) `connect`: `buzz_dm`, `buzz_dm_first`, `channel_dm`, `channel_dm_first` (create) for an optional owner alert DM, off by default; the first message to the owner is held in Connect; a workspace sender identity is needed (`no_sender_identity` until set in Connect, Senders). (2) wildcard `*`: `tb.holds_pending` (read), owner consents at deploy (revocable); Core filters the targets to apps whose release declares it.

## Settings, keys and environment

None. No keys and no environment variables.

## Data

- **Stored:** Migration 0001: `inbox_items` (kind approval or question, title, context, allowed responses, status, priority, version, snooze, expiry), `inbox_messages`, `inbox_decisions`, `inbox_deliveries` (alert DM outbox with idempotency key, attempts), `inbox_settings`. Migration 0002: `inbox_items.from_product` (the verified product of the raising app; NULL for agents and for every row before 0002), `withdrawn_at`, `withdrawn_reason`, and `inbox_activity` (owner-visible item history and the withdraw audit: withdraws and throttled refused attempts, with the verified actor type, instance and product; refused rows are pruned after 90 days by the tick). Defaults: item expiry 7 days, max snooze 30 days, max 100 open items per caller. The alert DM carries the title only, never the context.
- **Never stored:** Other apps' hold details (read live, not persisted), credentials.

## External calls and background work

- **External:** None directly. Everything goes through the Connect companion call.
- **Background:** A 60 s tick: expiry sweep (calls `statusChanged` for the badge) and retry of pending or held alert sends (up to 60 attempts, 1 minute apart). Lazy expiry on every op as well.

## Rollback and reinstall (inbox_withdraw)

- Do not roll back to 0.2.9 once migration 0002 has run: 0002 has no down migration and 0.2.9 does not know its columns and table. Restore the pre-update snapshot (SDK upgrade safety) instead.
- A reinstalled app gets a new instance id. An app that raised items before its reinstall cannot withdraw them afterwards (the raiser match is on the recorded instance id and product); those items stay open until the owner answers them or they expire. Agents are matched on their agent id and keep their rights.
- The item history in `item_get` shows every withdraw row and the refused attempts folded per caller and cause (a count, the newest time), at most 50 lines. A refused attempt on an id that does not exist is counted against a separate hourly cap from attempts on a real item, so junk ids cannot hide a probe.
- A send that is in flight while an item is withdrawn cannot be recalled; its result never overwrites the withdrawn delivery, and no new send is attempted for a withdrawn item.

## Person UI

Inbox (badge), All approvals, Holds, Agents and scopes, Settings (alerts). Deep links `/items/<id>`, `/holds/<id>` (`src/ui/App.tsx`).

## Requirements and runtime hints

Wildcard `tb.holds_pending` consent for the holds list. Connect and a sender identity for DM alerts.

Port 8080. 0.25 cpu, 256 MB. Data 1 GB plus backup 2 GB. Backup cron `30 2 * * *`, retain 7.

## Pinned packages

miniapp-sdk 0.1.28 (spec 0.1.46), manifest 0.1.23, conformance 0.1.21, ui 0.2.4.

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25 and later: pre-update snapshot, migration lock, failed mode) is in this app on `main`. The stable release 0.2.8 pins SDK 0.1.22, so Core can roll back an update of that version only as an image (no data restore) until a stable version with SDK 0.1.25 ships (after the qa1 soak).

## Known gaps

- None found in the README against code.
- Alert delivery in the `held` state waits for the owner's approval of the first contact in Connect.