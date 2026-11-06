import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type OwnerStatus = {
  owner: string;
  updatedAt: string;
  elapsedHours: number;
  currentTask: string;
  nextGate: string;
  blockers: string[];
};

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const startMarker = "<!-- BATON-STATUS:START -->";
const endMarker = "<!-- BATON-STATUS:END -->";

async function loadStatus(owner: "d1" | "d2"): Promise<OwnerStatus | undefined> {
  try {
    return JSON.parse(await readFile(resolve(root, "status/" + owner + ".json"), "utf8")) as OwnerStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function renderOwner(status: OwnerStatus | undefined, owner: "D1" | "D2", now: number): string {
  if (!status) return `| ${owner} | NOT REPORTED | — | — | status/${owner.toLowerCase()}.json is missing |`;
  const updatedTime = Date.parse(status.updatedAt);
  const stale = !Number.isFinite(updatedTime) || now - updatedTime > 60 * 60 * 1000;
  const updatedLabel = stale ? `STALE (${status.updatedAt})` : status.updatedAt;
  const blockers = status.blockers.length ? status.blockers.join("; ") : "None reported";
  const elapsedMinutes = Math.floor(status.elapsedHours * 60);
  const elapsedLabel = `H${String(Math.floor(elapsedMinutes / 60)).padStart(2, "0")}:${String(elapsedMinutes % 60).padStart(2, "0")}`;
  return `| ${owner} | ${updatedLabel} | ${elapsedLabel} · ${status.nextGate} | ${status.currentTask} | ${blockers} |`;
}

const [d1, d2] = await Promise.all([loadStatus("d1"), loadStatus("d2")]);
const generatedAt = new Date().toISOString();
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  // Status remains useful in source archives without Git metadata.
}

const block = [
  startMarker,
  "",
  `Generated ${generatedAt} · working tree based on commit \`${commit}\`. Refresh with \`npm run status:refresh\`. Status older than 60 minutes is marked STALE.`,
  "",
  "| Owner | Updated | Next gate | Current work | Blockers |",
  "|---|---|---|---|---|",
  renderOwner(d1, "D1", Date.now()),
  renderOwner(d2, "D2", Date.now()),
  "",
  "Feature code and local checks are not evidence of a live integration. See [gate evidence](docs/gates.md) for tested modes and results. The local payment-crash scenario uses a fixture provider; no live Arkiv write/read or x402 payment is claimed. Sepolia lifecycle: LIVE_PASS; full integration: pending.",
  endMarker,
].join("\n");

const readmePath = resolve(root, "README.md");
const readme = await readFile(readmePath, "utf8");
const start = readme.indexOf(startMarker);
const end = readme.indexOf(endMarker);
if (start === -1 || end === -1 || end < start) {
  throw new Error("README status markers are missing or out of order");
}
await writeFile(readmePath, readme.slice(0, start) + block + readme.slice(end + endMarker.length));
console.log("README status refreshed at " + generatedAt);
