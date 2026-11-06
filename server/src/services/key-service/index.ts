import { resolve } from "node:path";
import { CheckpointKeyGrantStore } from "./store.js";
import { createCheckpointKeyServiceApp } from "./app.js";

const storageKey = process.env.CHECKPOINT_KEY_SERVICE_STORAGE_KEY ?? "";
const databasePath = resolve(process.env.CHECKPOINT_KEY_SERVICE_DATABASE_PATH ?? ".baton-data/checkpoint-key-service.sqlite");
const host = process.env.CHECKPOINT_KEY_SERVICE_HOST ?? "127.0.0.1";
const port = Number(process.env.CHECKPOINT_KEY_SERVICE_PORT ?? "4411");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("KEY_SERVICE_PORT_INVALID");

const store = new CheckpointKeyGrantStore(databasePath, storageKey);
const app = createCheckpointKeyServiceApp(store);
const server = app.listen(port, host, () => {
  console.info(`BATON checkpoint key service listening on ${host}:${port}; routes are /healthz and /v1/resolve`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
