# Asset license

The `LICENSE` file (AGPL-3.0) covers the **source code** in this repository.
It does not cover the game's media. Those are licensed separately, on the terms
below.

## What this covers

Everything under `public/assets/` — 3D models (`.glb`), textures, sprites and
icons, UI art, voice lines, and music — plus the generated model data in
`src/proceduralFreud/`.

## The license

**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**

- Deed: https://creativecommons.org/licenses/by-nc/4.0/
- Legal code: https://creativecommons.org/licenses/by-nc/4.0/legalcode

In short: you may copy, modify, and redistribute these assets, including in your
own derivative game, provided you credit **Frank Ye / Psyrena** and link back to
this repository, and provided the use is **not commercial**. Selling the assets,
shipping them inside a paid or ad-supported product, or otherwise using them
primarily for commercial advantage requires separate written permission.

Note the asymmetry, because it matters: the code is AGPL-3.0 and may be used
commercially under that license's terms. The art, audio and models may not.

## Third-party material and generation-tool terms

Several assets were produced with commercial generation tools, under paid plans
held by the author. The output license runs from the author's plan, not from
yours — regenerating equivalent assets yourself means agreeing to those tools'
terms directly.

| Source | Used for | Terms |
|---|---|---|
| [Suno](https://suno.com/) (Pro plan) | Village and boss OST under `public/assets/*/ost/` | Generated under a paid Suno Pro subscription; redistributed here under CC BY-NC 4.0 |
| Seedance / MiniMax H3 (paid) | Trailer video (not in this repo) | Generated under a paid plan |
| [Tripo](https://www.tripo3d.ai/) | Source meshes for characters, props, pets | Per Tripo's output terms |
| [Mixamo](https://www.mixamo.com/) (Adobe) | Character rigs and animation clips baked into the hero `.glb` files | Used per Adobe's Mixamo terms: the animation data ships **only** as part of these derived, rigged characters, never as standalone redistributable Mixamo clips |
| [Civitai](https://civitai.com/) orchestration, gpt-image-2, Grok Imagine | Concept art and texture plates | Concept sheets are not in this repo; the derived, shipped textures are |
| [PSFX — Peri's Sound Effects](https://github.com/JimHPerry/psfx) by Peri Eskell | Sound effects | **Not redistributed.** PSFX is non-commercial-licensed and stays out of this repo entirely. `public/assets/sfx/` is gitignored; run `node tools/sync-sfx.mjs` against your own local PSFX clone |

### Likeness

Freud, Pavlov and Skinner are depicted as stylized game characters. The
photographic references used during production are not included in this
repository. Freud (1926, Halberstadt) and Pavlov references are public domain;
any reference material with attribution requirements was kept private rather
than redistributed.

## Asking for other terms

Commercial licensing of the assets, or a school or research use that does not
fit CC BY-NC, is available on request. Open an issue or contact the author.
