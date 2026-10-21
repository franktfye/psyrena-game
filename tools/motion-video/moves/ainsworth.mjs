// Ainsworth's clip set, authored from human biomechanics (no mocap, no existing
// game clips as reference). Same clip contract as erikson.mjs — idle / walk /
// run loops, cast / cast_e / cast_r / cast_f, hit, death, jump_start,
// jump_land — PLUS one clip per attachment style for palette keys 1–4
// (cast_secure, cast_avoidant, cast_ambivalent, cast_disorganized).
//
// Her movement language, so she never reads as a re-skinned male kit:
//   - poised and upright: chest lifted, chin level, small economical motions;
//   - a narrow gait (feet near one line), more pelvic sway, a small arm swing
//     with the elbows kept close;
//   - casts are GESTURES OF CARE, not throws: reaching, holding, sheltering,
//     welcoming. Each style key acts out its Strange Situation reunion.

import { pose, mirror, timeline, periodic, cyclic, spec } from "./lib.mjs";

const PI2 = Math.PI * 2;
const both = (right) => ({ ...right, ...mirror(right) });
const THIGH = 0.43, SHIN = 0.43, LEG = THIGH + SHIN;
const rad = (d) => (d * Math.PI) / 180;
const reach = (hipFlex, knee) => THIGH * Math.cos(rad(hipFlex)) + SHIN * Math.cos(rad(hipFlex - knee));
const smooth = (u) => u * u * (3 - 2 * u);
/** 0 → 1 → 0 plateau over the phase window a..d. */
const bump = (p, a, b, c, d) => (p <= a || p >= d ? 0 : p < b ? smooth((p - a) / (b - a)) : p <= c ? 1 : smooth((d - p) / (d - c)));
const lerp3 = (a, b, e) => a.map((x, i) => x + (b[i] - x) * e);

/** Her rest stance: chest lifted, shoulders back, elbows soft and close. */
const POISE = {
  Spine: [-2, 0, 0], Spine2: [-2, 0, 0], Head: [2, 0, 0],
  RightArm: [-6, 8, 78], LeftArm: [-6, -8, -78],
  RightForeArm: [0, 18, 0], LeftForeArm: [0, -18, 0],
  RightHand: [0, 0, 6], LeftHand: [0, 0, -6],
};
const stand = (over = {}) => pose({ ...POISE, ...over });
/** Right hand flat over the heart brooch: upper arm near hanging, the elbow does the lift. */
const HEART_R = { RightArm: [-8, 52, 86], RightForeArm: [0, 100, 0], RightHand: [-10, 0, 10] };
const HEART_BOTH = { ...HEART_R, ...mirror(HEART_R) };

const WIDE = { camera: { azimuth: 25, elevation: 6, distance: 5.6, target: 1.15 } };
const LEAD = 0.25, TAIL = 0.35;
function oneShot(kf, extra = {}) {
  const end = kf.at(-1).t;
  const shifted = [{ t: 0, pose: stand() }, ...kf.map((k) => ({ ...k, t: k.t + LEAD })), { t: end + LEAD + TAIL, pose: kf.at(-1).pose, root: kf.at(-1).root }];
  const duration = end + LEAD + TAIL;
  return { spec: spec(timeline(shifted, duration), duration, extra), cut: { kind: "oneshot", start: LEAD, end: end + LEAD } };
}

