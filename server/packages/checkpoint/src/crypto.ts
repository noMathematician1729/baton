import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { CheckpointManifestSchema, EncryptedEnvelopeSchema, type CheckpointManifest, type EncryptedEnvelope } from "./schema.js";
import {
  MAX_CIPHERTEXT_CHUNK_BYTES,
  MAX_ENCRYPTED_MANIFEST_BYTES,
  MAX_MANIFEST_PLAINTEXT_BYTES,
  MAX_PLAINTEXT_CHUNK_BYTES,
} from "./limits.js";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): Buffer {
  const json = JSON.stringify(canonicalValue(value));
  if (json === undefined) throw new TypeError("Value is not JSON serializable");
  return Buffer.from(json, "utf8");
}

/** Exact UTF-8 bytes committed by the on-chain checkpoint head. */
export function serializeEncryptedEnvelope(input: EncryptedEnvelope): Buffer {
  const serialized = canonicalJson(EncryptedEnvelopeSchema.parse(input));
  if (serialized.byteLength > MAX_ENCRYPTED_MANIFEST_BYTES) throw new Error("CHECKPOINT_MANIFEST_ENTITY_SIZE_LIMIT_EXCEEDED");
  return serialized;
}

/** SHA-256 of the serialized outer envelope; distinct from envelope.ciphertextDigest. */
export function encryptedEnvelopeDigest(input: EncryptedEnvelope): string {
  return "0x" + createHash("sha256").update(serializeEncryptedEnvelope(input)).digest("hex");
}

/** SHA-256 commitment to the canonical artifact list embedded inside the encrypted manifest. */
export function artifactManifestDigest(input: Pick<CheckpointManifest, "artifacts">): string {
  return "0x" + createHash("sha256").update(canonicalJson(input.artifacts)).digest("hex");
}

export { MAX_PLAINTEXT_CHUNK_BYTES };

export function encryptChunk(plaintext: Uint8Array, keyHex: string, associatedData: string): {
  bytes: Uint8Array;
  digest: string;
} {
  if (plaintext.byteLength > MAX_PLAINTEXT_CHUNK_BYTES) throw new Error("Plaintext chunk exceeds the Arkiv-safe chunk target");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseKey(keyHex), nonce);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = Buffer.concat([Buffer.from([1]), nonce, ciphertext, cipher.getAuthTag()]);
  if (payload.byteLength > MAX_CIPHERTEXT_CHUNK_BYTES) throw new Error("Encrypted chunk exceeds the Arkiv-safe chunk target");
  return {
    bytes: payload,
    digest: "0x" + createHash("sha256").update(payload).digest("hex"),
  };
}

export function decryptChunk(payload: Uint8Array, expectedDigest: string, keyHex: string, associatedData: string): Uint8Array {
  const data = Buffer.from(payload);
  const digest = "0x" + createHash("sha256").update(data).digest("hex");
  if (digest !== expectedDigest) throw new Error("Artifact chunk digest mismatch");
  if (data.byteLength < 29 || data[0] !== 1) throw new Error("Malformed artifact chunk envelope");
  const nonce = data.subarray(1, 13);
  const tag = data.subarray(data.byteLength - 16);
  const ciphertext = data.subarray(13, data.byteLength - 16);
  const decipher = createDecipheriv("aes-256-gcm", parseKey(keyHex), nonce);
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function digestBytes(...parts: Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return "0x" + hash.digest("hex");
}

function parseKey(keyHex: string): Buffer {
  const normalized = keyHex.startsWith("0x") ? keyHex.slice(2) : keyHex;
  if (!/^[\da-f]{64}$/i.test(normalized)) throw new Error("Checkpoint key must be 32 bytes encoded as 64 hex characters");
  return Buffer.from(normalized, "hex");
}

function aadFor(manifest: Pick<CheckpointManifest, "jobId" | "taskId" | "schemaVersion">): Buffer {
  return Buffer.from("baton:" + manifest.jobId + ":" + manifest.taskId + ":" + manifest.schemaVersion, "utf8");
}

export function encryptManifest(input: CheckpointManifest, keyHex: string, keyId: string): EncryptedEnvelope {
  const manifest = CheckpointManifestSchema.parse(input);
  const key = parseKey(keyHex);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(manifest));
  const plaintext = canonicalJson(manifest);
  if (plaintext.byteLength > MAX_MANIFEST_PLAINTEXT_BYTES) throw new Error("CHECKPOINT_MANIFEST_SIZE_LIMIT_EXCEEDED");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return EncryptedEnvelopeSchema.parse({
    format: "baton-encrypted-v1",
    jobId: manifest.jobId,
    taskId: manifest.taskId,
    schemaVersion: manifest.schemaVersion,
    keyId,
    algorithm: "AES-256-GCM",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertextDigest: digestBytes(nonce, ciphertext, tag),
  });
}

export function decryptManifest(input: EncryptedEnvelope, keyHex: string): CheckpointManifest {
  const envelope = EncryptedEnvelopeSchema.parse(input);
  const key = parseKey(keyHex);
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("Malformed AES-GCM envelope");
  if (digestBytes(nonce, ciphertext, tag) !== envelope.ciphertextDigest) throw new Error("Checkpoint digest mismatch");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aadFor(envelope));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.byteLength > MAX_MANIFEST_PLAINTEXT_BYTES) throw new Error("CHECKPOINT_MANIFEST_SIZE_LIMIT_EXCEEDED");
  const manifest = CheckpointManifestSchema.parse(JSON.parse(plaintext.toString("utf8")));
  if (manifest.jobId !== envelope.jobId || manifest.taskId !== envelope.taskId || manifest.schemaVersion !== envelope.schemaVersion) {
    throw new Error("Checkpoint identity does not match authenticated envelope");
  }
  return manifest;
}
