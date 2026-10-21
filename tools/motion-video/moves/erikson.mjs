// Erikson's clip set, authored from human biomechanics (no mocap, no existing
// game clips as reference). The game's clip contract (arenaHero.ts and
// villageHub.ts): idle / walk / run loops, cast (basic) / cast_e / cast_r /
// cast_f one-shots, hit, death (held), jump_start (crouch → launch → rise) and
// jump_land (from touchdown). Everything in place: the controller owns
// translation, including the jump arc.
//
// Each entry: spec(...) for render.mjs + `cut` telling finish-clips.mjs how
// to turn the m2mr result into the game clip.

import { STAND, pose, mirror, timeline, periodic, cyclic, spec, FPS } from "./lib.mjs";

const PI2 = Math.PI * 2;
const both = (right) => ({ ...right, ...mirror(right) });
/** Segment lengths (m) of the 1.8 m stage figure, for ground contact maths. */
const THIGH = 0.43, SHIN = 0.43, LEG = THIGH + SHIN;
const rad = (d) => (d * Math.PI) / 180;
/** Vertical reach of a leg from hip joint to ankle, given hip flexion and knee bend. */
const reach = (hipFlex, knee) => THIGH * Math.cos(rad(hipFlex)) + SHIN * Math.cos(rad(hipFlex - knee));

/** Hold STAND at the start and end of a one-shot so m2mr starts and settles cleanly. */
const LEAD = 0.25, TAIL = 0.35;
function oneShot(kf, extra = {}, layers = []) {
  const end = kf.at(-1).t;
  const shifted = [{ t: 0, pose: pose() }, ...kf.map((k) => ({ ...k, t: k.t + LEAD })), { t: end + LEAD + TAIL, pose: kf.at(-1).pose, root: kf.at(-1).root }];
  const duration = end + LEAD + TAIL;
  return { spec: spec(timeline(shifted, duration, layers), duration, extra), lead: LEAD, end: end + LEAD };
}

// ---- walk: one gait cycle, phase 0 = right heel strike ------------------------
function walk() {
  const T = 1.15;
  const hip = periodic([[0, 25], [0.12, 22], [0.3, 5], [0.5, -10], [0.62, -4], [0.75, 20], [0.87, 28]]);
  const knee = periodic([[0, 4], [0.12, 16], [0.3, 6], [0.5, 10], [0.62, 38], [0.72, 58], [0.87, 18]]);
  const dorsi = periodic([[0, 0], [0.08, -6], [0.3, 6], [0.5, 10], [0.62, -15], [0.75, 2], [0.87, 0]]);
  const leg = (p) => ({ h: hip(p), k: Math.max(0, knee(p)), a: dorsi(p) });
  const c = cyclic((p) => {
    const R = leg(p), L = leg(p + 0.5);
    const cw = Math.cos(PI2 * p), sw = Math.sin(PI2 * p);
    // The lower foot touches the floor: drop the hips by the longest leg's shortfall.
    const bob = Math.max(reach(R.h, R.k), reach(L.h, L.k)) - LEG;
    return {
      pose: {
        Hips: [0, 4 * cw, -2 * sw],                       // pelvic rotation + drop on the swing side
        Spine: [3, 0, 2 * sw], Spine1: [1, 0, 0], Spine2: [0, -3 * cw, 0],   // lean, counter-rotate the shoulders
        Neck: [-1, 0, 0], Head: [-2, 1.5 * cw, 0],
        RightUpLeg: [-R.h, 0, 0], RightLeg: [R.k, 0, 0], RightFoot: [-R.a, 0, 0],
        LeftUpLeg: [-L.h, 0, 0], LeftLeg: [L.k, 0, 0], LeftFoot: [-L.a, 0, 0],
        RightArm: [-4 + 12 * cw, 0, 76], LeftArm: [-4 - 12 * cw, 0, -76],   // arms swing against the legs
        RightForeArm: [0, 15 - 8 * cw, 0], LeftForeArm: [0, -(15 + 8 * cw), 0],
      },
      root: [-0.02 * sw, bob, 0],                          // sway over the stance foot
    };
  }, T, 4);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T * 2 } };
}

