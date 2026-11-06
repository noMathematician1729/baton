import { z } from "zod";
import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_CHUNKS,
  MAX_CHECKPOINT_ARTIFACTS,
  MAX_CIPHERTEXT_CHUNK_BYTES,
  MAX_ENCRYPTED_MANIFEST_CIPHERTEXT_CHARS,
} from "./limits.js";

export const CHECKPOINT_SCHEMA_VERSION = "checkpoint.v1" as const;
export { MAX_CIPHERTEXT_CHUNK_BYTES };

const digest = z.string().regex(/^0x[\da-f]{64}$/i);

export const EvidenceSchema = z.object({
  kind: z.string().min(1),
  reference: z.string().min(1),
  digest,
});

export const ArtifactChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  entityKey: z.string().min(1),
  ciphertextDigest: digest,
  ciphertextBytes: z.number().int().positive().max(MAX_CIPHERTEXT_CHUNK_BYTES),
  /** Arkiv block height at expiry; optional only for legacy checkpoint.v1 references. */
  expiresAt: z.string().regex(/^\d+$/).optional(),
  owner: z.string().min(1).optional(),
});

export const ArtifactReferenceSchema = z.object({
  artifactId: z.string().min(1),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  contentDigest: digest,
  encrypted: z.literal(true),
  chunks: z.array(ArtifactChunkSchema).min(1).max(MAX_ARTIFACT_CHUNKS),
  baseDigest: digest.optional(),
}).superRefine((reference, context) => {
  const expectedChunks = Math.max(1, Math.ceil(reference.byteLength / (MAX_CIPHERTEXT_CHUNK_BYTES - 29)));
  if (reference.chunks.length !== expectedChunks) {
    context.addIssue({ code: "custom", path: ["chunks"], message: "Artifact chunk count does not match its byte length" });
  }
});

export const ToolRequirementSchema = z.object({
  serverId: z.string().min(1),
  schemaVersion: z.string().min(1),
  requiredScopes: z.array(z.string()),
  dataClassifications: z.array(z.string()),
  license: z.string().optional(),
});

export const ExternalOperationReferenceSchema = z.object({
  operationId: z.string().min(1),
  ledgerRevision: z.string().min(1),
  state: z.enum(["INTENT", "RESERVED", "SUBMITTED", "SETTLED", "OUTPUT_AVAILABLE", "FAILED", "UNKNOWN"]),
  receiptDigest: digest.optional(),
  outputDigest: digest.optional(),
});

export const CheckpointManifestSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  previousAcceptedHead: digest.nullable(),
  createdAt: z.iso.datetime(),
  adapter: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    stateSchemaVersion: z.string().min(1),
  }),
  work: z.object({
    objective: z.string(),
    constraints: z.array(z.string()),
    completed: z.array(z.object({ id: z.string().min(1), summary: z.string(), evidence: z.array(EvidenceSchema) })),
    decisions: z.array(z.object({ statement: z.string(), rationale: z.string().optional() })),
    unresolved: z.array(z.string()),
    nextActions: z.array(z.string()),
  }),
  artifacts: z.array(ArtifactReferenceSchema).max(MAX_CHECKPOINT_ARTIFACTS),
  tools: z.array(ToolRequirementSchema).max(128),
  externalOperations: z.array(ExternalOperationReferenceSchema).max(128),
  runtimeState: z.record(z.string(), z.unknown()).optional(),
  quantitativeState: z.record(z.string(), z.unknown()).optional(),
});

export const EncryptedEnvelopeSchema = z.object({
  format: z.literal("baton-encrypted-v1"),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  keyId: z.string().min(1),
  algorithm: z.literal("AES-256-GCM"),
  nonce: z.string().length(16),
  ciphertext: z.string(),
  tag: z.string().length(22),
  ciphertextDigest: digest,
}).extend({
  ciphertext: z.string().max(MAX_ENCRYPTED_MANIFEST_CIPHERTEXT_CHARS),
});

export type CheckpointManifest = z.infer<typeof CheckpointManifestSchema>;
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
export type ArtifactChunkReference = z.infer<typeof ArtifactChunkSchema>;
