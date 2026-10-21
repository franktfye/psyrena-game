# Psyrena — working notes for Claude

## Mobile-first performance rules (apply to every change)

Psyrena is a browser game being optimized for phones. Native Android/iOS apps
are out of scope: a WebView wrapper renders no faster, and a native rewrite
would discard the Babylon codebase. A Capacitor store wrapper may come last,
once the web build runs well on phones. The phased plan lives with the
design docs, which are not in this repo (see "What is not in this repo" in
README.md); these rules are the part every contributor needs.

Rules 1–2 are enforced: `npm run build` ends with
`tools/verify-mobile-budget.mjs` and fails on a violation. Rule 5 is enforced
for heroes: `tools/verify-hero-assets.mjs` runs before `vite build`.

1. **No Babylon barrel imports.** Deep-import (`@babylonjs/core/Events/pointerEvents`),
   never `@babylonjs/core`. The package index side-effect-imports all of
   Babylon. One such line was 4 MB of the boot chunk. `import type` is exempt.
2. **The boot JS budget is a ratchet.** Limits are in
   `tools/verify-mobile-budget.mjs`. When a change shrinks the boot, lower them
   in the same commit. Never raise them to make a build pass. Move code behind
   `import()` instead.
3. **Lazy-load new scenes and big features.** Anything the village doesn't need
   on first frame is reached through `import()`, not a static import from
   `src/main.ts`.
4. **Gate GPU luxuries.** New glow layers, post-processing, shadow generators,
   MSAA targets and heavy particle systems go through `src/core/quality.ts`
   (`sceneGlowOptions`, `vfxGlowOptions`, `applyPipelineQuality`, or
   `qualityTier()` for anything new). The low tier must work without them.
   Test with `?quality=low|medium|high`.
5. **Ship assets mobile-ready.** KTX2 textures (`npm run assets:ktx2`), meshopt
   GLBs (`npm run assets:meshopt`), Opus-in-WebM audio, and sizes per
   `TEXTURE_RULES` in `src/core/budget.ts`. New heroes come from the default
   pipeline in `tools/motion-video/README.md` (25-bone Mixamo rig) and ship
   with `npm run ship:hero -- <id> --install`.
6. **Compress at build time.** `vite build` writes `.br`/`.gz` siblings
   (`tools/precompress.mjs`). `server/index.mjs` only picks one. Don't add
   per-request CPU work to the static server.
7. **Touch is first-class.** Every interaction needs a touch path and must fit
   an 844×390 landscape phone viewport.
8. **Verify on the phone path.** Before merging rendering or loading changes, run
   `tools/mobile-scenes-e2e.mjs --mobile` against a production build (setup is
   in its header). The desktop dev server takes WebGPU and skips every mobile
   gate. For rendering changes, also check a real iPhone in Safari.
