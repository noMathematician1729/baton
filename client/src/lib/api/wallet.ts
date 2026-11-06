import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import type { JobSnapshot, ProtocolInfo } from "./client";

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

declare global {
  interface Window { ethereum?: Eip1193Provider }
}

export type WalletAccount = { address: Address; chainId: number };

const gatewayActionTypes = {
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

function provider(): Eip1193Provider {
  if (!window.ethereum) throw new Error("Connect an EVM wallet such as MetaMask to authorize this action.");
  return window.ethereum;
}

export async function getWalletAccount(connect = false): Promise<WalletAccount | null> {
  const wallet = provider();
  const accounts = await wallet.request({ method: connect ? "eth_requestAccounts" : "eth_accounts" });
  const chain = await wallet.request({ method: "eth_chainId" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") return null;
  return { address: getAddress(accounts[0]), chainId: Number.parseInt(String(chain), 16) };
}

export async function connectWallet(chainId?: number): Promise<WalletAccount> {
  const wallet = provider();
  const connected = await getWalletAccount(true);
  if (!connected) throw new Error("No EVM account is available in the connected wallet.");
  if (chainId && connected.chainId !== chainId) {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
    const switched = await getWalletAccount(false);
    if (!switched || switched.chainId !== chainId) throw new Error(`Switch your wallet to chain ${chainId} to continue.`);
    return switched;
  }
  return connected;
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export async function protocolDigest(value: unknown): Promise<Hex> {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `0x${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export async function signGatewayAction(input: {
  job: JobSnapshot;
  protocol: ProtocolInfo;
  action: string;
  payload: unknown;
  epoch: number;
  account: WalletAccount;
}): Promise<{ authNonce: Hex; authExpiry: string; authSignature: Hex }> {
  const { job, protocol, account } = input;
  const gatewayAuth = protocol.gatewayAuth;
  if (!gatewayAuth?.verifyingContract) throw new Error("The API has not published a gateway signing contract address.");
  if (account.address.toLowerCase() !== job.terms.buyer.toLowerCase()) throw new Error("Connect the wallet that owns this job before signing.");
  if (account.chainId !== gatewayAuth.chainId) throw new Error(`Switch your wallet to chain ${gatewayAuth.chainId} to authorize this action.`);

  const authNonce = randomNonce();
  const authExpiry = Math.floor(Date.now() / 1000) + 240;
  const policyHash = await protocolDigest(job.servicePolicy);
  const payloadHash = await protocolDigest(input.payload);
  const jobId = job.chainJobId ?? keccak256(stringToHex(job.terms.jobId));
  const taskId = job.chainTaskId ?? keccak256(stringToHex(job.terms.task.taskId));
  const message = {
    actionHash: keccak256(stringToHex(input.action)),
    jobId,
    taskId,
    actor: account.address,
    epoch: String(input.epoch),
    policyHash,
    payloadHash,
    nonce: authNonce,
    expiry: String(authExpiry),
  };

  const signature = await provider().request({
    method: "eth_signTypedData_v4",
    params: [account.address, JSON.stringify({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...gatewayActionTypes,
      },
      primaryType: "GatewayAction",
      domain: {
        name: "BATON Gateway",
        version: "1",
        chainId: gatewayAuth.chainId,
        verifyingContract: getAddress(gatewayAuth.verifyingContract),
      },
      message,
    })],
  });
  if (typeof signature !== "string" || !/^0x[\da-f]{130}$/i.test(signature)) throw new Error("Wallet returned an invalid typed-data signature.");
  return { authNonce, authExpiry: String(authExpiry), authSignature: signature as Hex };
}

export function asAddress(value: string): Address {
  return getAddress(value.trim());
}
