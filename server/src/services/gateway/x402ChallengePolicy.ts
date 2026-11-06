import type { PaymentPolicy } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";

export type HederaChallengePolicyConfig = {
  network: "hedera:testnet" | "hedera:mainnet";
  asset: string;
  payTo: string;
  maxAmountAtomic: bigint;
  maxTimeoutSeconds: number;
  feePayer: string;
};

/**
 * Create an x402 v2 policy that keeps only approved Hedera exact-payment offers.
 * This is a pure filter: it does not create a payment payload, sign, or submit.
 */
export function createHederaChallengePolicy(config: HederaChallengePolicyConfig): PaymentPolicy {
  if (!config.asset || !config.payTo || !config.feePayer) {
    throw new Error("HEDERA_X402_POLICY_IDENTITIES_REQUIRED");
  }
  if (config.maxAmountAtomic <= 0n) throw new Error("HEDERA_X402_POLICY_AMOUNT_CAP_INVALID");
  if (!Number.isSafeInteger(config.maxTimeoutSeconds) || config.maxTimeoutSeconds < 0) {
    throw new Error("HEDERA_X402_POLICY_TIMEOUT_INVALID");
  }

  return (x402Version, paymentRequirements) => {
    if (x402Version !== 2) return [];
    return paymentRequirements.filter((requirement) => isApprovedRequirement(requirement, config));
  };
}

function isApprovedRequirement(
  requirement: PaymentRequirements,
  config: HederaChallengePolicyConfig,
): boolean {
  if (!requirement || typeof requirement !== "object") return false;
  if (requirement.scheme !== "exact") return false;
  if (requirement.network !== config.network) return false;
  if (requirement.asset !== config.asset || requirement.payTo !== config.payTo) return false;
  if (!Number.isSafeInteger(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds < 0) return false;
  if (requirement.maxTimeoutSeconds > config.maxTimeoutSeconds) return false;

  if (typeof requirement.amount !== "string" || !/^\d+$/.test(requirement.amount)) return false;
  const amount = BigInt(requirement.amount);
  if (amount <= 0n || amount > config.maxAmountAtomic) return false;

  const extra = requirement.extra;
  if (!extra || typeof extra !== "object" || Array.isArray(extra) || !Object.hasOwn(extra, "feePayer")) return false;
  return extra.feePayer === config.feePayer;
}
