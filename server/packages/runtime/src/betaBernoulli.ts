import { z } from "zod";

export const BetaBernoulliStateSchema = z.object({
  adapterId: z.literal("baton.beta-bernoulli"),
  adapterVersion: z.literal("1.0.0"),
  stateSchemaVersion: z.literal("1"),
  alpha: z.number().positive(),
  beta: z.number().positive(),
  processedObservationIds: z.array(z.string().min(1)),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
});

export type BetaBernoulliState = z.infer<typeof BetaBernoulliStateSchema>;

export function createBetaBernoulliState(alpha = 1, beta = 1): BetaBernoulliState {
  return BetaBernoulliStateSchema.parse({
    adapterId: "baton.beta-bernoulli",
    adapterVersion: "1.0.0",
    stateSchemaVersion: "1",
    alpha,
    beta,
    processedObservationIds: [],
    successCount: 0,
    failureCount: 0,
  });
}

export function addObservation(input: BetaBernoulliState, observationId: string, success: boolean): BetaBernoulliState {
  const state = BetaBernoulliStateSchema.parse(input);
  if (state.processedObservationIds.includes(observationId)) throw new Error("Observation was already processed");
  return BetaBernoulliStateSchema.parse({
    ...state,
    alpha: state.alpha + Number(success),
    beta: state.beta + Number(!success),
    processedObservationIds: [...state.processedObservationIds, observationId],
    successCount: state.successCount + Number(success),
    failureCount: state.failureCount + Number(!success),
  });
}

export function posteriorMean(input: BetaBernoulliState): number {
  const state = BetaBernoulliStateSchema.parse(input);
  return state.alpha / (state.alpha + state.beta);
}
