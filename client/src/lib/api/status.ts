const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4000";

export type RuntimeStatus = {
  api: "ready";
  contentStore: "arkiv";
  configuration: {
    arkiv: boolean;
    sepolia: boolean;
    ens: boolean;
    hederaX402: boolean;
  };
  paymentLedger: { backend: "sqlite"; implementation: "pending" };
};

export async function getRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
  const response = await fetch(API_URL + "/api/status", { signal });
  if (!response.ok) throw new Error("API returned " + response.status);
  return response.json() as Promise<RuntimeStatus>;
}