// ---- run: flight phases, phase 0 = right foot strike ----------------------------
function run() {
  const T = 0.72;
  const hip = periodic([[0, 32], [0.1, 22], [0.28, -14], [0.42, 8], [0.58, 48], [0.78, 44], [0.9, 36]]);
  const knee = periodic([[0, 22], [0.1, 40], [0.28, 18], [0.42, 85], [0.58, 100], [0.78, 45], [0.9, 25]]);
  const dorsi = periodic([[0, 2], [0.1, 16], [0.28, -25], [0.42, -10], [0.58, 0], [0.78, 4], [0.9, 4]]);
  const c = cyclic((p) => {
    const cw = Math.cos(PI2 * p);
    const R = { h: hip(p), k: Math.max(0, knee(p)), a: dorsi(p) };
    const L = { h: hip(p + 0.5), k: Math.max(0, knee(p + 0.5)), a: dorsi(p + 0.5) };
    return {
      pose: {
        Hips: [0, 6 * cw, 0],
        Spine: [4, 0, 0], Spine1: [3, 0, 0], Spine2: [3, -5 * cw, 0], Head: [-7, 2 * cw, 0],
        RightUpLeg: [-R.h, 0, 0], RightLeg: [R.k, 0, 0], RightFoot: [-R.a, 0, 0],
        LeftUpLeg: [-L.h, 0, 0], LeftLeg: [L.k, 0, 0], LeftFoot: [-L.a, 0, 0],
        RightArm: [-10 + 28 * cw, 0, 70], LeftArm: [-10 - 28 * cw, 0, -70],
        RightForeArm: [0, 85, 0], LeftForeArm: [0, -85, 0],
      },
      // Lowest at mid-stance, highest mid-flight (two of each per cycle).
      root: [0, -0.07 - 0.035 * Math.cos(2 * PI2 * (p - 0.1)), 0],
    };
  }, T, 6);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T * 3 } };
}

// ---- idle: breathe, shift weight, stroke the moustache, settle ------------------
function idle() {
  const T = 5;
  const bump = (p, a, b, c, d) => (p <= a || p >= d ? 0 : p < b ? smooth((p - a) / (b - a)) : p <= c ? 1 : smooth((d - p) / (d - c)));
  const smooth = (u) => u * u * (3 - 2 * u);
  const c = cyclic((p) => {
    const br = Math.sin(PI2 * p * 2);                     // two slow breaths per cycle
    const e = bump(p, 0.25, 0.4, 0.62, 0.78);              // the thinking gesture
    const stroke = e * Math.sin(PI2 * p * 9) * 6;          // little strokes along the moustache
    const mix = (a, b) => a.map((x, i) => x + (b[i] - x) * e);
    return {
      pose: {
        Spine1: [-1.2 * br, 0, 0], Spine2: [-1 * br, 0, 0],
        RightShoulder: [0, 0, -1.2 * br], LeftShoulder: [0, 0, 1.2 * br],
        Hips: [0, 0, 1.2 * Math.sin(PI2 * p)],
        Head: mix([0, 0, 0], [8, -6, 0]),                   // a small thoughtful nod and turn
        Neck: mix([0, 0, 0], [3, 0, 0]),
        RightArm: mix(STAND.RightArm, [-55, 45, 78]),      // forward and inward: hand to the moustache
        RightForeArm: mix(STAND.RightForeArm, [0, 135, 0]),
        RightHand: mix([0, 0, 0], [stroke, 0, 12]),
      },
      root: [0.012 * Math.sin(PI2 * p), 0, 0],
    };
  }, T, 2);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T } };
}

