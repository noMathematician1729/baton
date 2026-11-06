import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWorkerEnvironment } from "./workerEnvironment.js";

test("Worker B loads suffixed credentials while buyer and A signers remain filtered", () => {
  const environment: Record<string, string | undefined> = {
    SEPOLIA_DEPLOYER_PRIVATE_KEY: "buyer-signer",
    BUYER_SEPOLIA_SIGNER: "buyer-address",
    WORKER_A_EVM_PRIVATE_KEY: "worker-a-signer",
    ARKIV_SIGNER_PRIVATE_KEY_B: "storage-signer",
  };
  applyWorkerEnvironment(environment, {
    BATON_ESCROW_ADDRESS: "root-escrow",
    WORKER_B_ADDRESS: "root-worker-b-address",
    WORKER_B_EVM_PRIVATE_KEY: "root-worker-b-signer",
    ARKIV_RPC_URL_B: "root-worker-b-rpc",
    ARKIV_ACCESS_KEY_B: "root-worker-b-access",
  }, {
    BATON_ESCROW_ADDRESS: "worker-escrow",
    WORKER_ADDRESS: "worker-file-worker-b-address",
    WORKER_B_EVM_PRIVATE_KEY: "worker-file-worker-b-signer",
    ARKIV_RPC_URL_B: "worker-file-worker-b-rpc",
    ARKIV_ACCESS_KEY: "worker-file-worker-b-access",
    CHECKPOINT_KEY_SERVICE_TOKEN: "worker-b-token",
  });

  assert.equal(environment.BATON_ESCROW_ADDRESS, "worker-escrow");
  assert.equal(environment.WORKER_ADDRESS, "worker-file-worker-b-address");
  assert.equal(environment.WORKER_EVM_PRIVATE_KEY, "worker-file-worker-b-signer");
  assert.equal(environment.ARKIV_RPC_URL, "worker-file-worker-b-rpc");
  assert.equal(environment.ARKIV_ACCESS_KEY, "worker-file-worker-b-access");
  assert.equal(environment.CHECKPOINT_KEY_SERVICE_TOKEN, "worker-b-token");
  assert.equal(environment.SEPOLIA_DEPLOYER_PRIVATE_KEY, undefined);
  assert.equal(environment.BUYER_SEPOLIA_SIGNER, undefined);
  assert.equal(environment.WORKER_A_EVM_PRIVATE_KEY, undefined);
  assert.equal(environment.ARKIV_SIGNER_PRIVATE_KEY_B, undefined);
});
