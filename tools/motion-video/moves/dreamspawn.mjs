// Survival-mode monster clip set ("dream-spawn"), shared by every rigged
// minion, elite and boss (docs/survival-design.md §10). Four clips only:
// idle / walk loops, attack (one-shot) and death (held). In place: the
// survival engine owns translation, and enemies walk slower than heroes, so the
// walk is a short, heavy, hunched stride. The m2mr result is extracted once on
// Y Bot and retargeted onto each creature rig with `--skeleton`.
//
// Each entry: spec(...) for render.mjs + `cut` for finish-clips.mjs.

import { pose, periodic, cyclic, timeline, spec } from "./lib.mjs";

const PI2 = Math.PI * 2;
const THIGH = 0.43, SHIN = 0.43, LEG = THIGH + SHIN;
const rad = (d) => (d * Math.PI) / 180;
const reach = (hipFlex, knee) => THIGH * Math.cos(rad(hipFlex)) + SHIN * Math.cos(rad(hipFlex - knee));

/** The predator stance every clip starts from: hunched, head up, arms hanging forward, knees soft. */
const HUNCH = {
  Spine: [10, 0, 0], Spine1: [6, 0, 0], Spine2: [4, 0, 0], Neck: [-6, 0, 0], Head: [-10, 0, 0],
  RightArm: [-18, 0, 74], LeftArm: [-18, 0, -74],
  RightForeArm: [0, 28, 0], LeftForeArm: [0, -28, 0],
  RightUpLeg: [-8, 0, 0], LeftUpLeg: [-8, 0, 0], RightLeg: [14, 0, 0], LeftLeg: [14, 0, 0],
  RightFoot: [-6, 0, 0], LeftFoot: [-6, 0, 0],
};
const HUNCH_DROP = reach(8, 14) - LEG;

const LEAD = 0.25, TAIL = 0.35;
function oneShot(kf, extra = {}) {
  const start = pose(HUNCH);
  const end = kf.at(-1).t;
  const shifted = [{ t: 0, pose: start, root: [0, HUNCH_DROP, 0] }, ...kf.map((k) => ({ ...k, t: k.t + LEAD })), { t: end + LEAD + TAIL, pose: kf.at(-1).pose, root: kf.at(-1).root }];
  const duration = end + LEAD + TAIL;
  return { spec: spec(timeline(shifted, duration), duration, extra), lead: LEAD, end: end + LEAD };
}

// ---- idle: slow heavy breathing, a predatory sway and a twitch of the head ------
function idle() {
  const T = 4;
  const c = cyclic((p) => {
    const br = Math.sin(PI2 * p * 2);
    const sway = Math.sin(PI2 * p);
    const twitch = Math.max(0, Math.sin(PI2 * (p - 0.6) * 4)) * (p > 0.6 && p < 0.725 ? 1 : 0);
    return {
      pose: {
        ...HUNCH,
        Spine: [10 + 2 * br, 0, 2 * sway], Spine1: [6 - 1.5 * br, 0, 0], Spine2: [4 - 1.5 * br, 3 * sway, 0],
        Head: [-10 + 3 * br, -6 * sway + 14 * twitch, 4 * twitch],
        RightShoulder: [0, 0, -2 * br], LeftShoulder: [0, 0, 2 * br],
        RightArm: [-18 + 4 * sway, 0, 74], LeftArm: [-18 - 4 * sway, 0, -74],
        RightForeArm: [0, 28 + 6 * br, 0], LeftForeArm: [0, -(28 + 6 * br), 0],
        Hips: [0, 0, 2 * sway],
      },
      root: [0.02 * sway, HUNCH_DROP - 0.006 * br, 0],
    };
  }, T, 2);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T } };
}

// ---- walk: a slow, heavy, lurching stride; phase 0 = right heel strike ----------
function walk() {
  const T = 1.5;
  const hip = periodic([[0, 22], [0.12, 20], [0.3, 6], [0.5, -6], [0.62, -2], [0.75, 18], [0.87, 24]]);
  const knee = periodic([[0, 14], [0.12, 24], [0.3, 16], [0.5, 18], [0.62, 42], [0.72, 55], [0.87, 24]]);
  const dorsi = periodic([[0, 0], [0.08, -6], [0.3, 6], [0.5, 10], [0.62, -12], [0.75, 2], [0.87, 0]]);
  const leg = (p) => ({ h: hip(p), k: Math.max(0, knee(p)), a: dorsi(p) });
  const c = cyclic((p) => {
    const R = leg(p), L = leg(p + 0.5);
    const cw = Math.cos(PI2 * p), sw = Math.sin(PI2 * p);
    const bob = Math.max(reach(R.h, R.k), reach(L.h, L.k)) - LEG;
    return {
      pose: {
        Hips: [0, 6 * cw, -5 * sw],                          // heavy lurch onto each stance leg
        Spine: [12, 0, 4 * sw], Spine1: [6, 0, 0], Spine2: [4, -5 * cw, 0],
        Neck: [-6, 0, 0], Head: [-10, 3 * cw, -3 * sw],
        RightUpLeg: [-R.h, 0, 0], RightLeg: [R.k, 0, 0], RightFoot: [-R.a, 0, 0],
        LeftUpLeg: [-L.h, 0, 0], LeftLeg: [L.k, 0, 0], LeftFoot: [-L.a, 0, 0],
        RightArm: [-22 + 10 * cw, 0, 72], LeftArm: [-22 - 10 * cw, 0, -72],   // arms hang forward, swing a little
        RightForeArm: [0, 30 - 6 * cw, 0], LeftForeArm: [0, -(30 + 6 * cw), 0],
      },
      root: [-0.04 * sw, bob, 0],
    };
  }, T, 4);
  return { spec: spec(c, c.duration), cut: { kind: "loop", period: T, start: T * 2 } };
}

