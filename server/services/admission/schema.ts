import { z } from "zod";
import { ToolProbeResultSchema, ToolRequirementSchema } from "../tools/schema.js";

export const CandidateProfileSchema = z.object({
  workerId: z.string().min(1),
  profileVersion: z.string().min(1),
  capabilities: z.array(z.string()),
  adapters: z.array(z.object({ id: z.string(), version: z.string(), stateSchemaVersion: z.string() })),
  tools: z.array(z.object({
    serverId: z.string(),
    toolName: z.string(),
    schemaVersion: z.string(),
    grantedScopes: z.array(z.string()),
    dataClassifications: z.array(z.string()),
  })),
  dataClassifications: z.array(z.string()),
  licenses: z.array(z.string()),
  price: z.number().nonnegative(),
  availableUntil: z.iso.datetime(),
  evidence: z.array(z.object({ kind: z.string(), reference: z.string(), digest: z.string() })),
  signature: z.string().min(1),
});

export const TaskAdmissionRequirementsSchema = z.object({
  capabilities: z.array(z.string()),
  adapter: z.object({ id: z.string(), version: z.string(), stateSchemaVersion: z.string() }),
  tools: z.array(ToolRequirementSchema),
  dataClassifications: z.array(z.string()),
  requiredLicenses: z.array(z.string()),
  maximumPrice: z.number().nonnegative(),
  deadline: z.iso.datetime(),
});

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;
export type TaskAdmissionRequirements = z.infer<typeof TaskAdmissionRequirementsSchema>;
export type AdmissionToolProbe = z.infer<typeof ToolProbeResultSchema>;

export type AdmissionResult = {
  workerId: string;
  eligible: boolean;
  reasons: string[];
  score: number | null;
};
