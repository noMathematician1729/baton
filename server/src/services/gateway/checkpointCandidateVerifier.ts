import { isHex } from "viem";
import { CHECKPOINT_SCHEMA_VERSION } from "../../../packages/checkpoint/src/index.js";
import { recoverAcceptedPackage, type RecoveryAdapter } from "../../../packages/storage/src/recovery.js";
import type { ArkivContentStore } from "../../../packages/storage/src/arkiv.js";
import { EMPTY_HEAD, type CheckpointHead, type Hex, type JobSnapshot } from "../../protocol/v1.js";
import type { CheckpointAcceptanceVerifier } from "./gateway.js";

export const SUPPORTED_CHECKPOINT_ADAPTERS: readonly RecoveryAdapter[] = [
  { id: "baton.deterministic-batch", version: "1.0.0", stateSchemaVersion: "1" },
  { id: "baton.beta-bernoulli", version: "1.0.0", stateSchemaVersion: "1" },
];

type CandidateStore = Pick<ArkivContentStore, "readEnvelope" | "readArtifact" | "getEntityMetadata">;

export class ArkivCheckpointCandidateVerifier implements CheckpointAcceptanceVerifier {
  public constructor(private readonly input: {
    store: CandidateStore;
    checkpointKey: string;
    keyId: string;
    expectedStorageOwner: string;
    supportedAdapters?: readonly RecoveryAdapter[];
  }) {
    if (!/^(0x)?[\da-f]{64}$/i.test(input.checkpointKey)) throw new Error("CHECKPOINT_KEY_INVALID");
    if (!input.keyId.trim()) throw new Error("CHECKPOINT_KEY_ID_REQUIRED");
    if (!isAddress(input.expectedStorageOwner)) throw new Error("ARKIV_STORAGE_OWNER_INVALID");
  }

  public async verifyCandidate(input: {
    job: JobSnapshot;
    acceptanceSpecHash: Hex;
    expectedHead: Hex;
    newHead: CheckpointHead;
  }): Promise<void> {
    const { job, newHead } = input;
    const milestone = job.terms.task.milestones[job.task.nextMilestone];
    if (!milestone || milestone.acceptanceSpecHash.toLowerCase() !== input.acceptanceSpecHash.toLowerCase()) {
      throw new Error("ACCEPTANCE_SPEC_MISMATCH");
    }
    if (job.task.taskId !== job.terms.task.taskId || input.expectedHead.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()) {
      throw new Error("STALE_HEAD");
    }
    if (newHead.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) throw new Error("CHECKPOINT_SCHEMA_UNSUPPORTED");
    if (!isBytes32(newHead.manifestDigest) || !isBytes32(newHead.artifactManifestDigest)
      || !isBytes32(newHead.manifestRef)) throw new Error("CHECKPOINT_BINDING_INVALID");
    if (!Number.isSafeInteger(newHead.sequence) || newHead.sequence !== job.task.acceptedHead.sequence + 1) {
      throw new Error("CHECKPOINT_SEQUENCE_INVALID");
    }
    const expectedParent = input.expectedHead.toLowerCase() === EMPTY_HEAD ? null : input.expectedHead.toLowerCase();
    if (newHead.previousAcceptedHead === undefined
      || normalizeHead(newHead.previousAcceptedHead) !== expectedParent) {
      throw new Error("CHECKPOINT_PARENT_MISMATCH");
    }

    await recoverAcceptedPackage({
      store: this.input.store,
      keyGrants: {
        resolveGrantedKey: async (request) => {
          if (request.keyId !== this.input.keyId) throw new Error("CHECKPOINT_KEY_ID_MISMATCH");
          return this.input.checkpointKey;
        },
      },
      accepted: {
        jobId: job.terms.jobId,
        taskId: job.terms.task.taskId,
        producerEpoch: job.task.epoch,
        manifestDigest: newHead.manifestDigest,
        manifestRef: newHead.manifestRef as Hex,
        sequence: newHead.sequence,
        previousAcceptedHead: newHead.previousAcceptedHead,
        artifactManifestDigest: newHead.artifactManifestDigest,
      },
      worker: job.terms.buyer,
      expectedStorageOwner: this.input.expectedStorageOwner as Hex,
      supportedAdapters: this.input.supportedAdapters ?? SUPPORTED_CHECKPOINT_ADAPTERS,
    });
  }
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && isHex(value, { strict: true }) && value.length === 66;
}

function isAddress(value: string): boolean {
  return /^0x[\da-f]{40}$/i.test(value);
}

function normalizeHead(value: string | null): string | null {
  return value?.toLowerCase() ?? null;
}