// ---- walk: narrow, swaying, elbows close. Phase 0 = right heel strike ---------
function walk() {
  const T = 1.1;
  const hip = periodic([[0, 22], [0.12, 19], [0.3, 4], [0.5, -10], [0.62, -4], [0.75, 18], [0.87, 25]]);
  const knee = periodic([[0, 3], [0.12, 14], [0.3, 5], [0.5, 9], [0.62, 36], [0.72, 55], [0.87, 16]]);
  const dorsi = periodic([[0, 0], [0.08, -6], [0.3, 6], [0.5, 12], [0.62, -12], [0.75, 2], [0.87, 0]]);
  const leg = (p) => ({ h: hip(p), k: Math.max(0, knee(p)), a: dorsi(p) });
  const c = cyclic((p) => {
    const R = leg(p), L = leg(p + 0.5);
    const cw = Math.cos(PI2 * p), sw = Math.sin(PI2 * p);
    const bob = Math.max(reach(R.h, R.k), reach(L.h, L.k)) - LEG;
    return {
      pose: {
        Hips: [0, 7 * cw, -4 * sw],                       // more pelvic rotation and drop than his
        Spine: [-2, 0, 3 * sw], Spine1: [0, 0, 0], Spine2: [-2, -5 * cw, 0],
        Head: [2, 2 * cw, -1.5 * sw],                     // head stays level over the sway
        // Thighs adduct a little so the feet land near one line.
        RightUpLeg: [-R.h, 0, 3], RightLeg: [R.k, 0, 0], RightFoot: [-R.a, 0, 0],
        LeftUpLeg: [-L.h, 0, -3], LeftLeg: [L.k, 0, 0], LeftFoot: [-L.a, 0, 0],
        // Small swing, elbows close, the hand travels slightly across the body.
        RightArm: [-6 + 9 * cw, 8 + 6 * cw, 80], LeftArm: [-6 - 9 * cw, -8 + 6 * cw, -80],
        RightForeArm: [0, 24 - 8 * cw, 0], LeftForeArm: [0, -(24 + 8 * cw), 0],
        RightHand: [0, 0, 8], LeftHand: [0, 0, -8],
      },
      root: [-0.03 * sw, bob, 0],
    };
  }, T, 4);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T * 2 } };
}

// ---- run: a light, upright jog — short flight, tucked elbows ------------------
function run() {
  const T = 0.68;
  const hip = periodic([[0, 28], [0.1, 20], [0.28, -10], [0.42, 6], [0.58, 40], [0.78, 38], [0.9, 32]]);
  const knee = periodic([[0, 20], [0.1, 36], [0.28, 16], [0.42, 75], [0.58, 88], [0.78, 40], [0.9, 22]]);
  const dorsi = periodic([[0, 2], [0.1, 14], [0.28, -22], [0.42, -8], [0.58, 0], [0.78, 4], [0.9, 4]]);
  const c = cyclic((p) => {
    const cw = Math.cos(PI2 * p);
    const R = { h: hip(p), k: Math.max(0, knee(p)), a: dorsi(p) };
    const L = { h: hip(p + 0.5), k: Math.max(0, knee(p + 0.5)), a: dorsi(p + 0.5) };
    return {
      pose: {
        Hips: [0, 8 * cw, 0],
        Spine: [2, 0, 0], Spine1: [1, 0, 0], Spine2: [0, -6 * cw, 0], Head: [-2, 2.5 * cw, 0],
        RightUpLeg: [-R.h, 0, 3], RightLeg: [R.k, 0, 0], RightFoot: [-R.a, 0, 0],
        LeftUpLeg: [-L.h, 0, -3], LeftLeg: [L.k, 0, 0], LeftFoot: [-L.a, 0, 0],
        // Elbows bent and close; forearms swing slightly across the body.
        RightArm: [-10 + 18 * cw, 8, 78], LeftArm: [-10 - 18 * cw, -8, -78],
        RightForeArm: [0, 85, 0], LeftForeArm: [0, -85, 0],
        RightHand: [0, 0, 10], LeftHand: [0, 0, -10],
      },
      root: [0, -0.05 - 0.025 * Math.cos(2 * PI2 * (p - 0.1)), 0],
    };
  }, T, 6);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T * 3 } };
}

// ---- idle: hands resting one over the other in front of the belly; only the
// breath and a faint weight shift move. Kept still on purpose (Frank, review).
function idle() {
  const T = 8;
  // Upper arms hang close to the body; the forearms come in across it so the
  // right hand rests over the left, both relaxed at the lower belly.
  const HANDS = {
    RightArm: [-8, 40, 85], RightForeArm: [0, 58, 0], RightHand: [0, 0, 12],
    LeftArm: [-8, -36, -85], LeftForeArm: [0, -54, 0], LeftHand: [0, 0, -12],
  };
  const c = cyclic((p) => {
    const br = Math.sin(PI2 * p * 3);                     // three slow breaths per cycle
    const shift = Math.sin(PI2 * p);                       // weight eases from one hip to the other
    return {
      pose: {
        ...HANDS,
        Spine: [-2, 0, 0.6 * shift], Spine1: [-0.8 * br, 0, 0], Spine2: [-2 - 0.6 * br, 0, 0],
        RightShoulder: [0, 0, -0.6 * br], LeftShoulder: [0, 0, 0.6 * br],
        Hips: [0, 0, -1.2 * shift],
        Head: [2, -1.5 * shift, 0],
        RightLeg: [Math.max(0, 3 * shift), 0, 0], LeftLeg: [Math.max(0, -3 * shift), 0, 0],
      },
      root: [0.01 * shift, 0, 0],
    };
  }, T, 2);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T } };
}

