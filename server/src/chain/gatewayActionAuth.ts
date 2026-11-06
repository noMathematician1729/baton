import { getAddress } from "viem";
import { gatewayActionMessage, recoverGatewayActionActor } from "./gatewayAction.js";
import type { Hex, JobSnapshot } from "../protocol/v1.js";

export interface GatewayActionNonceStore {
  consumeAuthNonce(scope: string, nonce: Hex, expiresAt: number): Promise<void>;
}

/** Verifies one signed API action and durably consumes its nonce. */
export async function authorizeSignedGatewayAction(input: {
  chainId: number;
  verifyingContract: string;
  nonceStore: GatewayActionNonceStore;
  body: unknown;
  job: JobSnapshot;
  actor: Hex;
  epoch: number;
  action: string;
  payload: unknown;
  prefix?: string;
  nowSeconds?: number;
}): Promise<void> {
  const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
  const prefix = input.prefix ?? "auth";
  const nonce = digestValue(body[`${prefix}Nonce`], `${prefix}Nonce`);
  const expiry = timestampValue(body[`${prefix}Expiry`], `${prefix}Expiry`);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (expiry <= now) throw new Error("ACTION_SIGNATURE_EXPIRED");
  if (expiry > now + 300) throw new Error("ACTION_SIGNATURE_LIFETIME_TOO_LONG");
  const signature = signatureValue(body[`${prefix}Signature`], `${prefix}Signature`);
  const actor = getAddress(input.actor);
  const verifyingContract = getAddress(input.verifyingContract);
  const message = gatewayActionMessage({
    action: input.action,
    job: input.job,
    actor,
    epoch: input.epoch,
    payload: input.payload,
    nonce,
    expiry,
  });
  let recovered: Hex;
  try {
    recovered = await recoverGatewayActionActor({
      chainId: input.chainId,
      verifyingContract,
      message,
      signature,
    });
  } catch {
    throw new Error("ACTION_SIGNATURE_INVALID");
  }
  if (recovered.toLowerCase() !== actor.toLowerCase()) throw new Error("ACTION_ACTOR_MISMATCH");

  const jobScope = input.job.chainJobId ?? input.job.terms.jobId;
  const scope = `${input.chainId}:${verifyingContract.toLowerCase()}:${jobScope}:${actor.toLowerCase()}`;
  await input.nonceStore.consumeAuthNonce(scope, nonce, expiry);
}

function digestValue(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`INVALID_${errorLabel(label)}`);
  return value.toLowerCase() as Hex;
}

function signatureValue(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[\da-f]{130}$/i.test(value)) throw new Error(`INVALID_${errorLabel(label)}`);
  return value as Hex;
}

function timestampValue(value: unknown, label: string): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error(`INVALID_${errorLabel(label)}`);
  return timestamp;
}

function errorLabel(label: string): string {
  return label.replace(/([a-z\d])([A-Z])/g, "$1_$2").toUpperCase();
}
