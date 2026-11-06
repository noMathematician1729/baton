# Two-worker Gemma demo

BATON can run each worker through Google ADK with the local Ollama model `gemma4:e4b`. Worker A and Worker B are separate ADK agent processes using the same model. This path uses ADK's native Python function tools; it does not require an MCP server.

## Prepare the local model

From the repository root:

```sh
ollama pull gemma4:e4b
python3 -m venv server/apps/worker-adk/.venv
server/apps/worker-adk/.venv/bin/python -m pip install -r server/apps/worker-adk/requirements.txt
```

Ollama must be running at `http://127.0.0.1:11434` on the machine running both workers. Set the following in both `.env.worker-a` and `.env.worker-b` (replace the API URL if the deployment changes):

```dotenv
BATON_WORKER_RUNTIME=adk
BATON_ADK_MODEL=ollama_chat/gemma4:e4b
BATON_ADK_PYTHON=server/apps/worker-adk/.venv/bin/python
OLLAMA_API_BASE=http://127.0.0.1:11434
BATON_API_URL=https://baton-api-ghws.onrender.com
```

Keep the existing worker wallet, Arkiv, and key-service settings in each worker's own ignored env file. Do not copy those credentials into the ADK Python environment.

## Run the demo

The deployed BATON API runs on Render, while Gemma and Ollama run on the worker host. Start each worker from the repository root in its own terminal:

```sh
BATON_WORKER_ID=a node --env-file=.env.worker-a --import tsx server/apps/worker/src/codexWorker.ts
BATON_WORKER_ID=b node --env-file=.env.worker-b --import tsx server/apps/worker/src/codexWorker.ts
```

Each worker registers with the API using its wallet signature, then performs a Gemma inference and tool-use smoke check before it becomes available. The Core console marks these as external runtimes; start and stop them from their host terminals. The API's Connect/Stop controls are reserved for local workers and are disabled by default in production. Both are separate ADK agents using the same local Gemma model.

The Render API must have `BATON_CORE_ENABLED=true` and its buyer-side configuration set before it exposes the worker registry. For the Vercel console, set the build-time `VITE_API_URL` to the same API URL and set Render's `CLIENT_ORIGIN` to the Vercel site's exact origin. The Render deployment currently has no persistent disk in its service configuration, so treat it as a model/tool connectivity demo until core state has durable storage configured.

This guide assumes the deployed V2 escrow and its buyer, Arkiv, and key-service environment are configured. The Render API currently has no persistent disk, so its Core state may be lost on a service restart; for the demo, verify the current job and worker state before starting a live run.

The worker runtime variable defaults to `codex`; only workers explicitly set to `adk` use Gemma. Existing deterministic `npm run demo:local` remains an offline fixture and does not make model calls.

## Tool boundary

ADK exposes functions for fetching the current task, listing/reading/writing UTF-8 files inside the active worker workspace, and submitting a milestone. The TypeScript worker validates workspace-relative paths and performs checkpoint encryption, signing, API calls, and key access. The Python child receives only the private worker socket and model settings; it does not receive wallet or Arkiv secrets. No shell or arbitrary code execution tool is exposed to Gemma. This demo limits model-visible tools but does not provide Codex's OS-level sandbox, so use the ADK runtime for the local demo rather than untrusted production workloads.