// ---- cast (basic: Sensitivity) — a quick attentive reach, open palm ------------
function cast() {
  const notice = stand({
    Spine: [-3, -8, 0], Spine2: [0, -10, 0], Head: [4, 14, 0],            // turn toward the signal
    RightArm: [-25, 20, 80], RightForeArm: [0, 70, 0], RightHand: [0, 0, 15],
    LeftUpLeg: [-6, 0, 0], LeftLeg: [8, 0, 0],
  });
  const reachOut = stand({
    Spine: [8, 6, 0], Spine2: [2, 6, 0], Head: [-4, -4, 0],
    RightArm: [-82, 10, 82], RightForeArm: [0, 14, 0], RightHand: [80, 0, -20],   // arm forward, palm open to the target
    LeftArm: [-10, -10, -78], LeftForeArm: [0, -40, 0],
    RightUpLeg: [-14, 0, 0], RightLeg: [12, 0, 0], LeftUpLeg: [6, 0, 0], LeftLeg: [10, 0, 0],
  });
  const settle = stand({
    Spine: [4, 2, 0], Head: [0, 0, 0],
    RightArm: [-50, 20, 80], RightForeArm: [0, 40, 0], RightHand: [40, 0, 0],
  });
  return oneShot([
    { t: 0.18, pose: notice, root: [0, -0.01, -0.01] },
    { t: 0.34, pose: reachOut, root: [0, -0.02, 0.06], ease: "out" },
    { t: 0.55, pose: settle, root: [0, -0.01, 0.03] },
    { t: 0.95, pose: stand(), root: [0, 0, 0] },
  ]);
}

// ---- 1 · Secure — comfort, then release to explore: embrace → open outward ----
function castSecure() {
  const open = stand({
    ...both({ RightArm: [-35, -10, 58], RightForeArm: [0, 20, 0], RightHand: [40, 0, 0] }),
    Spine: [-4, 0, 0], Spine2: [-4, 0, 0], Head: [-4, 0, 0],
  });
  const embrace = stand({
    ...both({ RightArm: [-50, 36, 82], RightForeArm: [0, 85, 0], RightHand: [0, 0, 18] }),
    Spine: [10, 0, 0], Spine1: [4, 0, 0], Head: [12, 0, 6],
    RightLeg: [12, 0, 0], LeftLeg: [12, 0, 0], RightUpLeg: [-6, 0, 0], LeftUpLeg: [-6, 0, 0],
  });
  const release = stand({
    ...both({ RightArm: [-55, -15, 58], RightForeArm: [0, 12, 0], RightHand: [70, 0, -10] }),
    Spine: [-2, 0, 0], Spine2: [-4, 0, 0], Head: [-6, 0, 0],
    RightUpLeg: [-12, 0, 0], RightLeg: [6, 0, 0],
  });
  return oneShot([
    { t: 0.25, pose: open, root: [0, 0, -0.02] },
    { t: 0.6, pose: embrace, root: [0, -0.04, 0.02] },
    { t: 0.8, pose: embrace, root: [0, -0.04, 0.02] },
    { t: 1.05, pose: release, root: [0, 0, 0.05], ease: "out" },
    { t: 1.5, pose: stand(), root: [0, 0, 0] },
  ]);
}

