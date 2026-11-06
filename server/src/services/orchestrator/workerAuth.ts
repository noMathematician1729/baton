import { createHash } from "node:crypto";
import { verifyMessage, type Address, type Hex } from "viem";

/**
 * Worker → BATON API request authentication. Each request is signed by the worker's
 * own wallet (EIP-191) over method, path, timestamp and body digest. The API never
 * holds worker keys; it only recovers the signer and compares it to the registry.
 */
export const WORKER_AUTH_MAX_SKEW_SECONDS = 120;

export function workerRequestMessage(input: { workerId: string; method: string; path: string; timestamp: number; body: string }): string {
  const bodyDigest = createHash("sha256").update(input.body).digest("hex");
  return ["BATON-WORKER-REQUEST-V1", input.workerId, input.method.toUpperCase(), input.path, String(input.timestamp), bodyDigest].join("\n");
}

export function registrationMessage(input: { workerId: string; address: Address; nonce: string }): string {
  return ["BATON worker wallet ownership", `worker: ${input.workerId}`, `address: ${input.address}`, `nonce: ${input.nonce}`].join("\n");
}

export async function verifyWorkerRequest(input: {
  workerId: string;
  expectedAddress: Address;
  method: string;
  path: string;
  timestamp: number;
  body: string;
  signature: Hex;
  nowSeconds?: number;
}): Promise<boolean> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(input.timestamp) || Math.abs(now - input.timestamp) > WORKER_AUTH_MAX_SKEW_SECONDS) return false;
  try {
    return await verifyMessage({ address: input.expectedAddress, message: workerRequestMessage(input), signature: input.signature });
  } catch {
    return false;
  }
}
