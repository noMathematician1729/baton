import { digest, type JobSnapshot } from "../protocol/v1.js";
import { authorizeSignedGatewayAction, type GatewayActionNonceStore } from "./gatewayActionAuth.js";
import { parseInitialChainJobSnapshot } from "./chainJobImport.js";
import type { JobStore } from "../domain/jobs/jobStore.js";
import type { OperationLedger } from "../services/ledger/operationLedger.js";

export async function importInitialChainJob(input: {
  snapshot: unknown;
  authorizationBody: unknown;
  chainId: number;
  verifyingContract: string;
  nonceStore: GatewayActionNonceStore;
  jobs: Pick<JobStore, "get" | "importInitial">;
  ledger: Pick<OperationLedger, "getBalance" | "beginJobProvision" | "completeJobProvision" | "pendingJobProvisions">;
  authority: { assertImportableJob(job: JobSnapshot): Promise<void> };
  nowSeconds?: number;
}): Promise<{ job: JobSnapshot; created: boolean }> {
  const job = parseInitialChainJobSnapshot(input.snapshot);
  await authorizeSignedGatewayAction({
    chainId: input.chainId,
    verifyingContract: input.verifyingContract,
    nonceStore: input.nonceStore,
    body: input.authorizationBody,
    job,
    actor: job.terms.buyer,
    epoch: 0,
    action: "IMPORT_JOB",
    payload: { snapshotDigest: digest(job) },
    nowSeconds: input.nowSeconds,
  });

  const existing = await input.jobs.get(job.terms.jobId);
  if (existing && digest(existing) !== digest(job)) throw new Error("JOB_PROVISIONING_CONFLICT");
  if (existing && await input.ledger.getBalance(job.terms.jobId)) return { job: existing, created: false };

  await input.authority.assertImportableJob(job);
  await input.ledger.beginJobProvision(job);
  try {
    await input.jobs.importInitial(job);
    await input.ledger.completeJobProvision(job);
  } catch (error) {
    try {
      for (const provision of await input.ledger.pendingJobProvisions()) {
        await input.jobs.importInitial(provision.job);
        await input.ledger.completeJobProvision(provision.job);
      }
      const persistedJob = await input.jobs.get(job.terms.jobId);
      if (persistedJob && await input.ledger.getBalance(job.terms.jobId)) {
        return { job: persistedJob, created: !existing };
      }
    } catch {
      // Keep the durable journal pending for the next startup recovery pass.
    }
    throw error;
  }
  return { job, created: !existing };
}
