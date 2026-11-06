import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { getAddress, isHex } from "viem";
import type { CheckpointKeyGrantRequest } from "./recovery.js";

export type EncryptedCheckpointKey = {
  algorithm: "X25519-HKDF-SHA256-AES-256-GCM";
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

export type EncryptedCheckpointKeyGrant = CheckpointKeyGrantRequest & {
  encryptedKey: EncryptedCheckpointKey;
};

export function generateCheckpointKeyRecipientPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
}

export function validateCheckpointKeyRecipientPublicKey(encoded: string): void {
  parsePublicKey(encoded);
}

export function encryptCheckpointKeyForWorker(
  keyHex: string,
  recipientPublicKey: string,
  binding: CheckpointKeyGrantRequest,
): EncryptedCheckpointKey {
  const keyBytes = parseCheckpointKey(keyHex);
  const recipient = parsePublicKey(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const aad = bindingBytes(binding);
  const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const wrappingKey = deriveWrappingKey(sharedSecret, aad);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
  return {
    algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
    ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptCheckpointKeyForWorker(
  encrypted: EncryptedCheckpointKey,
  recipientPrivateKey: string,
  binding: CheckpointKeyGrantRequest,
): string {
  if (encrypted.algorithm !== "X25519-HKDF-SHA256-AES-256-GCM") {
    throw new Error("CHECKPOINT_KEY_GRANT_ENCRYPTION_UNSUPPORTED");
  }
  try {
    const privateKey = parsePrivateKey(recipientPrivateKey);
    const ephemeralPublicKey = parsePublicKey(encrypted.ephemeralPublicKey);
    const nonce = Buffer.from(encrypted.nonce, "base64url");
    const ciphertext = Buffer.from(encrypted.ciphertext, "base64url");
    const tag = Buffer.from(encrypted.tag, "base64url");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength !== 32) {
      throw new Error("malformed encrypted key");
    }
    const aad = bindingBytes(binding);
    const sharedSecret = diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
    const wrappingKey = deriveWrappingKey(sharedSecret, aad);
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const keyBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (keyBytes.byteLength !== 32) throw new Error("malformed decrypted key");
    return "0x" + keyBytes.toString("hex");
  } catch {
    throw new Error("CHECKPOINT_KEY_GRANT_DECRYPTION_FAILED");
  }
}

export function checkpointKeyGrantBindingBytes(binding: CheckpointKeyGrantRequest): Buffer {
  let worker: string;
  try {
    worker = getAddress(binding.worker).toLowerCase();
  } catch {
    throw new Error("CHECKPOINT_KEY_GRANT_BINDING_INVALID");
  }
  if (!binding.jobId.trim() || !binding.taskId.trim() || !binding.keyId.trim()
    || !isHex(binding.manifestDigest, { strict: true }) || binding.manifestDigest.length !== 66) {
    throw new Error("CHECKPOINT_KEY_GRANT_BINDING_INVALID");
  }
  return Buffer.from([
    "baton.checkpoint-key-grant.v1",
    binding.jobId,
    binding.taskId,
    binding.manifestDigest.toLowerCase(),
    binding.keyId,
    worker,
  ].join("\0"), "utf8");
}

function bindingBytes(binding: CheckpointKeyGrantRequest): Buffer {
  return checkpointKeyGrantBindingBytes(binding);
}

function deriveWrappingKey(sharedSecret: Uint8Array, aad: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.from("baton-checkpoint-key-grant-v1"), aad, 32));
}

function parseCheckpointKey(keyHex: string): Buffer {
  const normalized = keyHex.startsWith("0x") ? keyHex.slice(2) : keyHex;
  if (!/^[\da-f]{64}$/i.test(normalized)) throw new Error("CHECKPOINT_KEY_INVALID");
  return Buffer.from(normalized, "hex");
}

function parsePublicKey(encoded: string) {
  const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("CHECKPOINT_KEY_RECIPIENT_KEY_INVALID");
  return key;
}

function parsePrivateKey(encoded: string) {
  const key = createPrivateKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("CHECKPOINT_KEY_RECIPIENT_KEY_INVALID");
  return key;
}
