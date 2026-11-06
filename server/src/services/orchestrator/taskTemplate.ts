import { createHash } from "node:crypto";
import { keccak256, toHex, type Hex } from "viem";

/**
 * BATON's built-in multi-step job type for the two-worker core: incident-log triage.
 * Each milestone produces files that later milestones must build on, so a successor
 * that ignores the recovered checkpoint fails the deterministic acceptance checks.
 */
export const INCIDENT_TRIAGE_TEMPLATE_ID = "incident-triage.v1";

export type MilestoneSpec = {
  index: number;
  title: string;
  instructions: string;
  requiredFiles: string[];
  rewardTokens: number;
};

export type TaskSpec = {
  templateId: string;
  title: string;
  objective: string;
  constraints: string[];
  input: { name: string; mediaType: string; content: string };
  milestones: MilestoneSpec[];
};

const SERVICES = ["checkout-api", "payments-worker", "auth-gateway", "search-indexer", "notifications"];

/** Deterministic synthetic incident log, seeded so each job gets a distinct but reproducible input. */
export function generateIncidentLog(seed: string, lines = 24): string {
  const templates = [
    (s: string) => `${s} ERROR upstream timeout calling postgres-primary after 5000ms (pool exhausted, active=50/50)`,
    (s: string) => `${s} WARN connection pool saturation 48/50 on postgres-primary`,
    (s: string) => `${s} ERROR TLS handshake failed for api.partner-bank.example: certificate has expired`,
    (s: string) => `${s} ERROR 502 from partner-bank.example during capture; retry scheduled`,
    (s: string) => `${s} CRITICAL OOMKilled container (limit 512Mi) after reindex batch of 200k documents`,
    (s: string) => `${s} WARN heap usage 91% during bulk reindex`,
    (s: string) => `${s} ERROR JWT validation failed: key id kid-2026-10 not found in JWKS cache`,
    (s: string) => `${s} WARN JWKS refresh skipped: rate limited by identity provider (429)`,
    (s: string) => `${s} ERROR SMTP relay rejected message: daily quota exceeded`,
    (s: string) => `${s} INFO retry queue depth 12000 for email channel`,
  ];
  const serviceFor = [0, 0, 1, 1, 3, 3, 2, 2, 4, 4];
  const out: string[] = [];
  let state = createHash("sha256").update(seed).digest();
  const start = Date.UTC(2026, 10, 3, 14, 0, 0);
  for (let i = 0; i < lines; i++) {
    state = createHash("sha256").update(state).digest();
    const kind = state[0]! % templates.length;
    const ts = new Date(start + i * 97_000 + (state[1]! % 60) * 1000).toISOString();
    const id = `INC-${String(i + 1).padStart(3, "0")}`;
    out.push(`${id} ${ts} ${SERVICES[serviceFor[kind]!]} ${templates[kind]!("")}`.replace(/  +/g, " "));
  }
  return out.join("\n") + "\n";
}

