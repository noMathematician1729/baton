import { bytes, createPublicClient, createWalletClient, defineSchema, ExpirationTime, i32, str } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { hexToBytes, http, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import {
  ArtifactReferenceSchema,
  MAX_PLAINTEXT_CHUNK_BYTES,
  artifactManifestDigest,
  decryptChunk,
  decryptManifest,
  EncryptedEnvelopeSchema,
  encryptedEnvelopeDigest,
  encryptChunk,
  encryptManifest,
  serializeEncryptedEnvelope,
  type ArtifactReference,
  type CheckpointManifest,
  type EncryptedEnvelope,
} from "../../checkpoint/src/index.js";

export const MAX_ARKIV_ENTITY_BYTES = 128 * 1024;
export const MAX_RECOVERED_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_PARALLEL_ARTIFACT_READS = 4;
export const DEFAULT_ARKIV_RETENTION_DAYS = 180;

const ContentEntity = defineSchema("baton.content.v2", {
  jobId: str().indexed(),
  taskId: str().indexed(),
  kind: str().indexed(),
  contentId: str().indexed(),
  chunkIndex: i32().indexed(),
  payloadDigest: str(),
  payload: bytes(),
});

export type ContentKind = "manifest" | "artifact";

export type StoredContentReference = {
  entityKey: Hex;
  txHash: Hex;
  owner: Address;
  payloadDigest: string;
  ciphertextBytes: number;
  expiresAt: bigint;
};

export type ArkivContentStoreConfig = {
  accessKey: string;
  signerPrivateKey: string;
  rpcUrl?: string;
  retentionDays?: number;
  permissionlessExtension: boolean;
};

export class ArkivContentStore {
  private readonly publicClient;
  private readonly walletClient;
  private readonly retentionDays: number;
  private readonly permissionlessExtension: boolean;
  private readonly ownerAddress: Address;

  constructor(config: ArkivContentStoreConfig) {
    if (!isHex(config.signerPrivateKey) || config.signerPrivateKey.length !== 66) {
      throw new Error("Arkiv signer must be a 32-byte hex private key");
    }
    this.retentionDays = config.retentionDays ?? DEFAULT_ARKIV_RETENTION_DAYS;
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1 || this.retentionDays > 182) {
      throw new Error("Arkiv retention must be between 1 and 182 days");
    }
    this.permissionlessExtension = config.permissionlessExtension;
    const chain = rabdi({ accessKey: config.accessKey });
    const transport = http(config.rpcUrl || undefined);
    const account = privateKeyToAccount(config.signerPrivateKey as Hex);
    this.ownerAddress = account.address;
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account, chain, transport });
  }

  async writeEncrypted(input: {
    jobId: string;
    taskId: string;
    kind: ContentKind;
    contentId: string;
    chunkIndex: number;
    payload: Uint8Array;
  }): Promise<StoredContentReference> {
    if (input.payload.byteLength === 0 || input.payload.byteLength > MAX_ARKIV_ENTITY_BYTES) {
      throw new Error("Encrypted Arkiv payload must be 1 to 131072 bytes");
    }
    if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) {
      throw new Error("Chunk index must be a non-negative integer");
    }
    const payloadDigest = "0x" + createHash("sha256").update(input.payload).digest("hex");
    const result = await this.walletClient.createEntity(
      ContentEntity,
      {
        jobId: input.jobId,
        taskId: input.taskId,
        kind: input.kind,
        contentId: input.contentId,
        chunkIndex: input.chunkIndex,
        payloadDigest,
        payload: input.payload,
      },
      {
        expiration: ExpirationTime.fromDays(this.retentionDays),
        flags: { permissionlessExtension: this.permissionlessExtension },
      },
    );
    return {
      entityKey: result.entityKey,
      txHash: result.txHash,
      owner: this.ownerAddress,
      payloadDigest,
      ciphertextBytes: input.payload.byteLength,
      expiresAt: result.expiresAt,
    };
  }

  async stageManifest(manifest: CheckpointManifest, keyHex: string, keyId: string) {
    const envelope = encryptManifest(manifest, keyHex, keyId);
    const payload = serializeEncryptedEnvelope(envelope);
    const manifestDigest = encryptedEnvelopeDigest(envelope);
    const stored = await this.writeEncrypted({
      jobId: manifest.jobId,
      taskId: manifest.taskId,
      kind: "manifest",
      contentId: manifestDigest,
      chunkIndex: 0,
      payload,
    });
    if (stored.payloadDigest !== manifestDigest) throw new Error("Serialized checkpoint envelope digest mismatch");
    return {
      envelope,
      stored,
      manifestDigest,
      manifestRef: stored.entityKey,
      artifactManifestDigest: artifactManifestDigest(manifest),
    };
  }

  async readManifest(entityKey: Hex, expectedDigest: string, keyHex: string) {
    const envelope = await this.readEnvelope(entityKey, expectedDigest);
    return decryptManifest(envelope, keyHex);
  }

  async readEnvelope(entityKey: Hex, expectedDigest: string): Promise<EncryptedEnvelope> {
    const payload = await this.readExact(entityKey, expectedDigest);
    return EncryptedEnvelopeSchema.parse(JSON.parse(Buffer.from(payload).toString("utf8")));
  }

  async stageArtifact(input: {
    jobId: string;
    taskId: string;
    artifactId: string;
    mediaType: string;
    plaintext: Uint8Array;
    keyHex: string;
    previous?: ArtifactReference;
  }): Promise<ArtifactReference> {
    const chunks: ArtifactReference["chunks"] = [];
    const oldChunks = new Map<number, ArtifactReference["chunks"][number]>(
      (input.previous?.chunks ?? []).map((chunk) => [chunk.index, chunk]),
    );
    for (let offset = 0, index = 0; offset < input.plaintext.byteLength || (offset === 0 && input.plaintext.byteLength === 0); index++) {
      const part = input.plaintext.slice(offset, Math.min(offset + MAX_PLAINTEXT_CHUNK_BYTES, input.plaintext.byteLength));
      const associatedData = this.artifactAad(input.jobId, input.taskId, input.artifactId, index);
      const oldChunk = oldChunks.get(index);
      let chunkReference: { entityKey: Hex; ciphertextDigest: string; ciphertextBytes: number; expiresAt: bigint; owner: Address };

      if (oldChunk && input.previous?.artifactId === input.artifactId && input.previous.byteLength >= offset + part.byteLength) {
        const oldCiphertext = await this.readExact(oldChunk.entityKey as Hex, oldChunk.ciphertextDigest);
        const oldMetadata = await this.getEntityMetadata(oldChunk.entityKey as Hex);
        const oldPlaintext = decryptChunk(
          oldCiphertext,
          oldChunk.ciphertextDigest,
          input.keyHex,
          associatedData,
        );
        if (Buffer.from(oldPlaintext).equals(Buffer.from(part))) {
          chunkReference = {
            entityKey: oldChunk.entityKey as Hex,
            ciphertextDigest: oldChunk.ciphertextDigest,
            ciphertextBytes: oldChunk.ciphertextBytes,
            expiresAt: oldMetadata.expiresAt,
            owner: oldMetadata.owner,
          };
        } else {
          const stored = await this.storeArtifactChunk(input, index, part, associatedData);
          chunkReference = stored;
        }
      } else {
        const stored = await this.storeArtifactChunk(input, index, part, associatedData);
        chunkReference = stored;
      }

      chunks.push({
        index,
        entityKey: chunkReference.entityKey,
        ciphertextDigest: chunkReference.ciphertextDigest,
        ciphertextBytes: chunkReference.ciphertextBytes,
        expiresAt: chunkReference.expiresAt.toString(),
        owner: chunkReference.owner,
      });
      offset += part.byteLength;
      if (input.plaintext.byteLength === 0) break;
    }

    const contentDigest = "0x" + createHash("sha256").update(input.plaintext).digest("hex");
    return ArtifactReferenceSchema.parse({
      artifactId: input.artifactId,
      mediaType: input.mediaType,
      byteLength: input.plaintext.byteLength,
      contentDigest,
      encrypted: true,
      chunks,
      baseDigest: input.previous?.contentDigest,
    });
  }

  async readArtifact(input: {
    jobId: string;
    taskId: string;
    reference: ArtifactReference;
    keyHex: string;
  }): Promise<Uint8Array> {
    const reference = ArtifactReferenceSchema.parse(input.reference);
    if (reference.byteLength > MAX_RECOVERED_ARTIFACT_BYTES) {
      throw new Error("Artifact exceeds the configured recovery size limit");
    }
    const ordered = [...reference.chunks].sort((left, right) => left.index - right.index);
    if (ordered.some((chunk, index) => chunk.index !== index)) throw new Error("Artifact chunk sequence is incomplete");
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < ordered.length; offset += MAX_PARALLEL_ARTIFACT_READS) {
      const batch = ordered.slice(offset, offset + MAX_PARALLEL_ARTIFACT_READS);
      const recovered = await Promise.all(batch.map(async (chunk) => {
        const ciphertext = await this.readExact(chunk.entityKey as Hex, chunk.ciphertextDigest);
        return decryptChunk(
          ciphertext,
          chunk.ciphertextDigest,
          input.keyHex,
          this.artifactAad(input.jobId, input.taskId, reference.artifactId, chunk.index),
        );
      }));
      parts.push(...recovered);
    }
    const plaintext = Buffer.concat(parts);
    const digest = "0x" + createHash("sha256").update(plaintext).digest("hex");
    if (plaintext.byteLength !== reference.byteLength || digest !== reference.contentDigest) {
      throw new Error("Artifact content digest or length mismatch");
    }
    return plaintext;
  }

  async readExact(entityKey: Hex, expectedDigest: string): Promise<Uint8Array> {
    const entity = await this.publicClient.getEntity(entityKey, ContentEntity);
    const payload = hexToBytes(entity.payload.value);
    if (payload.byteLength === 0 || payload.byteLength > MAX_ARKIV_ENTITY_BYTES) {
      throw new Error("ARKIV_ENTITY_SIZE_LIMIT_EXCEEDED");
    }
    const digest = "0x" + createHash("sha256").update(payload).digest("hex");
    if (digest !== expectedDigest || digest !== entity.payloadDigest.value) {
      throw new Error("Arkiv content digest mismatch");
    }
    return payload;
  }

  async getEntityMetadata(entityKey: Hex): Promise<{ owner: Address; expiresAt: bigint }> {
    const entity = await this.publicClient.getEntity(entityKey, ContentEntity);
    if (!entity.$owner || entity.$expiresAt === undefined) throw new Error("Arkiv entity owner or expiry metadata is missing");
    return { owner: entity.$owner, expiresAt: entity.$expiresAt };
  }

  async extend(entityKey: Hex, retentionDays = this.retentionDays): Promise<bigint> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 182) {
      throw new Error("Arkiv retention must be between 1 and 182 days");
    }
    const metadata = await this.getEntityMetadata(entityKey);
    if (metadata.owner.toLowerCase() !== this.ownerAddress.toLowerCase()) {
      throw new Error("ARKIV_STORAGE_SIGNER_NOT_ENTITY_OWNER");
    }
    const result = await this.walletClient.extendEntity({
      entityKey,
      expiration: ExpirationTime.fromDays(retentionDays),
    });
    return result.expiresAt;
  }

  private artifactAad(jobId: string, taskId: string, artifactId: string, index: number) {
    return "baton:" + jobId + ":" + taskId + ":artifact:" + artifactId + ":" + index;
  }

  private async storeArtifactChunk(
    input: { jobId: string; taskId: string; artifactId: string; keyHex: string },
    index: number,
    plaintext: Uint8Array,
    associatedData: string,
  ) {
    const encrypted = encryptChunk(plaintext, input.keyHex, associatedData);
    const stored = await this.writeEncrypted({
      jobId: input.jobId,
      taskId: input.taskId,
      kind: "artifact",
      contentId: input.artifactId,
      chunkIndex: index,
      payload: encrypted.bytes,
    });
    return {
      entityKey: stored.entityKey,
      ciphertextDigest: stored.payloadDigest,
      ciphertextBytes: stored.ciphertextBytes,
      expiresAt: stored.expiresAt,
      owner: stored.owner,
    };
  }
}
