# BATON frontend audit and visual system

## Product brief

BATON is a buyer-facing protocol and console for resumable, verifiable agent work. It addresses the failure of long-running jobs when a worker stops: a buyer accepts an exact checkpoint, a successor recovers that encrypted state, and authority changes only after the successor acknowledges it. BATON does not transfer hidden model reasoning or private credentials. The buyer remains responsible for milestone acceptance and worker grants.

The primary audience is developers and teams orchestrating long-running agent jobs, plus technical buyers evaluating recovery, identity, and payment boundaries. Within five seconds, a first-time visitor should understand that BATON lets a replacement worker continue from a buyer-accepted checkpoint. The primary action is **Open live console**; the separate browser-only simulation is available at `/demo`.

Claims shown in the interface must preserve the repository's current status: the console is a simulation; a historical Sepolia lifecycle and ENS grant checks are live-verified; live Arkiv write/readback, x402 settlement, and separate-host recovery remain in progress.

## Route and component inventory

| Route | Main components | User-facing purpose and behavior |
| --- | --- | --- |
| `/` | `Landing`, `CreationHero`, inline lifecycle / ENS / Arkiv diagrams, integration-status strip, guarantees, `SiteFooter` | Explain the problem, accepted-checkpoint protocol, ENS identity, Arkiv recovery, separate reward and service ledgers, current integration status, and security boundaries. Primary CTA opens the live console; section links provide in-page navigation. |
| `/console` | `LiveConsole`, shared API client, wallet signing helpers | Read health, protocol, runtime status, jobs, job details, credits, operation history, and service quotes from the configured API. Import funded chain snapshots, authorize supported buyer actions with EIP-712 wallet signatures, and submit worker-signed checkpoint/recovery bundles. Mutations are gated by API-reported configuration. |
| `/demo` | `BrowserDemo`, `BatonSim`, `SetupPanel`, `JobPanel`, `ServicePulse`, `EnsTree`, `Inspector`, `EntityPanel`, `Terminal` | Run the clearly labeled local browser simulation. Configure a job ENS name, primary worker, standby order, and expected milestone time; start, pause, resume, reset, or change speed; kill or revoke a worker; add standbys and subagents; inspect the ENS tree and resolver records; review simulated credits, Arkiv TTLs, notices, and logs. No chain, Arkiv, or x402 call is made by this simulation. |
| `/how-it-works` | Interactive architecture map, three scroll-highlighted workflow steps, expandable transaction details, boundary list | Explain staging, buyer acceptance, recovery, and authority transfer. Step selection updates the map and detail panel; code snippets expand in place. |
| `/faq` | Category filters and accessible accordion | Answer product, ENS, Arkiv, payment, and status questions. |
| Unknown route | `NotFound` | Return visitors to the home page. |

Shared components are `SiteNav` (route links, persisted light/dark preference, mobile menu, sticky scroll treatment), `Baton` / `BatonMark` (brand marks), and `SiteFooter` (product and stack navigation). `framer-motion` is already installed and is used for reveals, accordion transitions, map updates, notices, and tree changes.

## Existing strengths and weaknesses

The current product copy and flow diagrams contain unusually precise boundaries; retain those facts and the console's simulation controls. The FAQ already distinguishes live evidence from incomplete integrations. The route structure, skip link, reduced-motion handling, keyboard-selectable ENS nodes, and mobile menu are worth keeping.

The landing hero takes roughly 4.6 viewport heights before reaching its CTA and explanation, so it delays product clarity and makes scroll the main interaction. Its Renaissance-hands image is expressive but generic to the protocol itself. The ivory / navy / walnut / tan palette and distinct marketing/editorial/application font stacks feel disconnected from the requested premium Web3 direction. Several repeated rounded cards and soft shadows also reduce the distinction between the marketing story and the real console. The first product-focused interaction is currently behind the long landing-page sequence.

The following art direction was implemented and refined after the initial audit.

## Art direction

- **Identity:** Near-black and graphite surfaces with a focused violet accent, restrained status colors, and fine technical keylines. Keep the interface calm and legible; avoid decorative crypto clichés and rely on BATON's actual handoff model.
- **Typography:** Space Grotesk for headlines and interface hierarchy, Inter for reading, and IBM Plex Mono for protocol labels and identifiers. Use the existing loaded-font approach with sensible system fallbacks.
- **Layout:** Shared 1,320px container, measured copy widths, responsive grids, and consistent vertical rhythm. Make the hero a direct two-column statement plus a product-specific handoff schematic; preserve quick anchors to the existing explanatory sections.
- **Component language:** Use sharp-to-moderate corners, restrained borders, and a bright primary action. Let the console retain a denser operational layout while sharing the same surface, type, focus, and status tokens.
- **Motion:** Keep motion on reveals, the protocol signal path, state changes, and controls. Avoid scroll locking and long delays. Honor `prefers-reduced-motion` throughout.

## Semantic design tokens

The implementation centralizes background, surface, text, accent, border, focus, status, typography, spacing, radius, and shadow roles in `src/styles/tokens.css`. Dark graphite is the default; the existing persisted theme control offers the corresponding light variant.
