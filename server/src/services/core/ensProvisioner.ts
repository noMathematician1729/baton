import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  concat,
  decodeEventLog,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToBytes,
  toBytes,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { namehash, normalize } from "viem/ens";
import { assertConfirmed, type JournaledChain, type Scope } from "./chainOps.js";

/**
 * ENSv2 (Sepolia) addresses from https://docs.ens.domains/learn/deployments#sepolia-ensv2,
 * pinned to contracts-v2 commit 07e55a056f5b6a9c90119f501bdd05714e67dddd.
 */
export const ENSV2_SEPOLIA = {
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4" as Address,
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" as Address,
  verifiableFactory: "0xda70306c98e97ece36f997a21368e53298572991" as Address,
  userRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a" as Address,
  permissionedResolverImpl: "0x115eb53f0c60696633855f90b138178fb40b2b2c" as Address,
};

export const ALL_ROLES = BigInt("0x" + "1".repeat(64));
export const RESOLVER_ROLE_SET_DATA = 1n << 24n;
const DEPLOY_WINDOW_BLOCKS = 200_000n;

export const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);
export const registryAbi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function setSubregistry(uint256 anyId, address registry)",
  "function setResolver(uint256 anyId, address resolver)",
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
]);
export const resolverAbi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function setData(bytes name, string key, bytes value)",
  "function multicall(bytes[] calls) returns (bytes[])",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function text(bytes32 node, string key) view returns (string)",
]);
export const authorityAbi = parseAbi([
  "function hasWorkerGrant(bytes32 jobId, address worker) view returns (bool)",
  "function jobGrantKey(bytes32 jobId) pure returns (string)",
  "function jobResource(bytes32 jobId) pure returns (uint256)",
  "function ensResolver() view returns (address)",
]);
const universalResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
]);
const addrAbi = parseAbi(["function addr(bytes32 node) view returns (address)", "function text(bytes32 node, string key) view returns (string)"]);

export function dnsEncode(name: string): Hex {
  const labels = normalize(name).split(".");
  const parts: Uint8Array[] = [];
  for (const label of labels) {
    const bytes = stringToBytes(label);
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`Invalid ENS label in ${name}`);
    parts.push(Uint8Array.of(bytes.length), bytes);
  }
  parts.push(Uint8Array.of(0));
  return toHex(concat(parts));
}

export function labelId(label: string): bigint {
  return BigInt(keccak256(toBytes(label)));
}

export function jobGrantKey(jobId: Hex): string {
  return `baton.job.v1:${jobId.slice(2).toLowerCase()}`;
}

export function jobGrantResource(jobId: Hex): bigint {
  return BigInt(keccak256(toBytes(jobGrantKey(jobId))));
}

function loadArtifact(name: string, contractsOut: string): { abi: unknown[]; bytecode: Hex } {
  const abi = JSON.parse(readFileSync(resolve(contractsOut, `${name}.abi.json`), "utf8")) as unknown[];
  const bin = readFileSync(resolve(contractsOut, `${name}.bin`), "utf8").trim();
  return { abi, bytecode: (bin.startsWith("0x") ? bin : `0x${bin}`) as Hex };
}

export class EnsProvisioner {
  public constructor(
    private readonly chain: JournaledChain,
    private readonly contractsOut: string,
    public readonly parentName: string,
  ) {
    if (parentName.split(".").length !== 2 || !parentName.endsWith(".eth")) throw new Error("ENS parent must be a second-level .eth name");
  }

  private get buyer(): Address {
    return this.chain.account.address;
  }

  private read<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<T> {
    return this.chain.publicClient.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  }

  /** Locate a factory proxy previously deployed by the buyer with this salt (journal-loss recovery). */
  private async findProxy(salt: bigint, implementation: Address): Promise<Address | undefined> {
    const latest = await this.chain.publicClient.getBlockNumber();
    const logs = await this.chain.publicClient.getLogs({
      address: ENSV2_SEPOLIA.verifiableFactory,
      event: parseAbiItem("event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)"),
      args: { sender: this.buyer },
      fromBlock: latest > DEPLOY_WINDOW_BLOCKS ? latest - DEPLOY_WINDOW_BLOCKS : 0n,
      toBlock: latest,
    }).catch(() => []);
    const match = logs.find((log) => log.args.salt === salt && getAddress(log.args.implementation!) === getAddress(implementation));
    return match ? getAddress(match.args.proxyAddress!) : undefined;
  }