// ---- cast (basic: "Mutuality" bolt) — overhand throw with the right hand -------
function cast() {
  const windup = pose({
    RightArm: [-75, -30, 5], RightForeArm: [0, 105, 0], RightHand: [0, 0, -15],
    LeftArm: [-55, 0, -45], LeftForeArm: [0, -35, 0],
    Spine: [-4, 0, 0], Spine1: [0, -8, 0], Spine2: [0, -18, 0], Neck: [0, 6, 0], Head: [0, 12, 0],
    RightUpLeg: [0, 0, 0], RightLeg: [10, 0, 0], LeftUpLeg: [-8, 0, 0], LeftLeg: [4, 0, 0], LeftFoot: [4, 0, 0],
  });
  const release = pose({
    RightArm: [-10, 55, 20], RightForeArm: [0, 15, 0], RightHand: [0, 0, 25],
    LeftArm: [10, 0, -70], LeftForeArm: [0, -40, 0],
    Spine: [6, 0, 0], Spine1: [0, 6, 0], Spine2: [0, 16, 0], Neck: [0, -4, 0], Head: [0, -10, 0],
    LeftLeg: [12, 0, 0], RightUpLeg: [8, 0, 0], RightLeg: [6, 0, 0],
  });
  const follow = pose({
    RightArm: [0, 75, 45], RightForeArm: [0, 25, 0], RightHand: [0, 0, 15],
    LeftArm: [5, 0, -72], LeftForeArm: [0, -30, 0],
    Spine: [8, 0, 0], Spine2: [0, 12, 0], Head: [0, -8, 0], LeftLeg: [10, 0, 0],
  });
  const r = oneShot([
    { t: 0.3, pose: windup, root: [0, -0.02, -0.03] },
    { t: 0.46, pose: release, root: [0, -0.03, 0.04], ease: "out" },
    { t: 0.62, pose: follow, root: [0, -0.02, 0.04] },
    { t: 1.1, pose: pose(), root: [0, 0, 0] },
  ]);
  return { spec: r.spec, cut: { kind: "oneshot", start: r.lead, end: r.end } };
}

// ---- cast_e (defense: Psychosocial Moratorium) — two-handed "pause" -----------
function castE() {
  const stop = pose({
    // Arms hang-and-swing forward (z 85 then x), forearms up, hands rolled palm-out.
    ...both({ RightArm: [-75, 0, 85], RightForeArm: [0, 75, 0], RightHand: [80, 0, -45] }),
    Spine: [-5, 0, 0], Head: [-4, 0, 0],
    RightUpLeg: [6, 0, 0], RightLeg: [12, 0, 0], LeftLeg: [12, 0, 0], LeftUpLeg: [-6, 0, 0],
  });
  const press = pose({
    ...both({ RightArm: [-80, 0, 85], RightForeArm: [0, 62, 0], RightHand: [80, 0, -50] }),
    Spine: [-3, 0, 0], Head: [-2, 0, 0],
    RightUpLeg: [6, 0, 0], RightLeg: [12, 0, 0], LeftLeg: [12, 0, 0], LeftUpLeg: [-6, 0, 0],
  });
  const r = oneShot([
    { t: 0.28, pose: stop, root: [0, -0.02, -0.04], ease: "out" },
    { t: 0.65, pose: press, root: [0, -0.02, -0.03] },
    { t: 1.25, pose: pose(), root: [0, 0, 0] },
  ]);
  return { spec: r.spec, cut: { kind: "oneshot", start: r.lead, end: r.end } };
}

// ---- cast_r (Identity Crisis, AOE) — gather, then burst outward ----------------
function castR() {
  const gather = pose({
    ...both({ RightArm: [-40, 30, 82], RightForeArm: [0, 75, 0], RightHand: [0, 0, 10] }),
    Spine: [10, 0, 0], Spine1: [4, 0, 0], Head: [10, 0, 0],
    RightLeg: [15, 0, 0], LeftLeg: [15, 0, 0], RightUpLeg: [-8, 0, 0], LeftUpLeg: [-8, 0, 0],
    RightFoot: [-7, 0, 0], LeftFoot: [-7, 0, 0],
  });
  const burst = pose({
    ...both({ RightArm: [0, 15, -10], RightForeArm: [0, 5, 0], RightHand: [0, 0, -20], RightShoulder: [0, 0, -8] }),
    Spine: [-10, 0, 0], Spine2: [-6, 0, 0], Head: [-10, 0, 0],
  });
  const r = oneShot([
    { t: 0.35, pose: gather, root: [0, -0.04, 0] },
    { t: 0.55, pose: burst, root: [0, 0, 0], ease: "out" },
    { t: 0.85, pose: burst, root: [0, 0, 0] },
    { t: 1.35, pose: pose(), root: [0, 0, 0] },
  ]);
  return { spec: r.spec, cut: { kind: "oneshot", start: r.lead, end: r.end } };
}

