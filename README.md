# Operator Inbox (Tealbrick mini app)

Operator Inbox (product id `inbox`): the one queue from agents to the owner. Questions and approval requests, decisions with full history, and the pending holds of all apps in one list. The owner is the only approver. Built on the Miniapp SDK.

**Status:** stable 0.2.9; 0.3.0 (adds `inbox_withdraw`, OD-1) is on dev and soaking on qa1; `main` is heading for 0.3.1 (refused-row caps, caller match on type + product, `inbox_ask open`). Do not roll back across a migration (0.3.0 → 0.2.9, 0.3.1 → 0.3.0): restore the pre-update snapshot instead. Visibility: public, Apache-2.0. Image: `ghcr.io/tealbrick/opt2-tealbrick-inbox` (publicly pullable; as of 2026-10-17 it holds the tag 0.2.9; 0.2.8 and older were published under the former owner's GHCR namespace).

- Repository: `Tealbrick/opt2-tealbrick-inbox` (GitHub organisation `Tealbrick`)
- Licence: Apache-2.0 for the app code (`LICENSE`, `NOTICE`). The built UI vendors React (MIT), the Tealbrick kit and Nunito (SIL OFL 1.1); see `THIRD_PARTY_NOTICES.md`. The Tealbrick brand mark and app stills are Tealbrick artwork and are not covered by the Apache-2.0 licence.

## No secrets policy

This repository is public. It must never contain secrets or personal data, and neither may its issues or pull requests:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every pull request, every push to `main` and every tag runs a secret scan (gitleaks, the `secret-scan` step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so the CI scan is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## App

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by operation id (`src/app.ts`) and plain migrations (`migrations/`). The app has no keys and no app-specific environment variables.

## What it does

- Agents (and companion apps) call `inbox_ask` (question or approval request; idempotency key required), poll `inbox_status`, add facts with `inbox_reply`, and close an item they no longer need with `inbox_withdraw` (see below). `inbox_status` and `inbox_reply` answer only the caller that raised the item: the same caller type and id (agent id or app instance id) and, for an app, the same verified product when the item recorded one; any other caller reads `unknown` (reply: `item_not_found`), the same as for an id that does not exist. App items without a recorded product (raised before migration 0002, or through a bridge that does not sign the product yet) match on type and instance id. An app caller that arrives without a verified product reads `unknown` on an item that recorded one: retry or ask again; `unknown` is not a refusal. Refused `inbox_status` / `inbox_reply` calls leave no history row; refused `inbox_withdraw` calls do.
- Open in the app (`inbox_ask open {path}`): an APP caller with a verified product may name one of its own pages (e.g. `/review/<id>`); the owner sees "Open in <app>" on the item. The link is built with `ctx.ownerLinkFor(<recorded verified product>, path)`, so it always opens the raising app; the label is the app's name from the Portal-signed slice at ask time (Core takes it from the app's signed release; a later rename is not shown; the product id when the slice had no name). An agent (`open_not_allowed`, 400), an app without a verified product (`caller_unverified`, 403) and a path the shared launch-path rule refuses (`path_invalid`, 400) are refused for the whole call. No Portal URL in the slice yet → no link.
- Withdraw (`inbox_withdraw {itemId, reason?}` → `{itemId, result, status}`): only the RAISER can close an open item. An app is matched on the verified product (`ctx.caller.product`, taken by the SDK from the verified grant) AND the instance id recorded when it asked, never on a name or an input field; an agent on its agent id. The item becomes `expired` (the raiser reads `expired`), the reason is kept, and the owner sees "Withdrawn by <app label>" with the reason (escaped) in the Done list and in the item history. `result` is `withdrawn` (also on a repeat: same answer, first reason kept), `not_open` (already answered or expired: not changed, `status` says which) or `unknown` (no such item, or not the caller's: identical for both, no oracle). An app caller without a verified product is refused (`caller_unverified`, 403). Each withdraw and each refused attempt (throttled: 20 per actor per hour, one per actor and item per 10 minutes; the tick keeps refused rows 30 days and at most 2000 rows on ids that do not exist plus 5000 other refused rows, newest first) is a row in the item history with the verified type, instance and product. Items an app raised before migration 0002 have no recorded product and cannot be withdrawn by an app (they stay open until answered or expired); an agent can still withdraw its own old items. A companion app declares `inbox_withdraw` with `crud` including `update`. A reinstalled app has a new instance id and cannot withdraw what it raised before the reinstall. Do not roll back to 0.2.9 after migration 0002 (no down): restore the pre-update snapshot.
- The owner (the only person who can sign in) lists, opens, answers (`approve`, `deny`, `answer`, `clarify`), snoozes, reprioritises and marks items seen.
- Fail closed: a second answer (`already_decided`), an answer on text the owner has not read (`stale_version`), an answer after expiry (`item_expired`), a response the item does not allow (`response_not_allowed`), answer or clarify without words (`message_required`), an answer on a closed item (`item_closed`). A caller with too many open items gets `too_many_open_items` (429).
- Holds overview: Inbox's own open items plus, with the owner's consent at deploy (wildcard companion `product: "*"` for `tb.holds_pending` only), the pending holds of all apps (summaries only, never inputs or views). Each row opens the owning app's decision page through Portal (`/w/<ws>/open`, launch ticket). Deciding stays in the owning app.
- Alerts: open, unsnoozed, unexpired items count in the TBD badge (`pendingCount` + `statusChanged`). Optional owner DM through Connect (Buzz or a channel account), off by default; Connect sends it from the workspace sender identity the owner picks (`no_sender_identity` until set). A held DM is repeated with the same input and key; a denied one stops. The alert carries the title only, never the context.
- Digest and quiet hours (C263): `alerts_set` takes `delivery` (`each`, default: one DM per item; `digest`: one DM per window of 1, 3, 12 or 24 h with the count, up to 10 titles, `+N more` and the Inbox link, never the context), `quietHours {start, end}` (HH:MM, may cross midnight; null = off, the default) and `timeZone` (IANA name; required with quiet hours; the Settings page suggests the browser zone, stored only on Save). Only `dm` is required. In quiet hours no alert DM is sent: a new item's DM waits until the window ends ("waits for your quiet hours to end"), and a digest due then goes out at the end. A digest names the items that are still open, unsnoozed and not withdrawn when it is built; its text is frozen then, so a held send repeats with the same input and key, and a later withdraw does not cancel it. `item_get.digest` says whether the item waits for the next digest or how its digest went.
- Deep links: `/items/<id>` opens one item, `/holds/<id>` one of Inbox's own holds.

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, companions, skills, backups, UI paths |
| `src/app.ts` | `defineApp`: one typed handler per operation (op ids and I/O types from `#kit`) |
| `src/store.ts` | the decision loop: items, messages (the thread), decisions (who and when), snooze, priority, ack; every fail-closed rule |
| `src/alerts.ts` | optional owner alert DM through Connect (companion call; off by default; held sends repeated with the same input and key); digest and quiet hours (C263) |
| `src/quiet.ts` | quiet-hours math in the owner's time zone (Intl; midnight and DST safe) |
| `src/holds.ts` | holds overview: Inbox items + all apps' pending holds (`tb.holds_pending` via `ctx.companionTargets()`, owner consent), Portal links |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | React UI (`<TbProvider>` + `<AppShell>` from `@opt2-tealbrick/ui`; `standard.tsx` + `pages.css` are the template copies, `app.css` is this app's layout), built to `dist/ui` |
| `migrations/` | `0001_init.sql` (baseline) `0002_withdraw.sql` (raising product, withdraw columns, item history) `0003_open_path.sql` (the raising app's page for `inbox_ask open`) and `0004_digests.sql` (the alert digest); forward-only, never edit a released file |
| `skills/use-inbox/SKILL.md` | the agent skill (frontmatter `name`, `description`) |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | the opt2 CI template ci-v9.9, generated from `Tealbrick/opt2-tealbrick-platform`; do not edit |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |
| `conformance.start.ts` | boots the app for `tb-conformance` |
| `test/` | store rules, app and handler checks, UI checks |

## Develop

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts   # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # kit, server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app (not release evidence; QA is)
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls (operations answer 503 no_bridge)
```

## Environment

The SDK reads only `TB_*` variables (SDK API section 13). The Dockerfile defaults `TB_DATA_DIR=/data` (the `data` volume mount) and `TB_BACKUP_DIR=/data/backup` (one volume per service). The deploy recipe sets the rest: `TB_INSTANCE_ID`, `TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`. Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`, `TB_STANDALONE`. The listen port is the manifest `runtime.port`.

Before its first claim the SDK checks that `TB_DATA_DIR` is a mounted volume; on a container's own disk it waits and does not use the enrolment code. Tests and CI that run `startApp` in bridge mode on Linux set `TB_DATA_EPHEMERAL=1` (conformance does, see `conformance.start.ts`; the unit tests run app-alone and need none). Never set it in a deploy recipe.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.2.8`) on a green pipeline and push the tag. Tags are immutable.
3. The release Action (`.github/workflows/opt2-release.yml`) builds and pushes the GHCR image and attaches the kit tarball. The Woodpecker `release-record` step validates and prints the release; it holds no signing key. The platform `registry-sync` pipeline finds the tag, resolves the image digest in GHCR and signs the index entry.
4. Core deploys the newest stable version when the owner installs or updates the app. An update that fails keeps the previous version serving.

Check `publisher` and `source.repo` in the manifest. The repository name must match the image name in `tealbrick-ci.json` (`opt2-tealbrick-inbox`).

## Dependency pins and caching

- `@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves `index.html` as `no-cache` and the hashed directory as immutable, so a deploy is visible at once.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
