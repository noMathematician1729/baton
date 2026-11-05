# Server

The server is a Node.js + TypeScript API and owns domain rules, worker orchestration, admission and access services, the Hedera x402 gateway, durable operation ledger, verification, and Sepolia/ENS contract sources. Arkiv, ENS, Hedera x402, and storage integrations belong behind service or package adapters.

Worker execution can be deployed on separate operator hosts. The shared worker/runtime code belongs here, but each worker establishes its own authorized tool connections; credentials are not copied between workers.

The root `.env.example` lists local configuration. The API starts without external credentials so the client and health endpoint can run before integrations are configured. Never commit `.env` or place server secrets in `VITE_*` variables.

Checkpoint manifests, large artifact chunks, and paid outputs use Arkiv as the content store. The buyer-host service-payment operation ledger uses SQLite at `PAYMENT_LEDGER_PATH`; its implementation and transaction/recovery tests are pending. Store operation metadata in SQLite and encrypted paid output payloads in Arkiv.
