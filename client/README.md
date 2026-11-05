# Client

The client is a React + TypeScript app built with Vite. It contains the buyer-facing BATON console: job review, checkpoint status, handoff approvals, and receipts. Application operations go through the server API. The browser must not hold payment authority, decryption keys, or provider credentials.

Set only public `VITE_*` configuration here. Wallet interactions use the connected browser wallet; never put a wallet private key in Vite configuration.