// ---- cast_f (ultimate: Life Review) — cradle the hourglass, rise, open --------
function castF() {
  const cradle = pose({
    RightArm: [-30, 20, 70], RightForeArm: [0, 70, 0], LeftArm: [-25, -10, -72], LeftForeArm: [0, -60, 0],
    Spine: [15, 0, 0], Neck: [6, 0, 0], Head: [18, 0, 0],
    RightLeg: [18, 0, 0], LeftLeg: [18, 0, 0], RightUpLeg: [-9, 0, 0], LeftUpLeg: [-9, 0, 0],
    RightFoot: [-9, 0, 0], LeftFoot: [-9, 0, 0],
  });
  const raised = pose({
    ...both({ RightArm: [0, 0, -78], RightForeArm: [0, 10, 0], RightShoulder: [0, 0, -12] }),
    Spine: [-8, 0, 0], Spine2: [-8, 0, 0], Neck: [-6, 0, 0], Head: [-18, 0, 0],
    RightFoot: [18, 0, 0], LeftFoot: [18, 0, 0],
  });
  const open = pose({
    ...both({ RightArm: [0, 10, -62], RightForeArm: [0, 15, 0], RightShoulder: [0, 0, -10] }),
    Spine: [-8, 0, 0], Spine2: [-8, 0, 0], Neck: [-6, 0, 0], Head: [-16, 0, 0],
    RightFoot: [18, 0, 0], LeftFoot: [18, 0, 0],
  });
  const lower = pose({ ...both({ RightArm: [0, 0, 25], RightForeArm: [0, 10, 0] }), Head: [-4, 0, 0] });
  const r = oneShot([
    { t: 0.45, pose: cradle, root: [0, -0.05, 0] },
    { t: 1.05, pose: raised, root: [0, 0.045, 0] },
    { t: 1.45, pose: open, root: [0, 0.045, 0] },
    { t: 1.85, pose: lower, root: [0, 0, 0], ease: "out" },
    { t: 2.3, pose: pose(), root: [0, 0, 0] },
  ], { camera: { azimuth: 25, elevation: 6, distance: 5.6, target: 1.15 } });
  return { spec: r.spec, cut: { kind: "oneshot", start: r.lead, end: r.end } };
}

// ---- hit — struck from the front: recoil, then catch the balance --------------
function hit() {
  const impact = pose({
    Spine: [-14, 0, 0], Spine1: [-6, 0, 0], Spine2: [-6, 0, 0], Neck: [-6, 0, 0], Head: [-18, 0, 0],
    RightArm: [18, 0, 62], LeftArm: [18, 0, -62], RightForeArm: [0, 25, 0], LeftForeArm: [0, -25, 0],
    RightUpLeg: [10, 0, 0], RightLeg: [15, 0, 0], LeftLeg: [12, 0, 0],
  });
  const recover = pose({
    Spine: [8, 0, 0], Head: [12, 0, 0],
    RightArm: [-12, 0, 70], LeftArm: [-12, 0, -70], RightForeArm: [0, 30, 0], LeftForeArm: [0, -30, 0],
    RightLeg: [20, 0, 0], LeftLeg: [20, 0, 0], RightUpLeg: [-6, 0, 0], LeftUpLeg: [-10, 0, 0],
    RightFoot: [-10, 0, 0], LeftFoot: [-10, 0, 0],
  });
  const r = oneShot([
    { t: 0.12, pose: impact, root: [0, -0.02, -0.06], ease: "out" },
    { t: 0.3, pose: recover, root: [0, -0.04, -0.04] },
    { t: 0.85, pose: pose(), root: [0, 0, 0] },
  ]);
  return { spec: r.spec, cut: { kind: "oneshot", start: r.lead, end: r.end } };
}

