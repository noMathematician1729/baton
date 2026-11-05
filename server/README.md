# Server

The server is a Node.js + TypeScript API and owns domain rules, worker orchestration, admission and access services, the Hedera x402 gateway, durable operation ledger, verification, and Sepolia/ENS contract sources. Arkiv, ENS, Hedera x402, and storage integrations belong behind service or package adapters.

Worker execution can be deployed on separate operator hosts. The shared worker/runtime code belongs here, but each worker establishes its own authorized tool connections; credentials are not copied between workers.

The root `.env.example` lists local configuration. The API starts without external credentials so the client and health endpoint can run before integrations are configured. Never commit `.env` or place server secrets in `VITE_*` variables.

Checkpoint manifests, large artifact chunks, and paid outputs use Arkiv as the planned content store. The payment ledger's persistence backend is deferred between Arkiv and PostgreSQL. The installed `pg` driver is provisional and does not initialize a connection or select a backend.
