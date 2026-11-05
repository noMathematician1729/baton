import assert from "node:assert/strict";
import { test } from "node:test";
import { rankCandidates } from "./index.js";
import type { CandidateProfile, TaskAdmissionRequirements } from "./schema.js";

const requirements: TaskAdmissionRequirements = {
  capabilities: ["batch-processing"],
  adapter: { id: "baton.deterministic-batch", version: "1.0.0", stateSchemaVersion: "1" },
  tools: [{
    serverId: "baton-synthetic-data",
    toolName: "process_batch",
    schemaVersion: "1",
    requiredScopes: ["batch:read"],
    dataClassifications: ["synthetic"],
  }],
  dataClassifications: ["synthetic"],
  requiredLicenses: ["demo-data"],
  maximumPrice: 5,
  deadline: "2026-11-06T00:00:00.000Z",
};

function profile(workerId: string, price: number, scopes = ["batch:read"]): CandidateProfile {
  return {
    workerId,
    profileVersion: "1",
    capabilities: ["batch-processing"],
    adapters: [{ id: "baton.deterministic-batch", version: "1.0.0", stateSchemaVersion: "1" }],
    tools: [{
      serverId: "baton-synthetic-data",
      toolName: "process_batch",
      schemaVersion: "1",
      grantedScopes: scopes,
      dataClassifications: ["synthetic"],
    }],
    dataClassifications: ["synthetic"],
    licenses: ["demo-data"],
    price,
    availableUntil: "2026-11-07T00:00:00.000Z",
    evidence: [],
    signature: "fixture-signature",
  };
}

test("hard eligibility filters run before price ranking", async () => {
  const results = await rankCandidates({
    requirements,
    profiles: [profile("cheap-but-no-scope", 1, []), profile("qualified", 3)],
    probes: [{
      serverId: "baton-synthetic-data",
      toolName: "process_batch",
      schemaVersion: "1",
      passed: true,
      latencyMs: 1,
      inputDigest: "0x" + "1".repeat(64),
      outputDigest: "0x" + "2".repeat(64),
    }],
    verifyProfile: async (candidate) => candidate.workerId === "qualified",
    now: new Date("2026-11-05T23:00:00.000Z"),
  });
  assert.equal(results[0]?.workerId, "qualified");
  assert.equal(results[0]?.eligible, true);
  assert.equal(results[1]?.eligible, false);
  assert.ok(results[1]?.reasons.includes("PROFILE_SIGNATURE_INVALID"));
});
