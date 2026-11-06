// Retention boundary check: can a non-owner extend a checkpoint entity after its writer is gone?
//   node --env-file=.env.worker-b --import tsx scripts/core/arkiv-retention-check.ts <entityKey>
// Writes one Arkiv extension transaction signed by the *calling* worker (not the entity owner).
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const entityKey = process.argv[2] as Hex;
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY! });
const transport = http(process.env.ARKIV_RPC_URL || undefined);
const account = privateKeyToAccount(process.env.ARKIV_SIGNER_PRIVATE_KEY as Hex);
const reader = createPublicClient({ chain, transport });
const before = await reader.getEntity(entityKey);
const block = await reader.getBlockNumber();
const wallet = createWalletClient({ account, chain, transport });
let extension: unknown;
try {
  const result = await wallet.extendEntity({ entityKey, expiration: ExpirationTime.max() });
  extension = { ok: true, txHash: result.txHash, expiresAt: String(result.expiresAt) };
} catch (error) {
  extension = { ok: false, error: (error as Error).message.split("\n")[0] };
}
const after = await reader.getEntity(entityKey);
console.log(JSON.stringify({ entityKey, owner: before.$owner, extender: account.address, currentBlock: String(block), expiresAtBefore: String(before.$expiresAt), extension, expiresAtAfter: String(after.$expiresAt) }, null, 2));