export function buildIncidentTriageSpec(seed: string, rewards: [number, number, number] = [3, 3, 4]): TaskSpec {
  const content = generateIncidentLog(seed);
  return {
    templateId: INCIDENT_TRIAGE_TEMPLATE_ID,
    title: "Production incident log triage",
    objective:
      "Triage the attached production incident log into a postmortem: normalize every log line, cluster incidents by root cause, analyse each cluster, and deliver a remediation report.",
    constraints: [
      "Use only the attached log as evidence; do not invent incident ids.",
      "Write outputs as files in the workspace root with the exact names required by each milestone.",
      "Keep cluster ids stable once a milestone is accepted; later milestones must reuse them exactly.",
    ],
    input: { name: "incidents.log", mediaType: "text/plain", content },
    milestones: [
      {
        index: 1,
        title: "Normalize and cluster",
        instructions:
          "Create normalized.json: a JSON array with one object per log line {id, timestamp, service, severity, message}. Create clusters.json: {\"clusters\":[{\"clusterId\":\"C1\",\"title\":\"...\",\"incidentIds\":[\"INC-001\",...]}]} grouping incidents by shared root cause. Every incident id must appear in exactly one cluster; use 3 to 8 clusters with ids C1, C2, ...",
        requiredFiles: ["normalized.json", "clusters.json"],
        rewardTokens: rewards[0],
      },
      {
        index: 2,
        title: "Root-cause analysis",
        instructions:
          "Using the accepted clusters.json unchanged, create analysis.json: {\"analyses\":[{\"clusterId\":\"C1\",\"rootCause\":\"...\",\"impact\":\"...\",\"evidence\":[\"INC-...\"],\"confidence\":0.0-1.0}]} with exactly one entry per accepted cluster. Evidence ids must belong to that cluster.",
        requiredFiles: ["analysis.json"],
        rewardTokens: rewards[1],
      },
      {
        index: 3,
        title: "Postmortem report",
        instructions:
          "Using the accepted clusters.json and analysis.json, create remediation.json: {\"actions\":[{\"priority\":1,\"clusterId\":\"C1\",\"action\":\"...\"}]} with at least one action per cluster, and report.md containing the headings '## Summary', '## Clusters' and '## Remediation' and mentioning every cluster id.",
        requiredFiles: ["remediation.json", "report.md"],
        rewardTokens: rewards[2],
      },
    ],
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function termsHash(spec: TaskSpec): Hex {
  return keccak256(toHex(canonical({ domain: "baton.terms.v1", spec })));
}

export function acceptanceSpecHash(spec: TaskSpec, milestone: MilestoneSpec): Hex {
  return keccak256(toHex(canonical({ domain: "baton.acceptance.v1", templateId: spec.templateId, milestone })));
}

export type AcceptanceResult = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> };

/**
 * Deterministic buyer-side acceptance checks. `files` must contain the complete output
 * set of the candidate checkpoint (carried-forward accepted files plus new ones).
 */
export function checkMilestone(spec: TaskSpec, milestoneIndex: number, files: Record<string, string>): AcceptanceResult {
  const checks: AcceptanceResult["checks"] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const milestone = spec.milestones[milestoneIndex - 1];
  if (!milestone) return { ok: false, checks: [{ name: "milestone exists", ok: false }] };
  const inputIds = spec.input.content.trim().split("\n").map((line) => line.split(" ")[0]!);
  const parse = (name: string): any => {
    try {
      return JSON.parse(files[name] ?? "");
    } catch {
      return undefined;
    }
  };
  for (let m = 1; m <= milestoneIndex; m++) {
    for (const file of spec.milestones[m - 1]!.requiredFiles) check(`file ${file} present`, typeof files[file] === "string" && files[file]!.length > 0);
  }
  const normalized = parse("normalized.json");
  const clusters = parse("clusters.json")?.clusters;
  const normalizedIds = Array.isArray(normalized) ? normalized.map((row: any) => row?.id) : [];
  check("normalized.json covers every incident once", Array.isArray(normalized) && normalizedIds.length === inputIds.length && inputIds.every((id) => normalizedIds.includes(id)));
  const clusterIds: string[] = Array.isArray(clusters) ? clusters.map((c: any) => c?.clusterId) : [];
  const assigned = Array.isArray(clusters) ? clusters.flatMap((c: any) => (Array.isArray(c?.incidentIds) ? c.incidentIds : [])) : [];
  check("clusters.json has 3-8 uniquely named clusters", clusterIds.length >= 3 && clusterIds.length <= 8 && new Set(clusterIds).size === clusterIds.length && clusterIds.every((id) => /^C\d+$/.test(String(id))));
  check("clusters partition every incident exactly once", assigned.length === inputIds.length && new Set(assigned).size === inputIds.length && inputIds.every((id) => assigned.includes(id)));
  if (milestoneIndex >= 2) {
    const analyses = parse("analysis.json")?.analyses;
    const analysed: string[] = Array.isArray(analyses) ? analyses.map((a: any) => a?.clusterId) : [];
    check("analysis.json covers exactly the accepted clusters", analysed.length === clusterIds.length && clusterIds.every((id) => analysed.includes(id)));
    const evidenceOk = Array.isArray(analyses) && analyses.every((a: any) => {
      const cluster = clusters?.find((c: any) => c?.clusterId === a?.clusterId);
      return cluster && Array.isArray(a?.evidence) && a.evidence.length > 0 && a.evidence.every((id: string) => cluster.incidentIds.includes(id))
        && typeof a?.rootCause === "string" && a.rootCause.length >= 20 && typeof a?.confidence === "number" && a.confidence >= 0 && a.confidence <= 1;
    });
    check("analysis evidence belongs to its cluster with substantive root causes", evidenceOk);
  }
  if (milestoneIndex >= 3) {
    const actions = parse("remediation.json")?.actions;
    const covered = new Set(Array.isArray(actions) ? actions.map((a: any) => a?.clusterId) : []);
    check("remediation.json has an action for every cluster", clusterIds.every((id) => covered.has(id)));
    const report = files["report.md"] ?? "";
    check("report.md has required sections", ["## Summary", "## Clusters", "## Remediation"].every((heading) => report.includes(heading)) && report.length >= 400);
    check("report.md mentions every cluster id", clusterIds.every((id) => new RegExp(`\\b${id}\\b`).test(report)));
  }
  return { ok: checks.every((c) => c.ok), checks };
}
