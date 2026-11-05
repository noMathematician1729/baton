import { bytes, createPublicClient, createWalletClient, defineSchema, ExpirationTime, i32, str } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { hexToBytes, http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import {
  ArtifactReferenceSchema,
  MAX_PLAINTEXT_CHUNK_BYTES,
  canonicalJson,
  decryptChunk,
  decryptManifest,
  encryptChunk,
  encryptManifest,
  type ArtifactReference,
  type CheckpointManifest,
  type EncryptedEnvelope,
} from "../../checkpoint/src/index.js";

export const MAX_ARKIV_ENTITY_BYTES = 128 * 1024;
export const DEFAULT_ARKIV_RETENTION_DAYS = 180;

const ContentEntity = defineSchema("baton.content.v1", {
  jobId: str().indexed(),
  taskId: str().indexed(),
  kind: str().indexed(),
  contentId: str().indexed(),
  chunkIndex: i32().indexed(),
  ciphertextDigest: str(),
  payload: bytes(),
});

export type ContentKind = "manifest" | "artifact";

export type StoredContentReference = {
  entityKey: Hex;
  txHash: Hex;
  ciphertextDigest: string;
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
    const ciphertextDigest = "0x" + createHash("sha256").update(input.payload).digest("hex");
    const result = await this.walletClient.createEntity(
      ContentEntity,
      {
        jobId: input.jobId,
        taskId: input.taskId,
        kind: input.kind,
        contentId: input.contentId,
        chunkIndex: input.chunkIndex,
        ciphertextDigest,
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
      ciphertextDigest,
      ciphertextBytes: input.payload.byteLength,
      expiresAt: result.expiresAt,
    };
  }

  async stageManifest(manifest: CheckpointManifest, keyHex: string, keyId: string) {
    const envelope = encryptManifest(manifest, keyHex, keyId);
    const payload = canonicalJson(envelope);
    const ciphertextDigest = "0x" + createHash("sha256").update(payload).digest("hex");
    const stored = await this.writeEncrypted({
      jobId: manifest.jobId,
      taskId: manifest.taskId,
      kind: "manifest",
      contentId: ciphertextDigest,
      chunkIndex: 0,
      payload,
    });
    return { envelope, stored };
  }

  async readManifest(entityKey: Hex, expectedDigest: string, keyHex: string) {
    const payload = await this.readExact(entityKey, expectedDigest);
    const envelope = JSON.parse(Buffer.from(payload).toString("utf8")) as EncryptedEnvelope;
    return decryptManifest(envelope, keyHex);
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
      let chunkReference: { entityKey: Hex; ciphertextDigest: string; ciphertextBytes: number };

      if (oldChunk && input.previous?.artifactId === input.artifactId && input.previous.byteLength >= offset + part.byteLength) {
        const oldCiphertext = await this.readExact(oldChunk.entityKey as Hex, oldChunk.ciphertextDigest);
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
    const ordered = [...reference.chunks].sort((left, right) => left.index - right.index);
    if (ordered.some((chunk, index) => chunk.index !== index)) throw new Error("Artifact chunk sequence is incomplete");
    const parts = await Promise.all(ordered.map(async (chunk) => {
      const ciphertext = await this.readExact(chunk.entityKey as Hex, chunk.ciphertextDigest);
      return decryptChunk(
        ciphertext,
        chunk.ciphertextDigest,
        input.keyHex,
        this.artifactAad(input.jobId, input.taskId, reference.artifactId, chunk.index),
      );
    }));
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
    const digest = "0x" + createHash("sha256").update(payload).digest("hex");
    if (digest !== expectedDigest || digest !== entity.ciphertextDigest.value) {
      throw new Error("Arkiv content digest mismatch");
    }
    return payload;
  }

  async extend(entityKey: Hex, retentionDays = this.retentionDays): Promise<bigint> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 182) {
      throw new Error("Arkiv retention must be between 1 and 182 days");
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
      ciphertextDigest: stored.ciphertextDigest,
      ciphertextBytes: stored.ciphertextBytes,
    };
  }
}