// ---- 2 · Avoidant — turn away, self-contained; a cool backhand without looking -
function castAvoidant() {
  const closed = stand({
    Hips: [0, 25, 0], Spine: [0, 12, 0], Spine2: [0, 10, 0], Head: [-4, 20, 0],   // turned to her left, away
    RightArm: [-50, 60, 72], RightForeArm: [0, 120, 0], RightHand: [0, 0, 10],    // right arm folded across the chest
    LeftArm: [-30, -50, -78], LeftForeArm: [0, -110, 0],                          // left hand holds the right elbow
    RightLeg: [10, 0, 0],
  });
  const flick = stand({
    Hips: [0, 25, 0], Spine: [0, -8, 0], Spine2: [0, -14, 0], Head: [-6, 26, 0],  // body unwinds, head stays averted
    RightArm: [-60, -30, 40], RightForeArm: [0, 15, 0], RightHand: [-40, 0, -30], // backhand out to her right
    LeftArm: [-30, -50, -78], LeftForeArm: [0, -110, 0],
    RightLeg: [10, 0, 0],
  });
  return oneShot([
    { t: 0.35, pose: closed, root: [0, 0, -0.02] },
    { t: 0.6, pose: closed, root: [0, 0, -0.02] },
    { t: 0.74, pose: flick, root: [0, 0, -0.02], ease: "out" },
    { t: 0.95, pose: flick, root: [0, 0, -0.02] },
    { t: 1.45, pose: stand(), root: [0, 0, 0] },
  ]);
}

// ---- 3 · Ambivalent — the taunt: reach to cling, then push away and stamp ----
function castAmbivalent() {
  const cling = stand({
    ...both({ RightArm: [-75, 30, 80], RightForeArm: [0, 45, 0], RightHand: [60, 0, 20] }),
    Spine: [14, 0, 0], Spine1: [4, 0, 0], Head: [-10, 0, 0],
    RightUpLeg: [-22, 0, 0], RightLeg: [20, 0, 0], LeftUpLeg: [8, 0, 0], LeftLeg: [8, 0, 0],
  });
  const pull = stand({
    ...both({ RightArm: [-40, 20, 80], RightForeArm: [0, 115, 0], RightHand: [0, 0, 30] }),  // fists pulled to the chest
    Spine: [4, 0, 0], Head: [6, 0, 0],
    RightUpLeg: [-10, 0, 0], RightLeg: [12, 0, 0],
  });
  const push = stand({
    ...both({ RightArm: [-80, 0, 85], RightForeArm: [0, 30, 0], RightHand: [80, 0, -50] }),   // palms shove out
    Spine: [-4, 0, 0], Spine2: [-2, 0, 0], Head: [-8, 0, 0],
    RightUpLeg: [-30, 0, 0], RightLeg: [30, 0, 0], RightFoot: [-8, 0, 0],                      // knee lifts for the stamp
  });
  const stamp = stand({
    ...both({ RightArm: [-78, 0, 85], RightForeArm: [0, 32, 0], RightHand: [80, 0, -50] }),
    Spine: [6, 0, 0], Head: [-6, 0, 0],
    RightUpLeg: [-12, 0, 0], RightLeg: [14, 0, 0], LeftLeg: [12, 0, 0],
  });
  return oneShot([
    { t: 0.3, pose: cling, root: [0, -0.03, 0.06] },
    { t: 0.5, pose: pull, root: [0, -0.01, 0.02] },
    { t: 0.72, pose: push, root: [0, 0.01, -0.02], ease: "out" },
    { t: 0.86, pose: stamp, root: [0, -0.05, -0.01], ease: "in" },
    { t: 1.05, pose: stamp, root: [0, -0.05, -0.01] },
    { t: 1.5, pose: stand(), root: [0, 0, 0] },
  ]);
}

