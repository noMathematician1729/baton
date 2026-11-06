import { api, type RuntimeStatus } from "./client";

export { API_URL } from "./client";
export type { RuntimeStatus };
export const getRuntimeStatus = api.status;
