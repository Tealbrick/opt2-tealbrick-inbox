// Writes conformance.manifest.json = tealbrick.manifest.json + the conformance-only probe op (conformance.probe.ts), next to
// tealbrick-conformance.json so the suite reads the same fixtures. Run by `pnpm run conformance` before tb-conformance.
// The file is git-ignored and never copied into the image (Dockerfile copies named files only).
import { readFileSync, writeFileSync } from "node:fs";
import { probeManifest } from "../conformance.probe.ts";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tealbrick.manifest.json", root), "utf8"));
writeFileSync(new URL("conformance.manifest.json", root), `${JSON.stringify(probeManifest(manifest), null, 2)}\n`);