// ---- death — recoil, clutch, knees give, fall forward, lie still ---------------
function death() {
  const recoil = pose({
    Spine: [-10, 0, 0], Spine2: [-8, 0, 0], Head: [-15, 0, 0],
    RightArm: [15, 0, 68], LeftArm: [15, 0, -68],
  });
  const clutch = pose({
    RightArm: [-40, 25, 60], RightForeArm: [0, 120, 0], LeftArm: [-10, 0, -72], LeftForeArm: [0, -25, 0],
    Spine: [20, 0, 0], Head: [20, 0, 0],
    RightUpLeg: [-20, 0, 0], RightLeg: [35, 0, 0], RightFoot: [-15, 0, 0],
    LeftUpLeg: [-20, 0, 0], LeftLeg: [35, 0, 0], LeftFoot: [-15, 0, 0],
  });
  const kneel = pose({
    RightArm: [-10, 0, 72], LeftArm: [-10, 0, -72], RightForeArm: [0, 20, 0], LeftForeArm: [0, -20, 0],
    Spine: [25, 0, 0], Head: [25, 0, 0],
    RightUpLeg: [-10, 0, 0], RightLeg: [100, 0, 0], RightFoot: [40, 0, 0],
    LeftUpLeg: [-10, 0, 0], LeftLeg: [100, 0, 0], LeftFoot: [40, 0, 0],
  });
  const falling = pose({
    Hips: [55, 0, 0],
    RightArm: [-70, 0, 70], LeftArm: [-70, 0, -70], RightForeArm: [0, 30, 0], LeftForeArm: [0, -30, 0],
    Spine: [10, 0, 0], Head: [-10, 0, 0],
    RightUpLeg: [-45, 0, 0], RightLeg: [95, 0, 0], RightFoot: [40, 0, 0],
    LeftUpLeg: [-45, 0, 0], LeftLeg: [95, 0, 0], LeftFoot: [40, 0, 0],
  });
  const prone = pose({
    Hips: [88, 0, 0],
    // one arm reaching past the head, one along the side
    RightArm: [-85, 0, 60], LeftArm: [5, 0, -80], RightForeArm: [0, 40, 0], LeftForeArm: [0, -15, 0],
    Spine: [0, 0, 0], Neck: [-10, 0, 0], Head: [-5, 60, 0],
    RightUpLeg: [-5, 0, 0], RightLeg: [10, 0, 0], RightFoot: [40, 0, 0],
    LeftUpLeg: [-15, 0, 0], LeftLeg: [25, 0, 0], LeftFoot: [40, 0, 0],
  });
  const r = oneShot([
    { t: 0.25, pose: recoil, root: [0, -0.01, -0.05], ease: "out" },
    { t: 0.6, pose: clutch, root: [0, -0.08, -0.02] },
    { t: 1.1, pose: kneel, root: [0, -0.45, 0.05], ease: "in" },
    { t: 1.6, pose: falling, root: [0, -0.6, 0.25] },
    { t: 2.1, pose: prone, root: [0, -0.82, 0.55], ease: "in" },
    { t: 2.6, pose: prone, root: [0, -0.83, 0.55] },
  ], { camera: { azimuth: 65, elevation: 10 } });
  return { spec: r.spec, cut: { kind: "hold", start: r.lead, end: r.end, keepRoot: true } };
}

