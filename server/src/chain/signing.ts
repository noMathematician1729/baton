import { hashTypedData, type Address, type Hex, type TypedDataDomain } from "viem";
import { EMPTY_HEAD } from "../protocol/v1.js";

type TypedField = { readonly name: string; readonly type: string };

export const BATON_DOMAIN = {
  name: "BATON Job Escrow",
  version: "1",
} as const satisfies TypedDataDomain;

export const OFFER_TYPES = {
  MilestoneOffer: [
    { name: "jobId", type: "bytes32" },
    { name: "taskId", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "producer", type: "address" },
    { name: "epoch", type: "uint64" },
    { name: "milestone", type: "uint32" },
    { name: "acceptanceSpecHash", type: "bytes32" },
    { name: "expectedHead", type: "bytes32" },
    { name: "newHead", type: "bytes32" },
    { name: "manifestRef", type: "string" },
    { name: "sequence", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
} as const satisfies Record<string, readonly TypedField[]>;

export const TAKEOVER_TYPES = {
  TakeoverAck: [
    { name: "jobId", type: "bytes32" },
    { name: "taskId", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "successor", type: "address" },
    { name: "epoch", type: "uint64" },
    { name: "expectedHead", type: "bytes32" },
    { name: "compatibilityReport", type: "bytes32" },
    { name: "servicePolicy", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
} as const satisfies Record<string, readonly TypedField[]>;

export type MilestoneOffer = {
  jobId: Hex;
  taskId: Hex;
  termsHash: Hex;
  producer: Address;
  epoch: bigint;
  milestone: number;
  acceptanceSpecHash: Hex;
  expectedHead: Hex;
  newHead: Hex;
  manifestRef: string;
  sequence: bigint;
  nonce: bigint;
  expiry: bigint;
};

export type TakeoverAck = {
  jobId: Hex;
  taskId: Hex;
  termsHash: Hex;
  successor: Address;
  epoch: bigint;
  expectedHead: Hex;
  compatibilityReport: Hex;
  servicePolicy: Hex;
  nonce: bigint;
  expiry: bigint;
};

export function domain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { ...BATON_DOMAIN, chainId, verifyingContract };
}

export function hashOffer(
  offer: MilestoneOffer,
  chainId: number,
  verifyingContract: Address,
): Hex {
  return hashTypedData({ domain: domain(chainId, verifyingContract), types: OFFER_TYPES, primaryType: "MilestoneOffer", message: offer });
}

export function hashTakeover(
  ack: TakeoverAck,
  chainId: number,
  verifyingContract: Address,
): Hex {
  return hashTypedData({ domain: domain(chainId, verifyingContract), types: TAKEOVER_TYPES, primaryType: "TakeoverAck", message: ack });
}

export function emptyHead(): Hex {
  return EMPTY_HEAD as Hex;
}