// ---- 4 · Disorganized — approach, FREEZE, recoil, then shelter the team -------
function castDisorganized() {
  const approach = stand({
    RightArm: [-55, 10, 82], RightForeArm: [0, 30, 0], RightHand: [60, 0, 0],
    LeftArm: [-20, -10, -80], LeftForeArm: [0, -30, 0],
    Spine: [8, 0, 0], Head: [-4, 0, 0],
    RightUpLeg: [-18, 0, 0], RightLeg: [14, 0, 0],
  });
  // The freeze: stopped mid-reach, a jolt through the shoulders, head snapping aside.
  const freeze = stand({
    RightArm: [-58, 10, 82], RightForeArm: [0, 34, 0], RightHand: [60, 0, 0],
    LeftArm: [-20, -10, -80], LeftForeArm: [0, -30, 0],
    RightShoulder: [0, 0, -8], LeftShoulder: [0, 0, 8],
    Spine: [6, 0, 0], Neck: [0, -10, 0], Head: [0, -22, 6],
    RightUpLeg: [-18, 0, 0], RightLeg: [14, 0, 0],
  });
  const recoil = stand({
    ...both({ RightArm: [-70, 40, 75], RightForeArm: [0, 125, 0], RightHand: [0, 0, 20] }),  // forearms cross in front of the face
    Spine: [16, 0, 0], Spine1: [6, 0, 0], Head: [18, 0, 0],
    RightLeg: [26, 0, 0], LeftLeg: [26, 0, 0], RightUpLeg: [-14, 0, 0], LeftUpLeg: [-14, 0, 0],
    RightFoot: [-12, 0, 0], LeftFoot: [-12, 0, 0],
  });
  // Then the arms fling wide and low — a dome over everyone behind her.
  const shelter = stand({
    ...both({ RightArm: [-40, -10, 56], RightForeArm: [0, 10, 0], RightHand: [60, 0, -25], RightShoulder: [0, 0, -6] }),
    Spine: [-6, 0, 0], Spine2: [-6, 0, 0], Head: [-8, 0, 0],
    RightUpLeg: [-8, 0, 0], RightLeg: [16, 0, 0], LeftUpLeg: [-8, 0, 0], LeftLeg: [16, 0, 0],
  });
  return oneShot([
    { t: 0.28, pose: approach, root: [0, -0.01, 0.06] },
    { t: 0.36, pose: freeze, root: [0, -0.01, 0.06], ease: "out" },
    { t: 0.66, pose: freeze, root: [0, -0.01, 0.06], ease: "linear" },
    { t: 0.84, pose: recoil, root: [0, -0.08, -0.02], ease: "out" },
    { t: 1.0, pose: recoil, root: [0, -0.08, -0.02] },
    { t: 1.22, pose: shelter, root: [0, -0.05, 0], ease: "out" },
    { t: 1.55, pose: shelter, root: [0, -0.05, 0] },
    { t: 2.0, pose: stand(), root: [0, 0, 0] },
  ], WIDE);
}

// ---- cast_e (Safe Haven) — hands over the heart, then sweep a dome down & out --
function castE() {
  const heart = stand({
    ...HEART_BOTH,
    Spine: [4, 0, 0], Head: [10, 0, 0],
  });
  const rise = stand({
    ...both({ RightArm: [-30, -20, -20], RightForeArm: [0, 15, 0], RightShoulder: [0, 0, -6] }),   // arms up and out
    Spine: [-8, 0, 0], Spine2: [-6, 0, 0], Head: [-12, 0, 0],
    RightFoot: [12, 0, 0], LeftFoot: [12, 0, 0],
  });
  const dome = stand({
    ...both({ RightArm: [-40, -10, 58], RightForeArm: [0, 10, 0], RightHand: [60, 0, -20] }),      // sweep down to a low arc
    Spine: [6, 0, 0], Head: [4, 0, 0],
    RightUpLeg: [-16, 0, 0], RightLeg: [30, 0, 0], LeftUpLeg: [-16, 0, 0], LeftLeg: [30, 0, 0],
    RightFoot: [-14, 0, 0], LeftFoot: [-14, 0, 0],
  });
  return oneShot([
    { t: 0.3, pose: heart, root: [0, -0.01, 0] },
    { t: 0.55, pose: heart, root: [0, -0.01, 0] },
    { t: 0.8, pose: rise, root: [0, 0.03, 0], ease: "out" },
    { t: 1.15, pose: dome, root: [0, -0.1, 0] },
    { t: 1.4, pose: dome, root: [0, -0.1, 0] },
    { t: 1.85, pose: stand(), root: [0, 0, 0] },
  ], WIDE);
}

