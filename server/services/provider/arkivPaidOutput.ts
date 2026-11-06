import { createHash } from "node:crypto";
import type { Address } from "viem";
import { ArtifactReferenceSchema, type ArtifactReference } from "../../packages/checkpoint/src/index.js";
import { MAX_RECOVERED_ARTIFACT_BYTES, type ArkivContentStore } from "../../packages/storage/src/arkiv.js";

export type PaidOutputIdentity = { jobId: string; taskId: string; operationId: string };
export type PaidOutputKeyResolver = { resolve(input: PaidOutputIdentity): Promise<string> };
type PaidOutputStoreClient = Pick<ArkivContentStore, "stageArtifact" | "readArtifact" | "getEntityMetadata">;

type StoredPaidOutputPointer = {
  version: 1;
  jobId: string;
  taskId: string;
  operationId: string;
  reference: ArtifactReference;
};

/** Encrypts paid bytes into Arkiv and keeps only an Arkiv pointer plus digest in the ledger. */
export class ArkivPaidOutputStore {
  public constructor(
    private readonly store: PaidOutputStoreClient,
    private readonly keys: PaidOutputKeyResolver,
    private readonly expectedOwner: Address,
  ) {}

  public async put(input: PaidOutputIdentity & { bytes: Uint8Array }): Promise<{ outputDigest: string; outputRef: string }> {
    if (!input.operationId.trim()) throw new Error("PAID_OUTPUT_OPERATION_ID_REQUIRED");
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_RECOVERED_ARTIFACT_BYTES) {
      throw new Error("PAID_OUTPUT_SIZE_LIMIT_EXCEEDED");
    }
    const keyHex = await this.keys.resolve(input);
    const reference = await this.store.stageArtifact({
      jobId: input.jobId,
      taskId: input.taskId,
      artifactId: `paid-output:${input.operationId}`,
      mediaType: "application/octet-stream",
      plaintext: input.bytes,
      keyHex,
    });
    if (reference.contentDigest.toLowerCase() !== sha256(input.bytes).toLowerCase()
      || reference.byteLength !== input.bytes.byteLength) throw new Error("PAID_OUTPUT_REFERENCE_MISMATCH");
    await assertOutputRetention(this.store, reference, this.expectedOwner);
    const readback = await this.store.readArtifact({
      jobId: input.jobId,
      taskId: input.taskId,
      reference,
      keyHex,
    });
    if (sha256(readback).toLowerCase() !== sha256(input.bytes).toLowerCase()) {
      throw new Error("PAID_OUTPUT_READBACK_MISMATCH");
    }
    const pointer: StoredPaidOutputPointer = {
      version: 1,
      jobId: input.jobId,
      taskId: input.taskId,
      operationId: input.operationId,
      reference,
    };
    return {
      outputDigest: sha256(input.bytes),
      outputRef: encodePointer(pointer),
    };
  }

  public async get(input: PaidOutputIdentity & { outputRef: string; expectedDigest: string }): Promise<Uint8Array> {
    const pointer = decodePointer(input.outputRef);
    if (pointer.jobId !== input.jobId || pointer.taskId !== input.taskId || pointer.operationId !== input.operationId) {
      throw new Error("PAID_OUTPUT_REFERENCE_BINDING_MISMATCH");
    }
    if (pointer.reference.contentDigest.toLowerCase() !== input.expectedDigest.toLowerCase()) {
      throw new Error("PAID_OUTPUT_REFERENCE_DIGEST_MISMATCH");
    }
    await assertOutputRetention(this.store, pointer.reference, this.expectedOwner);
    const keyHex = await this.keys.resolve(input);
    const bytes = await this.store.readArtifact({
      jobId: input.jobId,
      taskId: input.taskId,
      reference: pointer.reference,
      keyHex,
    });
    if (sha256(bytes).toLowerCase() !== input.expectedDigest.toLowerCase()) {
      throw new Error("PAID_OUTPUT_DIGEST_MISMATCH");
    }
    return bytes;
  }
}

function encodePointer(pointer: StoredPaidOutputPointer): string {
  return `arkiv://paid-output/${Buffer.from(JSON.stringify(pointer)).toString("base64url")}`;
}

function decodePointer(outputRef: string): StoredPaidOutputPointer {
  const prefix = "arkiv://paid-output/";
  if (!outputRef.startsWith(prefix)) throw new Error("PAID_OUTPUT_REFERENCE_INVALID");
  const encoded = outputRef.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("PAID_OUTPUT_REFERENCE_INVALID");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("PAID_OUTPUT_REFERENCE_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAID_OUTPUT_REFERENCE_INVALID");
  const pointer = value as Partial<StoredPaidOutputPointer>;
  if (pointer.version !== 1 || typeof pointer.jobId !== "string" || typeof pointer.taskId !== "string"
    || typeof pointer.operationId !== "string" || !pointer.jobId || !pointer.taskId || !pointer.operationId) {
    throw new Error("PAID_OUTPUT_REFERENCE_INVALID");
  }
  return { ...pointer, reference: ArtifactReferenceSchema.parse(pointer.reference) } as StoredPaidOutputPointer;
}

function sha256(bytes: Uint8Array): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

async function assertOutputRetention(
  store: Pick<ArkivContentStore, "getEntityMetadata">,
  reference: ArtifactReference,
  expectedOwner: Address,
): Promise<void> {
  for (const chunk of reference.chunks) {
    if (!chunk.owner || !chunk.expiresAt) throw new Error("PAID_OUTPUT_RETENTION_METADATA_MISSING");
    const metadata = await store.getEntityMetadata(chunk.entityKey as `0x${string}`);
    if (metadata.owner.toLowerCase() !== expectedOwner.toLowerCase()
      || metadata.owner.toLowerCase() !== chunk.owner.toLowerCase()
      || metadata.expiresAt < BigInt(chunk.expiresAt)) {
      throw new Error("PAID_OUTPUT_OWNER_OR_EXPIRY_MISMATCH");
    }
  }
}
