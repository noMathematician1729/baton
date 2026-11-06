# Handover: landing hero imagery + scroll animation

For: Codex (or any agent picking this up)
Scope: **frontend only**: `client/` in this monorepo. Another session owns `server/`, contracts, protocol, scripts and the root docs (`handover.md`, `context.md`, `plan.md`, `README.md`). Do not edit anything outside `client/`.

## 1. What BATON is (one paragraph)

BATON lets a buyer fund a resumable job for AI agents. If the working agent dies, a standby agent recovers the last *accepted* checkpoint from Arkiv (encrypted, expiring storage) and takes over. Worker authority is a revocable ENS subname (`agent-a.baton.eth`), and rewards sit in a Sepolia escrow. Each agent posts an Arkiv "claim" with a deadline. If the claim lapses, the job fails over. Full product context: `../context.md` (read-only for you).

## 2. The hero concept

The landing page reinterprets Michelangelo's *Creation of Adam*. As the user scrolls:

1. Two hands reach in from the left and right edges.
2. They converge, leaving the famous gap between the fingertips.
3. A wooden relay **baton** appears in the gap with a warm glow ("the handoff").
4. The fresco fades, and the baton flies to a vertical **section rail** on the left edge, where it tracks reading progress through the feature sections below.

The user's direction: one hand from the left, one from the right, they meet, and the baton gets passed. It must look premium, not clip-art. The current version works but is a first pass; you're here to raise its quality.

## 3. Current implementation

| File | Role |
|---|---|
| `src/pages/landing/CreationHero.tsx` | Hero markup and the scroll engine (a rAF loop on `scroll` and `resize`, writing styles directly to refs) |
| `src/components/Baton.tsx` | SVG baton (wood gradient, three navy bands) and the brand mark |
| `src/pages/Landing.tsx` | Defines the rail sections (`problem` … `status`) and renders `<CreationHero sections={…} />`, then the content sections |
| `src/styles.css` | Hero styles under `/* Creation hero */`, plus the rail and `.flying-baton` |
| `src/styles/tokens.css` | Palette tokens for light and dark (`--bg`, `--navy`, `--walnut`, `--tan`, `--ochre`, …) |
| `public/fresco/hands-cutout.webp` | Transparent hand artwork used by the animated hero, 1774×887 |
| `public/fresco/hands.jpg` | Original fresco crop retained as the source reference |

### How the split works

- One transparent image is rendered **twice** (`.fresco-left`, `.fresco-right`) and clipped at exactly 50% of the frame: left hand before the center divide, right hand after it.
- Each half is translated ±30% of the frame width, easing to 0 as you scroll. The center cut aligns to the narrow fingertip gap, so both hands meet in the middle without feathering across either finger.
- The outer frame has an intersecting horizontal and vertical mask vignette, so the edges dissolve into `--bg`.
- The current transparent cutout is 1774×887; its fingertip divide is centered at **x = 0.5**. `GAP_X` and `GAP_Y` position the baton at that meeting point. If you replace the image, re-measure the finger divide and update the clip and gap coordinates together.

### Scroll timeline

`p` is hero progress from 0 to 1. The hero is `460vh` tall with a sticky `100vh` stage.

| p range | What happens |
|---|---|
| 0 → 0.16 | Intro headline fades and lifts |
| 0.02 → 0.56 | Halves converge (`easeOut`), and the frame scales 1.06 → 1 |
| 0.16–0.36 / 0.36–0.54 / 0.58–0.76 | Three captions crossfade |
| 0.50 → 0.60 | Glow at the gap fades in; it fades out over 0.72 → 0.84 |
| 0.55 → 0.64 | Baton scales in at the gap |
| 0.72 → 0.93 | Baton flies to the rail (x = 44px, y set by page progress), rotates −8° → 90° and scales to 0.52. Below 1100px wide it fades upward instead. |
| 0.72 → 0.86 | Fresco fades to 10% |
| 0.85 → 0.97 | Outro statement and CTAs fade in |
| > 1 | Baton rides the rail; the active tick follows page progress |

## 4. What to improve

### A. Imagery

Option 1 is preferred; option 2 is the fallback.

1. **Better use of the real fresco.** It is public domain and iconic, and generated copies tend to get hands wrong.
   - Cut each arm out with background removal or segmentation, and export `adam-arm.png` and `god-arm.png` with alpha.
   - Rebuild the plaster sky as its own background layer: inpaint where the arms were, or tile a clean plaster texture from the fresco.
   - This enables real depth: the arms move over a background moving at a different speed (parallax). Today both halves carry their own sky.
   - Source: Wikimedia Commons, `Michelangelo_-_Creation_of_Adam_(cropped).jpg`. The full resolution is 3524×1599; the current crop offset is x=458, y=288, w=1832, h=863. Download it again if you need more pixels around the arms.