  private async deployProxy(scope: Scope, key: string, intent: string, implementation: Address, salt: bigint, initData: Hex): Promise<Address> {
    const op = assertConfirmed(await this.chain.run(
      scope,
      key,
      intent,
      async () => ({ to: ENSV2_SEPOLIA.verifiableFactory, data: encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args: [implementation, salt, initData] }) }),
      {
        alreadyDone: async () => {
          const found = await this.findProxy(salt, implementation);
          return found ? { proxy: found } : undefined;
        },
        onReceipt: (receipt) => {
          for (const log of receipt.logs) {
            try {
              const event = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
              if (event.eventName === "ProxyDeployed") return { proxy: getAddress(event.args.proxyAddress) };
            } catch {
              // other events
            }
          }
          return {};
        },
      },
    ));
    const proxy = op.result?.proxy as Address | undefined;
    if (!proxy) throw new Error(`${key}: proxy address missing from receipt`);
    return proxy;
  }

  /** One-time: give the parent name (e.g. baton.eth) its own buyer-owned subregistry. */
  public async ensureParentRegistry(): Promise<Address> {
    const parentLabel = this.parentName.split(".")[0]!;
    const current = await this.read<Address>(ENSV2_SEPOLIA.ethRegistry, registryAbi, "getSubregistry", [parentLabel]);
    if (current !== zeroAddress) return getAddress(current);
    const salt = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [keccak256(toBytes("UserRegistry")), namehash(this.parentName), 0n])));
    const init = encodeFunctionData({ abi: registryAbi, functionName: "initialize", args: [[{ account: this.buyer, roleBitmap: ALL_ROLES }]] });
    const registry = await this.deployProxy({}, `ens:parent-registry:${this.parentName}`, `deploy UserRegistry for ${this.parentName}`, ENSV2_SEPOLIA.userRegistryImpl, salt, init);
    assertConfirmed(await this.chain.run({}, `ens:parent-subregistry:${this.parentName}`, `set ${this.parentName} subregistry`, async () => ({
      to: ENSV2_SEPOLIA.ethRegistry,
      data: encodeFunctionData({ abi: registryAbi, functionName: "setSubregistry", args: [labelId(parentLabel), registry] }),
    }), {
      alreadyDone: async () => {
        const now = await this.read<Address>(ENSV2_SEPOLIA.ethRegistry, registryAbi, "getSubregistry", [parentLabel]);
        return now !== zeroAddress ? { registry: now } : undefined;
      },
    }));
    return registry;
  }

  /**
   * Provision the stable job namespace: a dedicated resolver instance (writer isolation),
   * a job subregistry for worker child names, and a per-job JobAuthority adapter.
   */
  public async provisionJob(input: { jobId: Hex; label: string; escrow: Address; chainId: number }): Promise<{ name: string; registry: Address; resolver: Address; authority: Address }> {
    const scope = { jobId: input.jobId };
    const parentRegistry = await this.ensureParentRegistry();
    const name = `${input.label}.${this.parentName}`;
    const resolverSalt = BigInt(keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["baton.job.resolver.v1", input.jobId])));
    const resolverInit = encodeFunctionData({ abi: resolverAbi, functionName: "initialize", args: [[{ account: this.buyer, roleBitmap: ALL_ROLES }], []] });
    const resolver = await this.deployProxy(scope, "ens:job-resolver", `deploy PermissionedResolver for ${name}`, ENSV2_SEPOLIA.permissionedResolverImpl, resolverSalt, resolverInit);
    const registrySalt = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [keccak256(toBytes("UserRegistry")), namehash(name), 0n])));
    const registryInit = encodeFunctionData({ abi: registryAbi, functionName: "initialize", args: [[{ account: this.buyer, roleBitmap: ALL_ROLES }]] });
    const registry = await this.deployProxy(scope, "ens:job-registry", `deploy UserRegistry for ${name}`, ENSV2_SEPOLIA.userRegistryImpl, registrySalt, registryInit);
    const authorityArtifact = loadArtifact("JobAuthority", this.contractsOut);
    const authorityOp = assertConfirmed(await this.chain.run(scope, "ens:job-authority", `deploy JobAuthority adapter bound to ${resolver}`, async () => ({
      data: encodeDeployData({ abi: authorityArtifact.abi as never, bytecode: authorityArtifact.bytecode, args: [resolver] } as never),
    })));
    const authority = getAddress(String(authorityOp.result?.contractAddress));
    const bound = await this.read<Address>(authority, authorityAbi, "ensResolver", []);
    if (getAddress(bound) !== resolver) throw new Error("JobAuthority adapter is not bound to the job resolver");
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 400 * 86400);
    assertConfirmed(await this.chain.run(scope, "ens:register-job", `register ${name}`, async () => ({
      to: parentRegistry,
      data: encodeFunctionData({ abi: registryAbi, functionName: "register", args: [input.label, this.buyer, registry, resolver, ALL_ROLES, expiry] }),
    }), {
      alreadyDone: async () => {
        const sub = await this.read<Address>(parentRegistry, registryAbi, "getSubregistry", [input.label]);
        return sub !== zeroAddress ? { registry: sub } : undefined;
      },
    }));
    await this.setRecords(scope, "ens:job-records", name, resolver, {
      texts: {
        "baton.job": input.jobId,
        "baton.escrow": `eip155:${input.chainId}:${input.escrow}`,
        "baton.authority": authority,
        "baton.status": "provisioning",
        "baton.epoch": "0",
      },
    });
    return { name, registry, resolver, authority };
  }

  public async registerWorkerName(input: { jobId: Hex; jobName: string; registry: Address; resolver: Address; label: string; worker: Address; workerId: string; epoch: number }): Promise<string> {
    const scope = { jobId: input.jobId };
    const name = `${input.label}.${input.jobName}`;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 400 * 86400);
    assertConfirmed(await this.chain.run(scope, `ens:register-worker:${input.label}`, `register ${name}`, async () => ({
      to: input.registry,
      data: encodeFunctionData({ abi: registryAbi, functionName: "register", args: [input.label, this.buyer, zeroAddress, input.resolver, ALL_ROLES, expiry] }),
    }), {
      alreadyDone: async () => {
        const res = await this.read<Address>(input.registry, registryAbi, "getResolver", [input.label]);
        return res !== zeroAddress ? { resolver: res } : undefined;
      },
    }));
    await this.setRecords(scope, `ens:worker-records:${input.label}`, name, input.resolver, {
      address: input.worker,
      texts: { "baton.worker-id": input.workerId, "baton.role": "assigned", "baton.epoch": String(input.epoch) },
    });
    return name;
  }

  public async setRecords(scope: Scope, key: string, name: string, resolver: Address, records: { address?: Address; texts?: Record<string, string> }) {
    const encoded = dnsEncode(name);
    const calls: Hex[] = [];
    if (records.address) calls.push(encodeFunctionData({ abi: resolverAbi, functionName: "setAddress", args: [encoded, 60n, records.address] }));
    for (const [k, v] of Object.entries(records.texts ?? {})) calls.push(encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [encoded, k, v] }));
    return assertConfirmed(await this.chain.run(scope, key, `set ${calls.length} record(s) on ${name}`, async () => ({
      to: resolver,
      data: encodeFunctionData({ abi: resolverAbi, functionName: "multicall", args: [calls] }),
    })));
  }

  /** Grant ROLE_SET_DATA on the job-key resource only (what JobAuthority checks). */
  public async grantWorker(input: { jobId: Hex; jobName: string; resolver: Address; authority: Address; worker: Address; key: string }) {
    const setter = encodeFunctionData({ abi: resolverAbi, functionName: "setData", args: [dnsEncode(input.jobName), jobGrantKey(input.jobId), "0x"] });
    assertConfirmed(await this.chain.run({ jobId: input.jobId }, input.key, `grant job-scoped ROLE_SET_DATA to ${input.worker}`, async () => ({
      to: input.resolver,
      data: encodeFunctionData({ abi: resolverAbi, functionName: "grantSetterRoles", args: [setter, input.worker] }),
    }), {
      alreadyDone: async () => ((await this.hasGrant(input.authority, input.jobId, input.worker)) ? { granted: true } : undefined),
    }));
    if (!(await this.hasGrant(input.authority, input.jobId, input.worker))) throw new Error("Worker grant not visible through JobAuthority after confirmation");
  }

  public async revokeWorker(input: { jobId: Hex; resolver: Address; authority: Address; worker: Address; key: string }) {
    assertConfirmed(await this.chain.run({ jobId: input.jobId }, input.key, `revoke job-scoped ROLE_SET_DATA from ${input.worker}`, async () => ({
      to: input.resolver,
      data: encodeFunctionData({ abi: resolverAbi, functionName: "revokeRoles", args: [jobGrantResource(input.jobId), RESOLVER_ROLE_SET_DATA, input.worker] }),
    }), {
      alreadyDone: async () => ((await this.hasGrant(input.authority, input.jobId, input.worker)) ? undefined : { revoked: true }),
    }));
    if (await this.hasGrant(input.authority, input.jobId, input.worker)) throw new Error("Worker grant still visible after revoke");
  }

  public hasGrant(authority: Address, jobId: Hex, worker: Address): Promise<boolean> {
    return this.read<boolean>(authority, authorityAbi, "hasWorkerGrant", [jobId, worker]);
  }

  /** Resolve through the ENSv2 Universal Resolver (the public discovery path), not the resolver directly. */
  public async resolveAddress(name: string): Promise<Address | null> {
    try {
      const call = encodeFunctionData({ abi: addrAbi, functionName: "addr", args: [namehash(name)] });
      const [data] = await this.read<[Hex, Address]>(ENSV2_SEPOLIA.universalResolver, universalResolverAbi, "resolve", [dnsEncode(name), call]);
      const value = `0x${data.slice(-40)}` as Address;
      return value === zeroAddress ? null : getAddress(value);
    } catch {
      return null;
    }
  }

  public async resolveText(name: string, key: string): Promise<string | null> {
    try {
      const call = encodeFunctionData({ abi: addrAbi, functionName: "text", args: [namehash(name), key] });
      const [data] = await this.read<[Hex, Address]>(ENSV2_SEPOLIA.universalResolver, universalResolverAbi, "resolve", [dnsEncode(name), call]);
      const { decodeFunctionResult } = await import("viem");
      return decodeFunctionResult({ abi: addrAbi, functionName: "text", data }) as string;
    } catch {
      return null;
    }
  }
}
