# Client

The client is a React + TypeScript app built with Vite. It contains the buyer-facing BATON console: job review, checkpoint status, handoff approvals, and receipts. Application operations go through the server API. The browser must not hold payment authority, decryption keys, or provider credentials.

Set only public `VITE_*` configuration here. Wallet interactions use the connected browser wallet; never put a wallet private key in Vite configuration.

The client reads job, protocol and runtime state from the BATON API. Local development uses `VITE_API_URL=http://127.0.0.1:4000` (provided by the repository `.env.example`). For a deployed client, set `VITE_API_URL` to the public API origin before building the Vite app. Set the API's `CLIENT_ORIGIN` to the deployed client origin so the browser can make cross-origin requests. Both values are public URLs; do not put secrets in `VITE_*` variables.
