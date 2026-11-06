---
name: arkiv-best-practices
description: Deprecated compatibility entrypoint. Load the arkiv router for SDK 1.0.x and Rabdi; this stub only redirects to the current catalog.
license: MIT
metadata:
  arkiv-sdk: ">=1.0.0 <2"
  network: "rabdi"
  verified: "2026-10-30"
  deprecated: "true"
  replaced-by: "arkiv"
---

# Deprecated Arkiv entrypoint

Use the [arkiv router](../arkiv/SKILL.md) for SDK 1.0.x on Rabdi and the focused task catalog. Install the current router alongside this compatibility entrypoint. Its [capability boundaries](../arkiv/references/known-issues.md) describe the checked APIs and limitations.

If the router is unavailable locally, read the [current canonical router](https://github.com/Arkiv-Network/skills/blob/main/skills/arkiv/SKILL.md) and verify its metadata against the installed SDK before code generation. A source link does not establish the installed or MCP/plugin-bundled revision.

Sources: [SDK 1.0.1 source](https://unpkg.com/@arkiv-network/sdk@1.0.1/src/), [SDK 1.0.1 README](https://unpkg.com/@arkiv-network/sdk@1.0.1/README.md). Inspect the installed declarations before adapting executable examples.
