# Gesture → video → Mixamo GLB pipeline

**The default pipeline for new heroes.** How a hero gets a NEW motion (a
gesture Frank describes in words) without hand-keying it in Blender, and how
a whole new hero gets its model and clip set. Two machines:

```
 1. T-pose art        concept.mjs + Concept Review       py2   → Frank approves / refines (gate)
 2. Mesh + rig        tripo make → decimate → rig        py2   → Tripo-rigged GLB
 2b. → Mixamo FBX     tripo_to_mixamo.py (Blender)       py2   → <hero>.fbx + textured character.glb
 3. Motion video      tools/motion-video/render.mjs      py2   → clip.mp4 (Soldier figure)
 4. Video → anim      m2mr run --video --rig             gpu-box → mixamo_character.glb
 4b. Clip set         build-moves.mjs → m2mr → finish-clips.mjs    → <hero>.glb, 11 clips
 5. Ship              tools/ship-hero.mjs                py2   → public/assets/heroes/<hero>.glb
```

Heroes from this pipeline use the 25-bone Mixamo rig. The first three heroes
use a 38-bone UE-style rig, built with the legacy `tools/build-*-hero.mjs`
scripts. The game takes both rigs without code changes. The 25-bone rig has a
third fewer bone matrices and animation channels to evaluate per hero per
frame, so it's the default.

Verification log at the bottom. To watch a run: section 6 (viewer).

## 1. T-pose artwork → Frank's approval (Concept Review)

Front + back T-pose plates, arms straight out, palms down, feet shoulder-width,
plain light-grey background, hands empty (props on the belt, not in hand). A
true left profile beats a mirrored right one for asymmetric characters (see
`assets/work/freud/README.md`).

Every concept goes through **Concept Review** (http://localhost:8470/concepts,
hub → Tools), versioned in `assets/work/<hero>/concept/`:

```sh
# v1: front from refs (style/pose plate first, likeness second), back edited from the front
node tools/motion-video/concept.mjs new <hero> \
  --front-prompt-file assets/work/<hero>/prompts/front.txt \
  --back-prompt-file  assets/work/<hero>/prompts/back.txt \
  --ref assets/work/freud/freud_front_tpose.png --ref <likeness.png>
# (or register existing plates: concept.mjs import <hero> --front a.png --back b.png …)
```

Frank then, in the page, either **approves** a version or writes what to change
and **refines** (front / back / both). A refine is a GPT Image 2.5 edit of the
chosen version that keeps everything else: 69 Buzz per image, and a front
change always regenerates the back from the new front (2 images) so the views
agree. Every version, its note and its parent version stay in `review.json`.
The same actions exist on the CLI: `concept.mjs refine|approve|status <hero>`.

**Gate:** nothing goes to Tripo until `concept.mjs gate <hero>` passes. It
exits 1 unless a version is approved, and prints the approved plates
(`approved_front.png` / `approved_back.png`), which are the only inputs stage 2 takes.

## 2. T-pose mesh + rig (Tripo)

```sh
node tools/motion-video/concept.mjs gate <hero> || exit 1                    # approved?
C=assets/work/<hero>/concept
tripo make $C/approved_front.png $C/approved_back.png --name <hero>-tpose --json --yes   # 30 cr
#   judge preview.png before going on
tripo anim check <make_task_id> --json                                       # free
tripo mesh decimate <make_task_id> --face-limit 20000 --name <hero>-lod --json --yes   # 30 cr
tripo anim rig <decimate_task_id> --rig-type biped --spec mixamo --out-format glb \
  --name <hero>-rig --json --yes                                             # 25 cr
```

What Tripo actually does here (tested 2026-10-15):

- `--out-format fbx` **fails**: `error_code 1001 Internal processing error`,
  on the raw mesh AND the 20k decimated one (refunded both times).
- `--out-format glb` **succeeds**, but `--spec mixamo` does not produce Mixamo
  bone names. The skeleton is `tripo::Root`, `tripo::Spine_0…3`,
  `tripo::0_Right_Limb_0…4`, and plain `bone_6`…`bone_39`: 42 joints,
  fingers included, **no foot/toe bones**, and names that do not match their
  role (`tripo::Spine_3` is the LEFT clavicle, `bone_6` the right one,
  `bone_39` the left hip).
- Decimate before rigging anyway: 20k faces is the hero budget (Freud ships at 26k).

### 2b. Tripo GLB → Mixamo FBX (Blender, py2)

```sh
blender -b --factory-startup --python tools/motion-video/tripo_to_mixamo.py -- \
  <rig task out>/model.glb <hero>.fbx --glb character.glb --report report.json
```

