import { isHex, type Address, type Hex } from "viem";
import {
  CHECKPOINT_SCHEMA_VERSION,
  EncryptedEnvelopeSchema,
  artifactManifestDigest,
  decryptManifest,
  encryptedEnvelopeDigest,
  type CheckpointManifest,
} from "../../checkpoint/src/index.js";
import { MAX_RECOVERED_ARTIFACT_BYTES, type ArkivContentStore } from "./arkiv.js";

export const MAX_RECOVERED_PACKAGE_BYTES = 64 * 1024 * 1024;

export type AcceptedCheckpoint = {
  jobId: string;
  taskId: string;
  /** Producer epoch captured from the accepted offer/event, when available. */
  producerEpoch?: number;
  manifestDigest: Hex;
  manifestRef: Hex;
  sequence: number;
  previousAcceptedHead?: Hex | null;
  artifactManifestDigest?: Hex;
};

export type CheckpointKeyGrantRequest = {
  jobId: string;
  taskId: string;
  manifestDigest: Hex;
  keyId: string;
  worker: Address;
};

export interface CheckpointKeyGrantResolver {
  resolveGrantedKey(input: CheckpointKeyGrantRequest): Promise<string>;
}

export type RecoveryAdapter = {
  id: string;
  version: string;
  stateSchemaVersion: string;
};

export type RecoveredAcceptedPackage = {
  manifest: CheckpointManifest;
  manifestDigest: Hex;
  manifestRef: Hex;
  artifacts: Array<{ artifactId: string; contentDigest: Hex; bytes: Uint8Array }>;
};

type RecoverAcceptedPackageInput = {
  store: Pick<ArkivContentStore, "readEnvelope" | "readArtifact" | "getEntityMetadata">;
  keyGrants: CheckpointKeyGrantResolver;
  accepted: AcceptedCheckpoint;
  worker: Address;
  expectedStorageOwner: Address;
  supportedAdapters: readonly RecoveryAdapter[];
  retentionUntilBlock?: bigint;
  recoverArtifacts?: boolean;
};

/** Fetch, authenticate, decrypt, and validate only the checkpoint committed by confirmed chain state. */
export async function recoverAcceptedPackage(input: RecoverAcceptedPackageInput): Promise<RecoveredAcceptedPackage> {
  const { accepted } = input;
  if (!isBytes32(accepted.manifestDigest) || !isBytes32(accepted.manifestRef)) {
    throw new Error("ACCEPTED_CHECKPOINT_BINDING_INVALID");
  }
  if (!Number.isSafeInteger(accepted.sequence) || accepted.sequence < 1) {
    throw new Error("ACCEPTED_CHECKPOINT_SEQUENCE_INVALID");
  }
  if (accepted.producerEpoch !== undefined && (!Number.isSafeInteger(accepted.producerEpoch) || accepted.producerEpoch < 0)) {
    throw new Error("ACCEPTED_CHECKPOINT_EPOCH_INVALID");
  }

  const envelope = EncryptedEnvelopeSchema.parse(
    await input.store.readEnvelope(accepted.manifestRef, accepted.manifestDigest),
  );
  if (encryptedEnvelopeDigest(envelope).toLowerCase() !== accepted.manifestDigest.toLowerCase()) {
    throw new Error("ACCEPTED_CHECKPOINT_DIGEST_MISMATCH");
  }
  if (envelope.jobId !== accepted.jobId || envelope.taskId !== accepted.taskId
    || envelope.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("ACCEPTED_CHECKPOINT_IDENTITY_MISMATCH");
  }

  await assertEntityRetention(input, accepted.manifestRef);
  const keyHex = await input.keyGrants.resolveGrantedKey({
    jobId: accepted.jobId,
    taskId: accepted.taskId,
    manifestDigest: accepted.manifestDigest,
    keyId: envelope.keyId,
    worker: input.worker,
  });
  const manifest = decryptManifest(envelope, keyHex);
  if (manifest.jobId !== accepted.jobId || manifest.taskId !== accepted.taskId
    || manifest.sequence !== accepted.sequence
    || (accepted.producerEpoch !== undefined && manifest.epoch !== accepted.producerEpoch)) {
    throw new Error("ACCEPTED_CHECKPOINT_MANIFEST_MISMATCH");
  }
  if (accepted.previousAcceptedHead !== undefined
    && normalizeHead(manifest.previousAcceptedHead) !== normalizeHead(accepted.previousAcceptedHead)) {
    throw new Error("ACCEPTED_CHECKPOINT_PARENT_MISMATCH");
  }
  const computedArtifactDigest = artifactManifestDigest(manifest) as Hex;
  if (accepted.artifactManifestDigest
    && computedArtifactDigest.toLowerCase() !== accepted.artifactManifestDigest.toLowerCase()) {
    throw new Error("ACCEPTED_ARTIFACT_MANIFEST_MISMATCH");
  }
  if (!input.supportedAdapters.some((adapter) => adapter.id === manifest.adapter.id
    && adapter.version === manifest.adapter.version
    && adapter.stateSchemaVersion === manifest.adapter.stateSchemaVersion)) {
    throw new Error("CHECKPOINT_ADAPTER_UNSUPPORTED");
  }

  const totalBytes = manifest.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0);
  if (totalBytes > MAX_RECOVERED_PACKAGE_BYTES
    || manifest.artifacts.some((artifact) => artifact.byteLength > MAX_RECOVERED_ARTIFACT_BYTES)) {
    throw new Error("RECOVERY_PACKAGE_SIZE_LIMIT_EXCEEDED");
  }

  const artifacts: RecoveredAcceptedPackage["artifacts"] = [];
  for (const reference of manifest.artifacts) {
    for (const chunk of reference.chunks) {
      if (!chunk.expiresAt || !chunk.owner) throw new Error("ARTIFACT_RETENTION_METADATA_MISSING");
      await assertEntityRetention(input, chunk.entityKey as Hex, chunk.owner, BigInt(chunk.expiresAt));
    }
    if (input.recoverArtifacts !== false) {
      const bytes = await input.store.readArtifact({
        jobId: accepted.jobId,
        taskId: accepted.taskId,
        reference,
        keyHex,
      });
      artifacts.push({ artifactId: reference.artifactId, contentDigest: reference.contentDigest as Hex, bytes });
    }
  }

  return {
    manifest,
    manifestDigest: accepted.manifestDigest,
    manifestRef: accepted.manifestRef,
    artifacts,
  };
}

async function assertEntityRetention(
  recovery: Pick<RecoverAcceptedPackageInput, "store" | "expectedStorageOwner" | "retentionUntilBlock">,
  entityKey: Hex,
  manifestOwner?: string,
  manifestExpiry?: bigint,
): Promise<void> {
  const metadata = await recovery.store.getEntityMetadata(entityKey);
  if (metadata.owner.toLowerCase() !== recovery.expectedStorageOwner.toLowerCase()
    || (manifestOwner !== undefined && metadata.owner.toLowerCase() !== manifestOwner.toLowerCase())
    || (manifestExpiry !== undefined && metadata.expiresAt < manifestExpiry)) {
    throw new Error("ARKIV_ENTITY_OWNERSHIP_OR_EXPIRY_MISMATCH");
  }
  if (recovery.retentionUntilBlock !== undefined && metadata.expiresAt < recovery.retentionUntilBlock) {
    throw new Error("ARKIV_RETENTION_TOO_SHORT");
  }
}

function isBytes32(value: string): value is Hex {
  return isHex(value, { strict: true }) && value.length === 66;
}

function normalizeHead(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}