// ---- cast_r (Strange Situation) — separation: turn away, a small wave over the
// shoulder; reunion: turn back and open the arms in welcome --------------------
function castR() {
  const away = stand({
    Hips: [0, -40, 0], Spine: [0, -15, 0], Spine2: [0, -10, 0], Neck: [0, 15, 0], Head: [0, 40, 0],   // body turned, head looking back
    RightArm: [-10, 0, 78], RightForeArm: [0, 25, 0],
    LeftArm: [-80, 0, -25], LeftForeArm: [0, -100, 0], LeftHand: [0, 0, 0],                         // left hand raised beside the head
    RightLeg: [10, 0, 0],
  });
  const wave = { ...away, LeftArm: [-62, 0, -25] };
  const welcome = stand({
    ...both({ RightArm: [-50, -15, 66], RightForeArm: [0, 25, 0], RightHand: [70, 0, -10] }),
    Spine: [-4, 0, 0], Spine2: [-5, 0, 0], Head: [-6, 0, 0],
    RightUpLeg: [-20, 0, 0], RightLeg: [10, 0, 0], LeftUpLeg: [6, 0, 0], LeftLeg: [6, 0, 0],
  });
  return oneShot([
    { t: 0.35, pose: away, root: [0, 0, -0.03] },
    { t: 0.5, pose: wave, root: [0, 0, -0.03] },
    { t: 0.65, pose: away, root: [0, 0, -0.03] },
    { t: 0.8, pose: wave, root: [0, 0, -0.03] },
    { t: 1.15, pose: welcome, root: [0, -0.02, 0.06], ease: "out" },
    { t: 1.45, pose: welcome, root: [0, -0.02, 0.06] },
    { t: 1.9, pose: stand(), root: [0, 0, 0] },
  ], WIDE);
}

// ---- cast_f (Earned Security) — lift the locket to the heart, offer it up,
// open wide to everyone --------------------------------------------------------
function castF() {
  const locket = stand({
    // Both hands cup the locket at her left hip; she looks down at it.
    RightArm: [-25, 50, 76], RightForeArm: [0, 70, 0], RightHand: [0, 0, 20],
    LeftArm: [-8, -15, -78], LeftForeArm: [0, -50, 0], LeftHand: [0, 0, -20],
    Spine: [10, 6, 0], Neck: [6, 0, 0], Head: [18, 8, 0],
    RightLeg: [14, 0, 0], LeftLeg: [14, 0, 0], RightUpLeg: [-7, 0, 0], LeftUpLeg: [-7, 0, 0],
  });
  const heart = stand({
    ...HEART_BOTH,
    Spine: [0, 0, 0], Head: [6, 0, 0],
  });
  const offer = stand({
    ...both({ RightArm: [-100, 20, 78], RightForeArm: [0, 30, 0], RightHand: [80, 0, -30] }),   // cupped hands raised in front, up high
    Spine: [-10, 0, 0], Spine2: [-8, 0, 0], Neck: [-6, 0, 0], Head: [-20, 0, 0],
    RightFoot: [18, 0, 0], LeftFoot: [18, 0, 0],
  });
  const open = stand({
    ...both({ RightArm: [-20, -10, -30], RightForeArm: [0, 10, 0], RightHand: [60, 0, -20], RightShoulder: [0, 0, -10] }),
    Spine: [-10, 0, 0], Spine2: [-8, 0, 0], Neck: [-4, 0, 0], Head: [-14, 0, 0],
    RightFoot: [18, 0, 0], LeftFoot: [18, 0, 0],
  });
  const embraceAll = stand({
    ...both({ RightArm: [-42, -10, 60], RightForeArm: [0, 30, 0], RightHand: [60, 0, -10] }),
    Spine: [4, 0, 0], Head: [2, 0, 0],
    RightLeg: [10, 0, 0], LeftLeg: [10, 0, 0], RightUpLeg: [-5, 0, 0], LeftUpLeg: [-5, 0, 0],
  });
  return oneShot([
    { t: 0.4, pose: locket, root: [0, -0.05, 0] },
    { t: 0.7, pose: locket, root: [0, -0.05, 0] },
    { t: 1.0, pose: heart, root: [0, 0, 0] },
    { t: 1.45, pose: offer, root: [0, 0.045, 0] },
    { t: 1.8, pose: open, root: [0, 0.045, 0], ease: "out" },
    { t: 2.05, pose: open, root: [0, 0.045, 0] },
    { t: 2.4, pose: embraceAll, root: [0, -0.02, 0] },
    { t: 2.85, pose: stand(), root: [0, 0, 0] },
  ], WIDE);
}

