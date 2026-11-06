import { getAddress } from "viem";
import { decryptCheckpointKeyForWorker, type EncryptedCheckpointKey } from "./keyGrantCrypto.js";
import type { CheckpointKeyGrantRequest, CheckpointKeyGrantResolver } from "./recovery.js";

type KeyGrantResponse = CheckpointKeyGrantRequest & { encryptedKey: EncryptedCheckpointKey };

/** Client for the buyer-controlled, job/checkpoint/worker-scoped key grant endpoint. */
export class HttpCheckpointKeyGrantResolver implements CheckpointKeyGrantResolver {
  private readonly endpoint: URL;

  public constructor(
    endpoint: string,
    private readonly bearerToken: string,
    private readonly recipientPrivateKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    try {
      this.endpoint = new URL(endpoint);
    } catch {
      throw new Error("CHECKPOINT_KEY_SERVICE_URL_INVALID");
    }
    const localHttp = this.endpoint.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1"].includes(this.endpoint.hostname);
    if (this.endpoint.protocol !== "https:" && !localHttp) throw new Error("CHECKPOINT_KEY_SERVICE_TLS_REQUIRED");
    if (this.endpoint.username || this.endpoint.password || this.endpoint.hash) throw new Error("CHECKPOINT_KEY_SERVICE_URL_INVALID");
    if (!bearerToken.trim()) throw new Error("CHECKPOINT_KEY_SERVICE_AUTH_REQUIRED");
    if (!recipientPrivateKey.trim()) throw new Error("CHECKPOINT_KEY_SERVICE_RECIPIENT_KEY_REQUIRED");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error("CHECKPOINT_KEY_SERVICE_TIMEOUT_INVALID");
    }
  }

  public async resolveGrantedKey(input: CheckpointKeyGrantRequest): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error("CHECKPOINT_KEY_GRANT_UNAVAILABLE");
    }
    if (!response.ok) throw new Error("CHECKPOINT_KEY_GRANT_DENIED");

    let grant: unknown;
    try {
      grant = await response.json();
    } catch {
      throw new Error("CHECKPOINT_KEY_GRANT_RESPONSE_INVALID");
    }
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
      throw new Error("CHECKPOINT_KEY_GRANT_RESPONSE_INVALID");
    }
    const record = grant as Partial<KeyGrantResponse>;
    if (record.jobId !== input.jobId || record.taskId !== input.taskId
      || typeof record.manifestDigest !== "string" || record.manifestDigest.toLowerCase() !== input.manifestDigest.toLowerCase()
      || record.keyId !== input.keyId || typeof record.worker !== "string"
      || !sameAddress(record.worker, input.worker)) {
      throw new Error("CHECKPOINT_KEY_GRANT_BINDING_MISMATCH");
    }
    if (!isEncryptedKey(record.encryptedKey)) {
      throw new Error("CHECKPOINT_KEY_GRANT_RESPONSE_INVALID");
    }
    return decryptCheckpointKeyForWorker(record.encryptedKey, this.recipientPrivateKey, input);
  }
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left).toLowerCase() === getAddress(right).toLowerCase();
  } catch {
    return false;
  }
}

function isEncryptedKey(value: unknown): value is EncryptedCheckpointKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<EncryptedCheckpointKey>;
  return record.algorithm === "X25519-HKDF-SHA256-AES-256-GCM"
    && typeof record.ephemeralPublicKey === "string"
    && typeof record.nonce === "string"
    && typeof record.ciphertext === "string"
    && typeof record.tag === "string";
}
