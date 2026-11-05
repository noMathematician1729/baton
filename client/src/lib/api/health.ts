const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4000";

export type ApiHealth = {
  status: "ok";
  service: "baton-api";
  timestamp: string;
};

export async function getApiHealth(signal?: AbortSignal): Promise<ApiHealth> {
  const response = await fetch(`${API_URL}/api/health`, { signal });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json() as Promise<ApiHealth>;
}