// ---- attack: rear up with both claws, slam down, recover ----------------------
function attack() {
  const rear = pose({
    Spine: [-12, 0, 0], Spine1: [-6, 0, 0], Spine2: [-4, 0, 0], Neck: [-4, 0, 0], Head: [-6, 0, 0],
    RightArm: [-35, 0, -55], LeftArm: [-35, 0, 55],         // both arms raised overhead (z raises from the T)
    RightForeArm: [0, 40, 0], LeftForeArm: [0, -40, 0],
    RightHand: [0, 0, -20], LeftHand: [0, 0, 20],
    RightUpLeg: [4, 0, 0], LeftUpLeg: [-14, 0, 0], RightLeg: [8, 0, 0], LeftLeg: [10, 0, 0],
  });
  const slam = pose({
    Spine: [30, 0, 0], Spine1: [12, 0, 0], Spine2: [8, 0, 0], Neck: [-14, 0, 0], Head: [-14, 0, 0],
    RightArm: [-88, 0, 80], LeftArm: [-88, 0, -80],          // claws driven forward and down in front
    RightForeArm: [0, 10, 0], LeftForeArm: [0, -10, 0],
    RightHand: [0, 0, 20], LeftHand: [0, 0, -20],
    RightUpLeg: [-6, 0, 0], LeftUpLeg: [-32, 0, 0], RightLeg: [24, 0, 0], LeftLeg: [36, 0, 0],
    LeftFoot: [-10, 0, 0],
  });
  const r = oneShot([
    { t: 0.45, pose: rear, root: [0, HUNCH_DROP + 0.03, -0.04] },
    { t: 0.62, pose: slam, root: [0, HUNCH_DROP - 0.12, 0.12], ease: "out" },
    { t: 0.85, pose: slam, root: [0, HUNCH_DROP - 0.12, 0.12] },
    { t: 1.35, pose: pose(HUNCH), root: [0, HUNCH_DROP, 0] },
  ]);
  return { spec: r.spec, cut: { kind: "oneshot", start: r.lead, end: r.end } };
}

// ---- death: rear back, knees buckle, collapse forward, lie still ------------------
function death() {
  const recoil = pose({
    Spine: [-16, 0, 0], Spine1: [-6, 0, 0], Spine2: [-6, 0, 0], Head: [-22, 0, 0],
    RightArm: [-30, 0, 55], LeftArm: [-30, 0, -55], RightForeArm: [0, 50, 0], LeftForeArm: [0, -50, 0],
  });
  const kneel = pose({
    RightArm: [-10, 0, 72], LeftArm: [-10, 0, -72], RightForeArm: [0, 20, 0], LeftForeArm: [0, -20, 0],
    Spine: [28, 0, 0], Head: [20, 0, 0],
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
    RightArm: [-60, 0, 70], LeftArm: [-60, 0, -70], RightForeArm: [0, 30, 0], LeftForeArm: [0, -30, 0],
    Spine: [0, 0, 0], Neck: [-10, 0, 0], Head: [-5, -60, 0],
    RightUpLeg: [-5, 0, 0], RightLeg: [10, 0, 0], RightFoot: [40, 0, 0],
    LeftUpLeg: [-15, 0, 0], LeftLeg: [25, 0, 0], LeftFoot: [40, 0, 0],
  });
  const r = oneShot([
    { t: 0.3, pose: recoil, root: [0, HUNCH_DROP + 0.01, -0.06], ease: "out" },
    { t: 0.9, pose: kneel, root: [0, -0.45, 0.02], ease: "in" },
    { t: 1.4, pose: falling, root: [0, -0.6, 0.25] },
    { t: 1.9, pose: prone, root: [0, -0.82, 0.55], ease: "in" },
    { t: 2.4, pose: prone, root: [0, -0.83, 0.55] },
  ], { camera: { azimuth: 65, elevation: 10 } });
  return { spec: r.spec, cut: { kind: "hold", start: r.lead, end: r.end, keepRoot: true } };
}

export const CLIPS = { idle, walk, attack, death };
