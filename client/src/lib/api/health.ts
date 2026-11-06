import { api } from "./client";

export type ApiHealth = Awaited<ReturnType<typeof api.health>>;
export const getApiHealth = api.health;