m2mr reads only **binary FBX** with **`mixamorig:` core bones** (incl.
`HeadTop_End`, `ToeBase`, `Toe_End`), Y-up, with the rest orientation in
**PreRotation** (its FK is `T · PreRotation · R`, Lcl Rotation ignored at rest).
The converter:

- reads Tripo's skeleton by **structure**, not names (they lie: Tripo's
  "Right" limbs are the character's LEFT, checked against Freud's pipe hand);
- finds facing from where the toes point; normalises to 180 cm, Y-up, +Z front;
- builds a fresh 25-bone Mixamo armature at Tripo's joint positions, every bone
  with identity rest orientation **except Hand**: m2mr aims a Hand bone by its
  own local +Y (`_hand_rotation`, `HAND_LOCAL_AXIS`), so Hand's +Y must run
  wrist → fingertips (measured from the hand mesh). With +Y up, every wrist came
  out bent 90° (palms turned in, hands held out like a tray). Synthesises the
  tips Tripo lacks from the mesh;
- merges skin weights (fingers → Hand) and exports binary FBX **without** axis
  conversion (with it, Blender parks the rotation on the root bone and the mesh
  node, and the figure lies on its back in m2mr);
- runs `fbx_prerotation.py`, a pure-Python binary FBX rewriter, which folds any
  rest Lcl Rotation into PreRotation and declares Y-up in GlobalSettings
  (byte-identical round trip when nothing changes);
- `--glb` writes a **textured** twin with the same bones and rest frames. m2mr's
  own GLB has no UVs/textures, so the clip is merged onto this one.

Needs Blender with numpy. py2: `blender` 4.3.2 + `python3-numpy` (installed).
spark has Blender 4.0.2 but **no `python3-numpy`**, so its glTF importer fails;
`sudo apt install python3-numpy` there if conversion should run on spark too.

## 3. Motion video

```sh
node tools/motion-video/render.mjs gesture.json clip.mp4 --sheet sheet.png
```

**The figure must look like a real human.** m2mr's preflight and GVHMR's
tracker use YOLOv8x person detection (gate: 0.5). Measured on our renders:

| Figure | YOLOv8x "person" |
|---|---|
| X Bot mannequin (pink) | 0.10–0.25 ❌ ("no person was detected") |
| X Bot painted with clothes/skin/hair | 0.00–0.25 ❌ |
| Michelle (stylised cartoon woman) | 0.00–0.06 ❌ |
| **Soldier** (realistic armoured man) | **0.83–0.92** ✅ |
| Tripo Freud render (reference) | 0.97 |

So `"model": "soldier"` is the default. All three are three.js r169 samples
with Mixamo skeletons, cached under `~/.cache/psyrena/` (downloaded on first
run, not committed).

Rendering is frame-stepped in headless Chromium (SwiftShader), not
screen-recorded, so the video is smooth however slow the Pi is: about 7
frames/s, so a 5 s clip takes about 22 s.

Writing a gesture from Frank's instructions:

- `"base": "idle"` keeps the body alive (breathing, weight shift). Key only
  the joints the gesture moves.
- A key is `[t, [x,y,z], w]`: degrees **from the T-pose**, about the
  **character's axes** (+X = the figure's left, +Y up, +Z forward), converted
  per bone. One spec therefore drives any Mixamo figure; the same keys give the
  same motion on Soldier and X Bot (checked). `w` blends against the base
  clip: start and end keys at `w: 0` so the gesture eases in and out.
- Joint limits in `droid.html` clamp anything anatomically wrong, and the
  render prints every clamp. **Zero clamps is the target.**
- Always review `--sheet` (8 frames) before sending the clip on.

| Joint | x | y | z |
|---|---|---|---|
| `RightArm` (shoulder) | twist along the arm | + forward / − back | + lower / − raise |
| `LeftArm` | twist | − forward / + back | − lower / + raise |
| `RightForeArm` (elbow) | — | **+ flex** (the hinge) | — |
| `LeftForeArm` | — | **− flex** | — |
| `Left/RightUpLeg` (hip) | − lift forward | | |
| `Left/RightLeg` (knee) | **+ flex** (the hinge) | | |

Worked example: `examples/wave.json` (right-hand wave on the idle). The recipe:
shoulder z = 25, twist x ≈ −80 so the elbow hinge points up, elbow y = 100,
then sway the twist ±18 every 0.25 s.

Video conventions for pose estimation: one person, head to toe in frame the
whole time, fixed camera, front three-quarter (azimuth 15–20°), flat light,
plain background, 30 fps, H.264.

## 4. Video → animation on gpu-box (Motion2MixamoRig)