// ---- hit — flinch inward, hand to the brooch, gather herself -----------------
function hit() {
  const flinch = stand({
    Spine: [-8, 0, 4], Spine1: [-4, 0, 0], Spine2: [-4, 0, 0], Head: [-10, -18, 6],   // head turns aside
    RightShoulder: [0, 0, -10], LeftShoulder: [0, 0, 10],                             // shoulders lift
    ...HEART_R,                                                                     // hand to the heart
    LeftArm: [10, -10, -66], LeftForeArm: [0, -30, 0],
    RightUpLeg: [8, 0, 0], RightLeg: [12, 0, 0], LeftLeg: [10, 0, 0],
  });
  const gather = stand({
    Spine: [6, 0, 0], Head: [8, -4, 0],
    ...HEART_R,
    LeftArm: [-10, -10, -76], LeftForeArm: [0, -30, 0],
    RightLeg: [14, 0, 0], LeftLeg: [14, 0, 0], RightUpLeg: [-5, 0, 0], LeftUpLeg: [-5, 0, 0],
  });
  return oneShot([
    { t: 0.12, pose: flinch, root: [0, -0.02, -0.05], ease: "out" },
    { t: 0.32, pose: gather, root: [0, -0.03, -0.03] },
    { t: 0.85, pose: stand(), root: [0, 0, 0] },
  ]);
}

// ---- death — falter, sink to her knees, settle onto her side, hand on heart ---
function death() {
  const falter = stand({
    Spine: [-8, 0, 0], Head: [-12, 0, 0],
    ...HEART_R,
    LeftArm: [10, 0, -70], LeftForeArm: [0, -30, 0],
  });
  const kneel = stand({
    Spine: [14, 0, 0], Head: [18, 0, 0],
    ...HEART_R,
    LeftArm: [-20, 0, -74], LeftForeArm: [0, -25, 0],
    RightUpLeg: [-5, 0, 0], RightLeg: [105, 0, 0], RightFoot: [45, 0, 0],
    LeftUpLeg: [-5, 0, 0], LeftLeg: [105, 0, 0], LeftFoot: [45, 0, 0],
  });
  // Sits back onto her heels, the left hand reaching to the floor beside her.
  const sit = stand({
    Hips: [0, 0, 12], Spine: [6, 0, -10], Head: [12, 0, -6],
    ...HEART_R,
    LeftArm: [10, 0, -55], LeftForeArm: [0, -5, 0],
    RightUpLeg: [-55, 0, 0], RightLeg: [140, 0, 0], RightFoot: [45, 0, 0],
    LeftUpLeg: [-55, 0, 0], LeftLeg: [140, 0, 0], LeftFoot: [45, 0, 0],
  });
  // Lies on her left side, knees drawn up, right hand still over the heart.
  const side = stand({
    Hips: [0, 0, 80], Spine: [0, 0, 0], Neck: [0, 0, -10], Head: [0, 0, -15],
    ...HEART_R,
    LeftArm: [-80, 0, -70], LeftForeArm: [0, -60, 0],
    RightUpLeg: [-40, 0, 0], RightLeg: [60, 0, 0], RightFoot: [30, 0, 0],
    LeftUpLeg: [-30, 0, 0], LeftLeg: [50, 0, 0], LeftFoot: [30, 0, 0],
  });
  const r = oneShot([
    { t: 0.25, pose: falter, root: [0, -0.01, -0.04], ease: "out" },
    { t: 0.8, pose: kneel, root: [0, -0.42, 0.02], ease: "in" },
    { t: 1.3, pose: sit, root: [0, -0.62, -0.05] },
    { t: 1.95, pose: side, root: [0.3, -0.82, -0.05], ease: "in" },
    { t: 2.5, pose: side, root: [0.3, -0.83, -0.05] },
  ], { camera: { azimuth: 25, elevation: 12 } });
  return { spec: r.spec, cut: { kind: "hold", start: r.cut.start, end: r.cut.end, keepRoot: true } };
}

