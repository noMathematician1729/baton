import {
  CandidateProfileSchema,
  TaskAdmissionRequirementsSchema,
  type AdmissionResult,
  type AdmissionToolProbe,
  type CandidateProfile,
  type TaskAdmissionRequirements,
} from "./schema.js";

export async function rankCandidates(input: {
  requirements: TaskAdmissionRequirements;
  profiles: CandidateProfile[];
  probes: AdmissionToolProbe[];
  verifyProfile: (profile: CandidateProfile) => Promise<boolean>;
  now?: Date;
}): Promise<AdmissionResult[]> {
  const requirements = TaskAdmissionRequirementsSchema.parse(input.requirements);
  const now = input.now ?? new Date();
  const results: AdmissionResult[] = [];

  for (const rawProfile of input.profiles) {
    const profile = CandidateProfileSchema.parse(rawProfile);
    const reasons: string[] = [];
    if (!(await input.verifyProfile(profile))) reasons.push("PROFILE_SIGNATURE_INVALID");
    if (!profile.adapters.some((adapter) =>
      adapter.id === requirements.adapter.id &&
      adapter.version === requirements.adapter.version &&
      adapter.stateSchemaVersion === requirements.adapter.stateSchemaVersion,
    )) reasons.push("ADAPTER_INCOMPATIBLE");
    for (const capability of requirements.capabilities) {
      if (!profile.capabilities.includes(capability)) reasons.push("MISSING_CAPABILITY:" + capability);
    }
    for (const classification of requirements.dataClassifications) {
      if (!profile.dataClassifications.includes(classification)) reasons.push("DATA_RIGHTS_MISSING:" + classification);
    }
    for (const license of requirements.requiredLicenses) {
      if (!profile.licenses.includes(license)) reasons.push("LICENSE_MISSING:" + license);
    }
    if (profile.price > requirements.maximumPrice) reasons.push("PRICE_OVER_BUDGET");
    if (Date.parse(profile.availableUntil) < Date.parse(requirements.deadline)) reasons.push("UNAVAILABLE_BEFORE_DEADLINE");
    if (Date.parse(profile.availableUntil) <= now.getTime()) reasons.push("CANDIDATE_UNAVAILABLE");

    for (const requiredTool of requirements.tools) {
      const offered = profile.tools.find((tool) =>
        tool.serverId === requiredTool.serverId &&
        tool.toolName === requiredTool.toolName &&
        tool.schemaVersion === requiredTool.schemaVersion,
      );
      if (!offered) {
        reasons.push("TOOL_SCHEMA_MISSING:" + requiredTool.serverId + "/" + requiredTool.toolName);
        continue;
      }
      for (const scope of requiredTool.requiredScopes) {
        if (!offered.grantedScopes.includes(scope)) reasons.push("TOOL_SCOPE_MISSING:" + scope);
      }
      const probe = input.probes.find((result) =>
        result.serverId === requiredTool.serverId &&
        result.toolName === requiredTool.toolName &&
        result.schemaVersion === requiredTool.schemaVersion,
      );
      if (!probe?.passed) reasons.push("TOOL_PROBE_FAILED:" + requiredTool.toolName);
    }

    const eligible = reasons.length === 0;
    results.push({
      workerId: profile.workerId,
      eligible,
      reasons,
      score: eligible ? profile.price : null,
    });
  }

  return results.sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    return (left.score ?? Number.POSITIVE_INFINITY) - (right.score ?? Number.POSITIVE_INFINITY);
  });
}

export type { AdmissionResult, CandidateProfile, TaskAdmissionRequirements };
