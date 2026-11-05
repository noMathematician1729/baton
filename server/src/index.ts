import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();
const server = app.listen(env.SERVER_PORT, env.SERVER_HOST, () => {
  console.info(`BATON API listening on http://${env.SERVER_HOST}:${env.SERVER_PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
