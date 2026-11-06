import {
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { digest, type JobSnapshot } from "../protocol/v1.js";

export const GATEWAY_ACTION_TYPES = {
  GatewayAction: [
    { name: "actionHash", type: "bytes32" },
    { name: "jobId", type: "bytes32" },
    { name: "taskId", type: "bytes32" },
    { name: "actor", type: "address" },
    { name: "epoch", type: "uint64" },
    { name: "policyHash", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export type GatewayActionMessage = {
  actionHash: Hex;
  jobId: Hex;
  taskId: Hex;
  actor: Address;
  epoch: bigint;
  policyHash: Hex;
  payloadHash: Hex;
  nonce: Hex;
  expiry: bigint;
};

export function gatewayActionDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: "BATON Gateway", version: "1", chainId, verifyingContract };
}

export function gatewayActionMessage(input: {
  action: string;
  job: JobSnapshot;
  actor: Address;
  epoch: number;
  payload: unknown;
  nonce: Hex;
  expiry: number;
}): GatewayActionMessage {
  return {
    actionHash: keccak256(stringToHex(input.action)),
    jobId: input.job.chainJobId ?? keccak256(stringToHex(input.job.terms.jobId)),
    taskId: input.job.chainTaskId ?? keccak256(stringToHex(input.job.terms.task.taskId)),
    actor: input.actor,
    epoch: BigInt(input.epoch),
    policyHash: digest(input.job.servicePolicy),
    payloadHash: digest(input.payload),
    nonce: input.nonce,
    expiry: BigInt(input.expiry),
  };
}

export async function recoverGatewayActionActor(input: {
  chainId: number;
  verifyingContract: Address;
  message: GatewayActionMessage;
  signature: Hex;
}): Promise<Address> {
  return recoverTypedDataAddress({
    domain: gatewayActionDomain(input.chainId, input.verifyingContract),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message: input.message,
    signature: input.signature,
  });
}
