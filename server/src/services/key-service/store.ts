import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getAddress, isHex } from "viem";
import {
  checkpointKeyGrantBindingBytes,
  encryptCheckpointKeyForWorker,
  validateCheckpointKeyRecipientPublicKey,
  type EncryptedCheckpointKeyGrant,
} from "../../../packages/storage/src/keyGrantCrypto.js";
import type { CheckpointKeyGrantRequest } from "../../../packages/storage/src/recovery.js";

type TokenRow = { worker_address: string; recipient_public_key: string };
type GrantRow = { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };

export class KeyServiceError extends Error {
  public constructor(public readonly code: "UNAUTHORIZED" | "WORKER_SUBJECT_MISMATCH" | "KEY_GRANT_NOT_FOUND") {
    super(code);
  }
}

/** Buyer-owned local store. Worker tokens are hashed and checkpoint keys are encrypted at rest. */
export class CheckpointKeyGrantStore {
  private readonly db: DatabaseSync;
  private readonly storageKey: Buffer;

  public constructor(databasePath: string, storageKeyHex: string) {
    this.storageKey = parseStorageKey(storageKeyHex);
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(databasePath), 0o700);
    }
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS worker_tokens (
        token_hash TEXT PRIMARY KEY,
        worker_address TEXT NOT NULL,
        recipient_public_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worker_tokens_address ON worker_tokens(worker_address);
      CREATE TABLE IF NOT EXISTS checkpoint_key_grants (
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        key_id TEXT NOT NULL,
        worker_address TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, task_id, manifest_digest, key_id, worker_address)
      );
    `);
  }

  public close(): void {
    this.db.close();
  }

  public replaceWorkerToken(workerAddress: string, token: string, recipientPublicKey: string): void {
    const worker = normalizeWorker(workerAddress);
    if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error("WORKER_TOKEN_INVALID");
    // Validate the recipient key before making it an authenticated token subject.
    validateCheckpointKeyRecipientPublicKey(recipientPublicKey);
    const tokenHash = hashToken(token);
    this.transaction(() => {
      this.db.prepare("DELETE FROM worker_tokens WHERE worker_address = ?").run(worker);
      this.db.prepare(`
        INSERT INTO worker_tokens (token_hash, worker_address, recipient_public_key, created_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenHash, worker, recipientPublicKey, new Date().toISOString());
    });
  }

  public grantKey(input: CheckpointKeyGrantRequest, keyHex: string): void {
    const binding = normalizeBinding(input);
    const key = parseCheckpointKey(keyHex);
    const aad = checkpointKeyGrantBindingBytes(binding);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.storageKey, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db.prepare(`
      INSERT INTO checkpoint_key_grants
        (job_id, task_id, manifest_digest, key_id, worker_address, nonce, ciphertext, tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (job_id, task_id, manifest_digest, key_id, worker_address)
      DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext, tag = excluded.tag, created_at = excluded.created_at
    `).run(
      binding.jobId,
      binding.taskId,
      binding.manifestDigest.toLowerCase(),
      binding.keyId,
      binding.worker.toLowerCase(),
      nonce,
      ciphertext,
      tag,
      new Date().toISOString(),
    );
  }

  public resolve(token: string, request: CheckpointKeyGrantRequest): EncryptedCheckpointKeyGrant {
    const worker = normalizeWorker(request.worker);
    const row = this.db.prepare(`
      SELECT worker_address, recipient_public_key FROM worker_tokens WHERE token_hash = ?
    `).get(hashToken(token)) as TokenRow | undefined;
    if (!row) throw new KeyServiceError("UNAUTHORIZED");
    if (row.worker_address.toLowerCase() !== worker.toLowerCase()) {
      throw new KeyServiceError("WORKER_SUBJECT_MISMATCH");
    }

    const binding = normalizeBinding(request);
    const grant = this.db.prepare(`
      SELECT nonce, ciphertext, tag FROM checkpoint_key_grants
      WHERE job_id = ? AND task_id = ? AND manifest_digest = ? AND key_id = ? AND worker_address = ?
    `).get(
      binding.jobId,
      binding.taskId,
      binding.manifestDigest.toLowerCase(),
      binding.keyId,
      binding.worker.toLowerCase(),
    ) as GrantRow | undefined;
    if (!grant) throw new KeyServiceError("KEY_GRANT_NOT_FOUND");

    const key = this.decryptStoredKey(binding, grant);
    return {
      ...binding,
      encryptedKey: encryptCheckpointKeyForWorker(key, row.recipient_public_key, binding),
    };
  }

  private decryptStoredKey(binding: CheckpointKeyGrantRequest, grant: GrantRow): string {
    const decipher = createDecipheriv("aes-256-gcm", this.storageKey, Buffer.from(grant.nonce));
    decipher.setAAD(checkpointKeyGrantBindingBytes(binding));
    decipher.setAuthTag(Buffer.from(grant.tag));
    const key = Buffer.concat([decipher.update(Buffer.from(grant.ciphertext)), decipher.final()]);
    if (key.byteLength !== 32) throw new Error("KEY_GRANT_STORE_CORRUPT");
    return "0x" + key.toString("hex");
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function generateWorkerAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

function parseStorageKey(value: string): Buffer {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[\da-f]{64}$/i.test(normalized)) throw new Error("KEY_SERVICE_STORAGE_KEY_INVALID");
  return Buffer.from(normalized, "hex");
}

function parseCheckpointKey(value: string): Buffer {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[\da-f]{64}$/i.test(normalized)) throw new Error("CHECKPOINT_KEY_INVALID");
  return Buffer.from(normalized, "hex");
}

function normalizeWorker(value: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error("CHECKPOINT_KEY_GRANT_WORKER_INVALID");
  }
}

function normalizeBinding(input: CheckpointKeyGrantRequest): CheckpointKeyGrantRequest {
  if (!input.jobId.trim() || !input.taskId.trim() || !input.keyId.trim()
    || !isHex(input.manifestDigest, { strict: true }) || input.manifestDigest.length !== 66) {
    throw new Error("CHECKPOINT_KEY_GRANT_BINDING_INVALID");
  }
  return {
    jobId: input.jobId,
    taskId: input.taskId,
    manifestDigest: input.manifestDigest.toLowerCase() as `0x${string}`,
    keyId: input.keyId,
    worker: normalizeWorker(input.worker) as `0x${string}`,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update("baton-checkpoint-key-service-token-v1\0").update(token).digest("hex");
}