// ---- jump_start — crouch, drive the arms, extend, take off, tuck ---------------
const AIR = pose({
  RightUpLeg: [-45, 0, 0], RightLeg: [70, 0, 0], RightFoot: [10, 0, 0],
  LeftUpLeg: [-45, 0, 0], LeftLeg: [70, 0, 0], LeftFoot: [10, 0, 0],
  RightArm: [-60, 0, 60], LeftArm: [-60, 0, -60], RightForeArm: [0, 30, 0], LeftForeArm: [0, -30, 0],
  Spine: [10, 0, 0],
});
function jumpStart() {
  const crouch = pose({
    RightUpLeg: [-55, 0, 0], RightLeg: [85, 0, 0], RightFoot: [-30, 0, 0],
    LeftUpLeg: [-55, 0, 0], LeftLeg: [85, 0, 0], LeftFoot: [-30, 0, 0],
    Spine: [25, 0, 0], Head: [-15, 0, 0],
    RightArm: [40, 0, 70], LeftArm: [40, 0, -70], RightForeArm: [0, 10, 0], LeftForeArm: [0, -10, 0],
  });
  const extend = pose({
    RightUpLeg: [5, 0, 0], RightLeg: [0, 0, 0], RightFoot: [35, 0, 0],
    LeftUpLeg: [5, 0, 0], LeftLeg: [0, 0, 0], LeftFoot: [35, 0, 0],
    Spine: [0, 0, 0], Head: [-5, 0, 0],
    ...both({ RightArm: [-95, 0, 60], RightForeArm: [0, 15, 0], RightShoulder: [0, 0, -10] }),
  });
  const r = oneShot([
    { t: 0.32, pose: crouch, root: [0, -0.22, -0.02] },
    { t: 0.5, pose: extend, root: [0, 0.05, 0], ease: "out" },
    { t: 0.62, pose: { ...extend, RightFoot: [40, 0, 0], LeftFoot: [40, 0, 0] }, root: [0, 0.3, 0] },
    { t: 1.0, pose: AIR, root: [0, 0.4, 0] },
  ], { camera: { azimuth: 25, elevation: 6, distance: 5.6, target: 1.15 } });
  // The engine flies the arc; the clip keeps the crouch dip but never rises.
  return { spec: r.spec, cut: { kind: "oneshot", start: r.lead, end: r.end, noRise: true } };
}

// ---- jump_land — from the air: reach, touch down, absorb, stand ----------------
function jumpLand() {
  const touch = pose({
    RightUpLeg: [-15, 0, 0], RightLeg: [20, 0, 0], RightFoot: [15, 0, 0],
    LeftUpLeg: [-15, 0, 0], LeftLeg: [20, 0, 0], LeftFoot: [15, 0, 0],
    RightArm: [-30, 0, 45], LeftArm: [-30, 0, -45], RightForeArm: [0, 20, 0], LeftForeArm: [0, -20, 0],
    Spine: [6, 0, 0],
  });
  const absorb = pose({
    RightUpLeg: [-50, 0, 0], RightLeg: [80, 0, 0], RightFoot: [-30, 0, 0],
    LeftUpLeg: [-50, 0, 0], LeftLeg: [80, 0, 0], LeftFoot: [-30, 0, 0],
    Spine: [22, 0, 0], Head: [-12, 0, 0],
    RightArm: [-40, 0, 60], LeftArm: [-40, 0, -60], RightForeArm: [0, 30, 0], LeftForeArm: [0, -30, 0],
  });
  const kf = [
    { t: 0, pose: AIR, root: [0, 0.35, 0] },
    { t: 0.22, pose: touch, root: [0, 0, 0], ease: "in" },
    { t: 0.45, pose: absorb, root: [0, -0.2, 0], ease: "out" },
    { t: 1.0, pose: pose(), root: [0, 0, 0] },
    { t: 1.3, pose: pose(), root: [0, 0, 0] },
  ];
  const duration = 1.3;
  // Starts IN THE AIR (no stand lead-in); the game clip starts at touchdown.
  return { spec: spec(timeline(kf, duration), duration, { camera: { azimuth: 25, elevation: 6, distance: 5.6, target: 1.15 } }), cut: { kind: "oneshot", start: 0.2, end: 1.0, noRise: true, alignEnd: true } };
}

export const CLIPS = {
  idle, walk, run, cast, cast_e: castE, cast_r: castR, cast_f: castF, hit, death,
  jump_start: jumpStart, jump_land: jumpLand,
};
export { FPS };