Installed at `~/Motion2MixamoRig` (venv `.venv`, SMPL-X and `Y_Bot.fbx` in
`assets/`, weights present). spark has an NVIDIA GB10, so use `--device cuda`:
a 5 s clip runs in **about 40 s**. py2's SSH key is authorised as `frank`.

```sh
scp clip.mp4 gpu-box:Motion2MixamoRig/assets/video/
scp <hero>.fbx gpu-box:Motion2MixamoRig/assets/mixamo/
ssh gpu-box 'cd ~/Motion2MixamoRig && .venv/bin/m2mr run \
  --video assets/video/clip.mp4 --rig assets/mixamo/<hero>.fbx \
  --device cuda --output-dir outputs/<hero>_<gesture>'
scp -r gpu-box:Motion2MixamoRig/outputs/<hero>_<gesture> .
```

Outputs: `mixamo_character.glb` (the rig's mesh + one clip, `mixamo_clip`),
`mixamo_rotations.npz`, `skeleton_motion.npz`, and `videos/compare.mp4` (2×2:
source, human skeleton, Mixamo skeleton, character). **Review `compare.mp4`
before using the GLB.** To try the same motion on another rig without
re-extracting, pass `--skeleton outputs/<run>/skeleton_motion.npz`.

A single gesture for a hero that already has a clip set: run it through
`finish-clips.mjs --clips <name>` (section 4b), then ship (section 5).
`tools/sanitize-hero-clips.mjs` is for Tripo-retargeted clips, so skip it here.

## 4b. A hero's full clip set (authored, not mocap)

The game asks every hero GLB for 11 clips by name (`arenaHero.ts`,
`villageHub.ts`): `idle` · `walk` · `run` (loops), `cast` (basic) · `cast_e` ·
`cast_r` · `cast_f` (one-shots; the village plays only their upper body),
`hit`, `death` (last frame held), `jump_start` (crouch → launch → rise) and
`jump_land` (from touchdown). All of them are **in place**: the controller owns
translation, including the jump arc.

The motions are authored from biomechanics in `moves/<hero>.mjs` on the
helpers in `moves/lib.mjs`: poses relative to a relaxed stand, eased one-shot
timelines, periodic splines for gaits (`walk` uses standard sagittal hip,
knee and ankle curves; the hip bob is computed from leg geometry so the planted
foot stays down). No mocap clip and no existing game clip is used. The stage
renders them on the Soldier figure from a plain T-pose base.

```sh
node tools/motion-video/build-moves.mjs <hero> [clip ...]   # specs → assets/work/<hero>/anim/specs, videos+sheets → ~/.cache/psyrena/anim/<hero>
#   review the *_sheet.png files; fix moves/<hero>.mjs; re-run for the clips you changed
scp ~/.cache/psyrena/anim/<hero>/*.mp4 gpu-box:Motion2MixamoRig/assets/video/<hero>/
ssh gpu-box 'cd ~/Motion2MixamoRig && for c in idle walk run cast cast_e cast_r cast_f hit death jump_start jump_land; do
  .venv/bin/m2mr run --video assets/video/<hero>/$c.mp4 --rig assets/mixamo/<Hero>.fbx --device cuda --output-dir outputs/<hero>_anim/$c; done'
scp -r gpu-box:Motion2MixamoRig/outputs/<hero>_anim/. ~/.cache/psyrena/anim/<hero>/m2mr/
node tools/motion-video/finish-clips.mjs <hero> --character character.glb \
  --runs ~/.cache/psyrena/anim/<hero>/m2mr --out assets/work/<hero>/anim/glb
```

`finish-clips.mjs` cuts each m2mr result per its `<clip>.cut.json`:
- **Loops:** one period from the middle, with the seam closed exactly.
- **Heading:** rotated back to the rig's +Z (the camera looked from 25°).
- **Root:** horizontal drift pinned; the clip stands at rest height at its
  aligned frame (`jump_land` aligns at its end); `noRise` for the jump halves;
  `death` keeps its fall.
- **Units:** metres → cm.

It writes `<hero>_<clip>.glb` per clip plus `<hero>.glb` with all 11. **Every
file carries the identical `character.glb` model** (mesh, skin, materials and
texture bytes are verified equal), so all the clips share one outlook.
`assets/work/*/anim/glb/` is gitignored; the specs are the source of truth.

Lessons from Erikson (2026-10-16):
- A forward arm swing only works from a hanging arm. With `z` ≈ 80–90 then
  `x−`, the arm comes forward; at `z` 60 it points sideways and `x` barely moves
  it (the first `cast_e` read as a shrug).
- Palms out ("stop") = forearms up, then roll the hand +80 (`RightHand` x; the
  left mirrors).
- Overhead and airborne clips need `camera.distance` 5.6 and `target` 1.15, or
  the hands and head leave the frame and m2mr loses them.
- m2mr placed the idle hand slightly higher than the source (across the nose,
  not on the moustache). Aim a little low for hand-to-face gestures.

## 4c. Clip set from PINOC instead of m2mr (Piaget, Bandura, 2026-10-24)

Stages 3–4 can be replaced by PINOC (the `pinoc` MCP server): free library
clips for locomotion and text-to-motion for the casts (1 credit/s, 4 samples
per prompt). PINOC's `mixamo-glb` is the X Bot on a 65-joint Mixamo skeleton
in a true T-pose, so it retargets onto the 25-bone hero rig directly:

```sh
node tools/motion-video/pinoc-retarget.mjs pinoc.glb assets/work/<hero>/rig/character.glb \
  ~/.cache/psyrena/anim/<hero>/pinoc/<clip>/mixamo_character.glb
node tools/motion-video/finish-clips.mjs <hero> --character assets/work/<hero>/rig/character.glb \
  --runs ~/.cache/psyrena/anim/<hero>/pinoc --out assets/work/<hero>/anim/glb --foot-fix off
```

The retarget writes m2mr's shape (character.glb + one clip), so finish-clips
and ship-hero take it unchanged. `--foot-fix off`: the foot-pitch correction
undoes an m2mr bias that a world-space retarget does not have. Cuts carry
`"source": "pinoc"`; jump_start and jump_land are both cut from the library
`Jump` (crouch to 0.57 s, takeoff, touchdown at 1.08 s). Picked samples and
asset ids: `assets/work/<hero>/anim/pinoc.json`. PINOC characters are Gaussian
splats, not meshes, so the model still comes from Tripo.

## 5. Ship to the game

`finish-clips.mjs` output is not game-ready: it has Tripo's JPEG/PNG textures
(a 2048 albedo) and no meshopt. `tools/ship-hero.mjs` (PR #122) does the rest:

```sh
npm run ship:hero -- <hero>             # dry run → /tmp/ship-hero/<hero>.glb
npm run ship:hero -- <hero> --install   # → public/assets/heroes/<hero>.glb + MODELED_HEROES
```

It resamples, fits textures to `TEXTURE_RULES.heroMaxSize`, encodes UASTC
KTX2 and meshopt, and runs the same checks `npm run build` runs
(`tools/verify-hero-assets.mjs`). `--install` refuses until the hero's
concept is approved in Concept Review. Erikson: 4.02 → 3.67 MB, and about
33 → 4 MB of GPU texture memory. Before merging, the hero also needs a kit in
`shared/heroes/`. Then run `tools/mobile-scenes-e2e.mjs --mobile`
(CLAUDE.md rule 8).

## 6. Viewer

**http://localhost:8470/**

It runs as the user service `m2mr-viewer.service`
(`~/.config/systemd/user/`, `node tools/motion-video/view.mjs --host 127.0.0.1
--port 8470`, restart always, lingering on, so it survives reboots), and
`tailscale serve --https=8451` proxies to it. Manage it with
`systemctl --user restart|status m2mr-viewer`. Logs:
`journalctl --user -u m2mr-viewer`. For an ad-hoc instance elsewhere:
`node tools/motion-video/view.mjs [--runs DIR] [--host ADDR] [--port N]`.

Runs live in `~/.cache/psyrena/m2mr-runs/<run>/`, newest first, and appear on
reload. A run folder holds:

| File | From |
|---|---|
| `source.mp4` | the gesture video from `render.mjs` |
| `mixamo_character.glb`, `run.json`, `compare.mp4` | the m2mr output dir (`videos/compare.mp4`) |
| `character.glb` | `tripo_to_mixamo.py --glb` (textured; optional but recommended) |
| `rig.fbx`, `gesture.json` | optional, for the record |

Left is the source video, right is the result (orbitable), on one timeline
(play/pause, 0.25–1×, scrub, loop), plus a toggle for m2mr's `compare.mp4`. With
`character.glb` present, m2mr's clip plays on the textured rig; otherwise the
untextured `mixamo_character.glb` is shown.

## Verification log, 2026-10-15

| Stage | Result |
|---|---|
| 1. T-pose art | Freud's approved `freud_{front,back}_tpose.png` reused |
| 2a. `tripo make` | ✅ `4027dd2c-d24c-4854-ac9d-735d5e963da9`, 30 cr, clean T-pose |
| 2b. rig raw mesh, mixamo/fbx | ❌ `9de8398e`, 1001 internal error, refunded |
| 2c. `mesh decimate` 20k | ✅ `fbd07a10-0e89-4776-85e9-ff67758a4825`, 30 cr, detail kept |
| 2d. rig 20k, mixamo/fbx | ❌ `77cb5b4f`, 1001 internal error, refunded |
| 2e. rig 20k, mixamo/glb | ✅ `bb19104c-8f70-4d64-97af-3bb1c0efde89`, 25 cr, but Tripo bone names (GAP) |
| 3. gesture video | ✅ `wave.json` on Soldier, 156 frames, 0 clamps, YOLOv8x 0.92 |
| 4. m2mr, stock Y_Bot rig | ✅ 36 s on cuda; wave reproduced on Y Bot (`compare.mp4` checked); 0 twist events, 0 sign flips |
| 2f. `tripo_to_mixamo.py` | ✅ 25 bones, 5 tips synthesised, sides verified (pipe = RightHand) |
| 4. m2mr, Freud rig (`--skeleton` reuse) | ✅ 17.8 s; rest FK error 8.7e-06, skin error 2.6e-05 cm, C = I; Freud waves, upright |
| 5. viewer | ✅ clip plays on the textured `character.glb` in sync with the source |

| **Full run: Erikson walk (new hero, nothing reused)** | |
| 1. plates | ✅ `assets/work/erikson/plates/erikson_{front,back}_tpose.png`, GPT Image 2.5 edits (Freud plate = style/pose ref, `erikson_sketch` = likeness), 2 × 69 Buzz |
| 2. Tripo make → decimate 20k → rig glb | ✅ `61418ace` / `d0b7621d` / `2a81b3b3`, 85 cr, all first try |
| 2b. converter on **spark** (Blender 4.0) | ✅ Tripo gave this rig toe bones, so only the 3 tips were synthesised |
| 3. walk video | ✅ `examples/walk.json`: Soldier's in-place walk mocap, 4 s, 30 fps |
| 4. m2mr | ✅ extraction 29 s (Y Bot), Erikson retarget 14.7 s via `--skeleton`; rest FK 6.1e-06 |
| 5. viewer | ✅ `walk-erikson`: textured Erikson walking in sync |

Hand fix (2026-10-15): the first Erikson walk had the wrists bent 90°, with
palms turned in, while the three.js source was fine. Cause and fix are above
(Hand +Y). Both runs were rebuilt; hands now hang naturally and Freud's waving
hand stands upright.

Erikson walk notes: the hourglass charm smears (it sits where hip and thigh
weights blend), and the hands swing close to the hips, inherited from Soldier's
bent-arm walk.

Fidelity notes from the Freud run: Soldier's idle is a bent-knee combat stance
and Freud inherits it (a neutral standing idle would fix it), and the hand rises
to head height rather than above it.

Credits: 170 spent (3,330 → 3,160): 85 on the Freud test, 85 on Erikson.

## Survival monsters (2026-10-19)

17 creatures `sv-<name>` (`docs/survival-design.md` §10), same stages 1–4 with
three differences:

- **Rig without Tripo.** `tripo anim rig` built nonsense skeletons on these
  creatures (a spine hung off a leg, a quadruped tree for the dog-man, no spine
  at all), at 3k–15k faces and again at 20k. `template_rig.py` rigs the
  *unrigged* decimated model instead: it measures the T-pose silhouette (arm
  line, torso width, leg split, with robes/coats falling back to human
  proportions), places the 25 Mixamo joints, and heat-weights a welded copy
  whose groups are transferred back. Output matches `tripo_to_mixamo.py`, so m2mr
  and `finish-clips.mjs` take it unchanged. `rig_check.py` draws the joints for
  review (`assets/work/<id>/rig/rig_check.png`).
- **Triangle budgets.** Tripo's `--face-limit` lands about 1.8× over in
  triangles, and meshoptimizer stalls on Tripo's UV seams, so
  `decimate_glb.py` (Blender collapse) cuts to the tier budget before rigging:
  minion 2.9k, elite 7.8k, boss 14.5k.
- **Four shared clips.** `moves/dreamspawn.mjs` (idle, walk, attack, death)
  is rendered and extracted once on Y Bot (`outputs/dreamspawn_ybot` on spark),
  then retargeted to each rig with `m2mr run --skeleton`. Run at most 2 at once
  on spark: 3 parallel calibrations died silently.

Ship with `node tools/ship-monster.mjs <id> <minion|elite|boss>`, which writes
`public/assets/survival/monsters/<id>.glb` after its budget and clip checks. Dream Wisp
and Falling Dream are rigid (no rig, no clips).
