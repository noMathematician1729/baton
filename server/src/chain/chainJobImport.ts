import { deserialise, digest, EMPTY_HEAD, type Hex, type JobSnapshot } from "../protocol/v1.js";

/** Parses a buyer-authenticated snapshot that may only initialize an unfunded local mirror of a funded chain job. */
export function parseInitialChainJobSnapshot(value: unknown): JobSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CHAIN_JOB_SNAPSHOT_INVALID");
  const snapshot = deserialise<JobSnapshot>(value);
  if (!snapshot || typeof snapshot !== "object") throw new Error("CHAIN_JOB_SNAPSHOT_INVALID");
  const terms = snapshot.terms;
  const taskTerms = terms?.task;
  const task = snapshot.task;
  const head = task?.acceptedHead;
  const policy = snapshot.servicePolicy;

  if (!isHex32(snapshot.chainJobId) || !isHex32(snapshot.chainTaskId)
    || !terms || typeof terms.jobId !== "string" || terms.jobId.length === 0
    || !isAddress(terms.buyer) || !isAddress(terms.rewardToken) || !isAddress(terms.verifier)
    || !isHex32(terms.termsHash) || !isHex32(terms.taskGraphHash)
    || !Number.isSafeInteger(terms.cutoff) || !taskTerms || typeof taskTerms.taskId !== "string" || taskTerms.taskId.length === 0
    || !isHex32(taskTerms.requiredCapabilitiesHash) || !isHex32(taskTerms.acceptanceSpecHash)
    || !Number.isSafeInteger(taskTerms.deadline) || taskTerms.deadline !== terms.cutoff
    || typeof terms.serviceBudget !== "bigint" || terms.serviceBudget < 0n
    || !Array.isArray(taskTerms.milestones) || taskTerms.milestones.length === 0
    || taskTerms.milestones.some((milestone) => !milestone || typeof milestone !== "object"
      || typeof milestone.id !== "string" || milestone.id.length === 0
      || typeof milestone.reward !== "bigint" || milestone.reward <= 0n
      || !isHex32(milestone.acceptanceSpecHash)
      || !Number.isSafeInteger(milestone.progressPercent) || milestone.progressPercent < 0 || milestone.progressPercent > 100)
    || !task || task.taskId !== taskTerms.taskId || task.assignedWorker !== null || task.epoch !== 0
    || task.nextMilestone !== 0 || task.status !== "FUNDED" || task.drained !== false
    || !head || !isHex32(head.manifestDigest) || head.manifestDigest.toLowerCase() !== EMPTY_HEAD
    || !isHex32(head.artifactManifestDigest) || head.artifactManifestDigest.toLowerCase() !== EMPTY_HEAD || head.manifestRef !== ""
    || head.schemaVersion !== "checkpoint.v1" || head.sequence !== 0 || head.previousAcceptedHead !== null
    || !Array.isArray(snapshot.credits) || snapshot.credits.length !== 0
    || !policy || policy.budget !== terms.serviceBudget || policy.asset !== terms.serviceAsset
    || typeof terms.serviceAsset !== "string" || terms.serviceAsset.length === 0
    || typeof policy.providerId !== "string" || policy.providerId.length === 0
    || typeof policy.network !== "string" || policy.network.length === 0
    || !isAddress(policy.payee) || typeof policy.policyVersion !== "string" || policy.policyVersion.length === 0
    || typeof policy.perRequestCap !== "bigint" || policy.perRequestCap <= 0n
    || !Array.isArray(policy.approvedServices) || policy.approvedServices.some((service) => typeof service !== "string" || service.length === 0)
    || typeof snapshot.createdAt !== "string" || typeof snapshot.updatedAt !== "string") {
    throw new Error("CHAIN_JOB_SNAPSHOT_INVALID");
  }

  const expectedTermsHash = digest({
    buyer: terms.buyer,
    rewardToken: terms.rewardToken,
    task: taskTerms,
    serviceBudget: terms.serviceBudget,
  });
  if (expectedTermsHash.toLowerCase() !== terms.termsHash.toLowerCase()) {
    throw new Error("CHAIN_TERMS_SNAPSHOT_MISMATCH");
  }
  return snapshot;
}

export function rewardPoolFromSnapshot(job: JobSnapshot): bigint {
  return job.terms.task.milestones.reduce((total, milestone) => total + milestone.reward, 0n);
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
}

function isAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
}
