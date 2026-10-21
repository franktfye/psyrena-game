// Motion authoring helpers for render.mjs specs.
//
// Poses are { Joint: [x, y, z] } in degrees from the T-pose, about the
// CHARACTER axes (+X the figure's left, +Y up, +Z forward), exactly as
// droid.html applies them. Clips are authored as timelines of full poses
// (one-shots) or as periodic curves over a gait phase (loops), then sampled
// densely at the clip fps so render.mjs can interpolate linearly.
//
// Axis cheat-sheet (measured on the stage, see README "Motion video"):
//   Spine/Spine1/Spine2/Neck/Head  x+ bend forward · y+ turn to the figure's left · z+ lean to its right
//   Hips      orientation of the WHOLE body (x+ pitches forward and swings the legs back)
//   UpLeg     x− lift the thigh forward (flex) · x+ extend back
//   Leg       x+ bend the knee
//   Foot      x+ point the toes (plantar) · x− toes up (dorsi)
//   R/L Arm   z± lower the arm from the T (R +, L −), then x− swings the hanging arm forward,
//             y twists the hanging arm about the vertical
//   R/L ForeArm  y bend the elbow (R +, L −)
//   R/L Shoulder z shrug (R −, L +)
//   R/L Hand  z flex the wrist (R +, L −), x roll it

export const FPS = 30;

export const JOINTS = [
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightUpLeg", "RightLeg", "RightFoot", "LeftUpLeg", "LeftLeg", "LeftFoot",
];

/** Relaxed standing: arms hanging with soft elbows, palms to the thighs. */
export const STAND = {
  RightArm: [-4, 0, 76], LeftArm: [-4, 0, -76],
  RightForeArm: [0, 12, 0], LeftForeArm: [0, -12, 0],
};

const zero = () => [0, 0, 0];
export const full = (p) => Object.fromEntries(JOINTS.map((j) => [j, [...(p[j] ?? STAND[j] ?? zero())]]));
/** A pose = STAND with overrides. */
export const pose = (over = {}) => full({ ...STAND, ...over });

/** Mirror a right-side pose description onto the left (and vice versa). */
export function mirror(p) {
  const out = {};
  for (const [j, [x, y, z]] of Object.entries(p)) {
    const m = j.startsWith("Right") ? "Left" + j.slice(5) : j.startsWith("Left") ? "Right" + j.slice(4) : j;
    // Mirroring across the sagittal plane flips rotations about Y and Z.
    out[m] = [x, -y, -z];
  }
  return out;
}

export const EASE = {
  linear: (u) => u,
  inOut: (u) => u * u * (3 - 2 * u),
  out: (u) => 1 - (1 - u) ** 3,          // explosive start, soft finish (releases, impacts)
  in: (u) => u ** 3,                      // slow start, sharp finish (gravity, collapse)
};

/**
 * One-shot timeline. kf = [{ t, pose, root?, ease? }] (ease shapes the segment
 * ENDING at that key). Returns dense { keys, root } sampled at FPS.
 */
export function timeline(kf, duration, layers = []) {
  const frames = Math.round(duration * FPS);
  const keys = Object.fromEntries(JOINTS.map((j) => [j, []]));
  const root = [];
  for (let f = 0; f <= frames; f++) {
    const t = f / FPS;
    let b = kf.findIndex((k) => k.t >= t);
    if (b < 0) b = kf.length - 1;
    const a = Math.max(0, b - 1);
    const A = kf[a], B = kf[b];
    const u = B.t === A.t ? 1 : (EASE[B.ease ?? "inOut"])(Math.min(1, Math.max(0, (t - A.t) / (B.t - A.t))));
    const extra = layers.map((L) => L(t));
    for (const j of JOINTS) {
      const v = A.pose[j].map((x, i) => x + (B.pose[j][i] - x) * u);
      for (const e of extra) if (e[j]) for (let i = 0; i < 3; i++) v[i] += e[j][i];
      keys[j].push([+t.toFixed(4), v.map((x) => +x.toFixed(2))]);
    }
    const ra = A.root ?? [0, 0, 0], rb = B.root ?? [0, 0, 0];
    const r = ra.map((x, i) => x + (rb[i] - x) * u);
    for (const e of extra) if (e.root) for (let i = 0; i < 3; i++) r[i] += e.root[i];
    root.push([+t.toFixed(4), r.map((x) => +x.toFixed(4))]);
  }
  return { keys, root };
}

/** Periodic Catmull-Rom through [phase 0..1, value] samples; returns f(phase). */
export function periodic(samples) {
  const pts = [...samples].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  return (p) => {
    p = ((p % 1) + 1) % 1;
    let i = pts.findIndex((s, k) => p >= s[0] && p < (pts[k + 1]?.[0] ?? 1 + pts[0][0]));
    if (i < 0) i = n - 1;
    const P = (k) => {
      const w = Math.floor(k / n), s = pts[((k % n) + n) % n];
      return [s[0] + w, s[1]];
    };
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const span = p2[0] - p1[0];
    let q = p;
    if (q < p1[0]) q += 1;
    const u = (q - p1[0]) / span;
    // Uniform Catmull-Rom on values, tangents scaled to the local spacing.
    const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0])) * span;
    const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0])) * span;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2;
  };
}

/**
 * Loop sampler. fn(phase) → { pose overrides as full [x,y,z] per joint, root }.
 * Renders `cycles` whole cycles of period T so m2mr sees a steady state; the
 * finished clip is one cycle cut from the middle.
 */
export function cyclic(fn, T, cycles) {
  const duration = T * cycles;
  const frames = Math.round(duration * FPS);
  const keys = Object.fromEntries(JOINTS.map((j) => [j, []]));
  const root = [];
  for (let f = 0; f <= frames; f++) {
    const t = f / FPS;
    const { pose: p, root: r } = fn((t / T) % 1, t);
    const P = full({ ...STAND, ...p });
    for (const j of JOINTS) keys[j].push([+t.toFixed(4), P[j].map((x) => +x.toFixed(2))]);
    root.push([+t.toFixed(4), (r ?? [0, 0, 0]).map((x) => +x.toFixed(4))]);
  }
  return { keys, root, duration };
}

/** Assemble a render.mjs spec. */
export function spec({ keys, root }, duration, extra = {}) {
  return {
    duration, fps: FPS, model: "soldier", base: "tpose", interp: "linear",
    camera: { azimuth: 25, elevation: 6 }, keys, root, ...extra,
  };
}