2. **Generated assets, only if they clearly beat the original.**
   - Produce two separate images, a left arm and a right arm, reaching horizontally on transparent backgrounds, in Renaissance fresco style with warm ochre skin and soft plaster light. They must match each other in lighting and scale.
   - Prompt sketch: *"Renaissance fresco, Michelangelo style, a single muscular forearm and hand reaching horizontally from the left edge, index finger extended, soft diffuse light, warm ochre and umber palette, aged plaster texture, isolated on transparent background, high detail, 4k"*. Mirror it for the right arm, an older hand with a pink sleeve fold.
   - Reject anything with extra or merged fingers, plastic skin or mismatched lighting. Check the fingertips at 200% zoom.
   - Optional third asset: a painted baton in the same fresco style, to replace or sit alongside the SVG baton.
3. Whatever you ship:
   - Provide WebP or AVIF plus a JPEG fallback.
   - Keep the total hero weight under about 900 KB.
   - Use `srcset` for 1x and 2x.
   - Keep artwork attribution out of the product footer; the public UI should not include an artwork credit line.

### B. Scroll animation

- **Smooth scroll:** consider `lenis` for buttery inertia, or GSAP `ScrollTrigger` with `scrub` if you rewrite the timeline. You may add dependencies to `client/package.json` only. framer-motion is already installed.
- **Depth:** with separated arm layers, give the arms slightly different speeds and a gentle rotation; Adam's arm lifts a few degrees as it nears. Let the background drift slowly.
- **The moment of contact:** it should feel like an event. Ideas:
  - a light bloom or volumetric glow;
  - fine gold dust particles drawn on canvas, under 1 ms per frame;
  - a subtle shockwave ring;
  - the captions reacting.
  - Keep it tasteful. The palette is parchment, navy, walnut and ochre, not neon.
- **The baton:** it currently pops in and flies along a straight lerp. Improve it with:
  - a curved flight path (bezier or arc);
  - slight overshoot and settle on the rail;
  - a motion-blur or trail feel;
  - the baton appearing to pass from Adam's hand to God's hand, or being "handed" rather than spawned.
- **Rail:** labels could reveal on hover with a tooltip card. Clicking a tick already smooth-scrolls to its section.
- **Mobile (< 820px):** the hero must still read well. Consider a vertical composition: hands from top and bottom, or a tighter crop. There is no rail; the baton can dock in the nav logo.
- **Performance:**
  - Animate only `transform`, `opacity` and `filter`.
  - Keep the rAF-on-scroll pattern, or ScrollTrigger.
  - No layout reads inside hot loops apart from the one `getBoundingClientRect` per frame that exists today.
  - Target 60fps on a 2020 MacBook Air.
- **Accessibility:**
  - The scroll-linked motion runs even with `prefers-reduced-motion` on. That was deliberate, because the motion is user-driven.
  - Disable autonomous loops such as particles and bobbing under reduced motion.
  - Keep the `role="img"` and `aria-label` on the fresco.

### C. Don't break

- The sticky stage, plus `#problem` … `#status` section ids, which the rail relies on.
- Light and dark themes: the theme is `data-theme` on `<html>`, toggled in `SiteNav`, with tokens in `tokens.css`.
- The console page (`/console`, under `src/features/console/*`) is unrelated to this task. Leave it alone.

## 5. Running and verifying

```sh
npm install            # from repo root (workspaces)
npm run dev:client     # http://127.0.0.1:5173
cd client && npx tsc --noEmit
```

Don't run `npm run build` unless asked: it overwrites `client/dist`, which may be tracked.

Quirks seen in the Claude desktop browser pane, which a normal browser may not have:
- It reported `prefers-reduced-motion: reduce`.
- Coordinate clicks were mis-mapped under viewport emulation.
- Background tabs pause rAF, so framer-motion elements can sit at opacity 0 until the tab is focused.

Test in real Chrome and Safari.

**Acceptance checklist**
- [ ] At p=0, each side shows only its own hand; no fingertip ghosts across the split.
- [ ] No visible seam when the halves meet, in light or dark mode.
- [ ] The baton sits between the fingertips at the contact moment.
- [ ] The baton docks on the rail and tracks sections. The active tick is correct when clicking ticks.
- [ ] Smooth at 60fps; Lighthouse performance ≥ 85 on desktop for `/`.
- [ ] Mobile 375px works with no horizontal scroll.
- [ ] Hero assets ≤ ~900 KB total; no artwork credit line appears in the product UI.
- [ ] `npx tsc --noEmit` passes; no files outside `client/` changed.
