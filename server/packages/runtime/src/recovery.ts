import type { CheckpointManifest } from "../../checkpoint/src/schema.js";
import { BetaBernoulliStateSchema, type BetaBernoulliState } from "./betaBernoulli.js";
import { importBatchState, type DeterministicBatchState } from "./batch.js";

export type ImportedCheckpointRuntimeState = {
  adapterId: string;
  runtimeState: DeterministicBatchState | BetaBernoulliState;
  quantitativeState?: BetaBernoulliState;
};

/** Import only runtime adapters whose schemas and deterministic invariants are implemented here. */
export function importCheckpointRuntimeState(
  manifest: CheckpointManifest,
  expectedJobId: string,
  expectedTaskId: string,
): ImportedCheckpointRuntimeState {
  const quantitativeState = manifest.quantitativeState === undefined
    ? undefined
    : parseQuantitativeState(manifest.quantitativeState);

  if (manifest.adapter.id === "baton.deterministic-batch") {
    if (manifest.adapter.version !== "1.0.0" || manifest.adapter.stateSchemaVersion !== "1") {
      throw new Error("CHECKPOINT_ADAPTER_UNSUPPORTED");
    }
    if (manifest.runtimeState === undefined) throw new Error("CHECKPOINT_RUNTIME_STATE_MISSING");
    const runtimeState = importBatchState(manifest.runtimeState, expectedJobId, expectedTaskId);
    if (runtimeState.adapterVersion !== manifest.adapter.version
      || runtimeState.stateSchemaVersion !== manifest.adapter.stateSchemaVersion) {
      throw new Error("CHECKPOINT_RUNTIME_ADAPTER_MISMATCH");
    }
    return { adapterId: manifest.adapter.id, runtimeState, quantitativeState };
  }

  if (manifest.adapter.id === "baton.beta-bernoulli") {
    if (manifest.adapter.version !== "1.0.0" || manifest.adapter.stateSchemaVersion !== "1") {
      throw new Error("CHECKPOINT_ADAPTER_UNSUPPORTED");
    }
    const state = manifest.runtimeState ?? manifest.quantitativeState;
    if (state === undefined) throw new Error("CHECKPOINT_RUNTIME_STATE_MISSING");
    const runtimeState = parseQuantitativeState(state);
    return {
      adapterId: manifest.adapter.id,
      runtimeState,
      quantitativeState: manifest.quantitativeState === undefined ? undefined : quantitativeState,
    };
  }

  throw new Error("CHECKPOINT_ADAPTER_UNSUPPORTED");
}

function parseQuantitativeState(value: unknown): BetaBernoulliState {
  const state = BetaBernoulliStateSchema.parse(value);
  if (new Set(state.processedObservationIds).size !== state.processedObservationIds.length
    || state.successCount + state.failureCount !== state.processedObservationIds.length) {
    throw new Error("CHECKPOINT_QUANTITATIVE_STATE_INCONSISTENT");
  }
  return state;
}
