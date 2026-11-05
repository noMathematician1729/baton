import { z } from "zod";

const digest = z.string().regex(/^0x[\da-f]{64}$/i);

export const ToolRequirementSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  schemaVersion: z.string().min(1),
  requiredScopes: z.array(z.string()),
  dataClassifications: z.array(z.string()),
});

export const ToolProbeRequestSchema = z.object({
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  workerId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  expectedSchemaVersion: z.string().min(1),
  nonce: z.string().min(16),
  expiresAt: z.iso.datetime(),
});

export const ToolProbeResultSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  schemaVersion: z.string().min(1),
  passed: z.boolean(),
  latencyMs: z.number().nonnegative(),
  inputDigest: digest,
  outputDigest: digest.optional(),
  errorCode: z.enum(["MISSING_SCOPE", "SCHEMA_MISMATCH", "TIMEOUT", "TOOL_ERROR"]).optional(),
});

export type ToolRequirement = z.infer<typeof ToolRequirementSchema>;
export type ToolProbeRequest = z.infer<typeof ToolProbeRequestSchema>;
export type ToolProbeResult = z.infer<typeof ToolProbeResultSchema>;