// ---- jump_start — a light springing hop, arms floating up to the sides --------
const AIR = stand({
  // Stag-like: right knee drawn up, left leg trailing, arms floating wide.
  RightUpLeg: [-50, 0, 0], RightLeg: [80, 0, 0], RightFoot: [20, 0, 0],
  LeftUpLeg: [-15, 0, 0], LeftLeg: [55, 0, 0], LeftFoot: [30, 0, 0],
  ...both({ RightArm: [-15, -10, 52], RightForeArm: [0, 25, 0], RightHand: [30, 0, -10] }),
  Spine: [-2, 0, 0], Head: [-4, 0, 0],
});
function jumpStart() {
  const crouch = stand({
    RightUpLeg: [-45, 0, 0], RightLeg: [75, 0, 0], RightFoot: [-28, 0, 0],
    LeftUpLeg: [-45, 0, 0], LeftLeg: [75, 0, 0], LeftFoot: [-28, 0, 0],
    Spine: [18, 0, 0], Head: [-10, 0, 0],
    ...both({ RightArm: [10, 10, 70], RightForeArm: [0, 25, 0] }),
  });
  const extend = stand({
    RightUpLeg: [-10, 0, 0], RightLeg: [5, 0, 0], RightFoot: [38, 0, 0],
    LeftUpLeg: [5, 0, 0], LeftLeg: [0, 0, 0], LeftFoot: [38, 0, 0],
    ...both({ RightArm: [-25, -10, 52], RightForeArm: [0, 20, 0], RightHand: [30, 0, -10] }),
    Spine: [-2, 0, 0], Head: [-6, 0, 0],
  });
  const r = oneShot([
    { t: 0.3, pose: crouch, root: [0, -0.18, -0.02] },
    { t: 0.48, pose: extend, root: [0, 0.05, 0], ease: "out" },
    { t: 0.6, pose: extend, root: [0, 0.28, 0] },
    { t: 0.95, pose: AIR, root: [0, 0.38, 0] },
  ], WIDE);
  return { spec: r.spec, cut: { ...r.cut, noRise: true } };
}

// ---- jump_land — toes first, soft absorb, arms float down -------------------
function jumpLand() {
  const touch = stand({
    RightUpLeg: [-12, 0, 0], RightLeg: [14, 0, 0], RightFoot: [22, 0, 0],
    LeftUpLeg: [-18, 0, 0], LeftLeg: [24, 0, 0], LeftFoot: [22, 0, 0],
    ...both({ RightArm: [-25, -10, 55], RightForeArm: [0, 20, 0], RightHand: [30, 0, -10] }),
  });
  const absorb = stand({
    RightUpLeg: [-38, 0, 0], RightLeg: [62, 0, 0], RightFoot: [-24, 0, 0],
    LeftUpLeg: [-38, 0, 0], LeftLeg: [62, 0, 0], LeftFoot: [-24, 0, 0],
    Spine: [14, 0, 0], Head: [-8, 0, 0],
    ...both({ RightArm: [-30, 0, 55], RightForeArm: [0, 30, 0] }),
  });
  const kf = [
    { t: 0, pose: AIR, root: [0, 0.35, 0] },
    { t: 0.22, pose: touch, root: [0, 0, 0], ease: "in" },
    { t: 0.42, pose: absorb, root: [0, -0.15, 0], ease: "out" },
    { t: 0.95, pose: stand(), root: [0, 0, 0] },
    { t: 1.25, pose: stand(), root: [0, 0, 0] },
  ];
  const duration = 1.25;
  return { spec: spec(timeline(kf, duration), duration, WIDE), cut: { kind: "oneshot", start: 0.2, end: 0.95, noRise: true, alignEnd: true } };
}

export const CLIPS = {
  idle, walk, run, cast, cast_e: castE, cast_r: castR, cast_f: castF, hit, death,
  jump_start: jumpStart, jump_land: jumpLand,
  cast_secure: castSecure, cast_avoidant: castAvoidant,
  cast_ambivalent: castAmbivalent, cast_disorganized: castDisorganized,
};
