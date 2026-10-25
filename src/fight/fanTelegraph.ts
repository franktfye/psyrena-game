/**
 * Ground fan telegraphs (FightHooks.bossFan) — the boss's one dodgeable attack.
 *
 * A wedge on the floor, centred on the boss and opening toward one hero. It is
 * aimed ONCE, when the cast starts, and never tracks: that is what makes it a
 * dodge. Three layers, all flat unlit decals painted once into canvas textures
 * (CLAUDE.md rules 4–5: no glow layer, no post, nothing per-frame but scaling
 * and visibility):
 *
 *   bed   the whole danger zone — a dim bed, claw streaks raking out from the
 *         boss, a dashed rune ring and a hard rim at the reach;
 *   fill  the same wedge scaled from the boss outward over the windup, with a
 *         hot leading edge: the wedge "fills up", and when it is full it lands.
 *         The timer is the shape — no number to read mid-fight;
 *   rails the two side edges, lit, so the safe line is crisp at a glance.
 *
 * The last 0.35 s the bed flickers; on landing the wedge flashes and fades.
 * The last phase's wide sweep (`wide`) wears ember red with a white-hot edge
 * instead of the void violet, so "this one is bigger" reads before its size does.
 *
 * Hit test: the scene asks `inside(pos)` at the landing, for its own hero
 * only, and reports through the driver. A body's radius counts for the fan,
 * never for the dodge — standing on the line is standing in it.
 */
import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import type { BossFanView } from "@shared/fight/bossFight";

/** Hero body radius for the hit test, metres. */
const BODY_R = 0.4;
/** Point-blank: this close to the boss's centre, every angle is "in". */
const POINT_BLANK_R = 1.1;
const FLICKER_S = 0.35;
const FLASH_S = 0.4;
const FLOOR_Y = 0.05;

interface Live {
  view: BossFanView;
  root: TransformNode;
  bed: Mesh;
  fill: Mesh;
  rails: Mesh[];
  flash: Mesh;
  yaw: number;
  t: number;
  landed: boolean;
  onLand: (inside: (p: Vector3) => boolean) => void;
}

export interface FanTelegraphs {
  /** Start a telegraph aimed from `centre` at `aim`; `onLand` runs once, at the landing. */
  cast(view: BossFanView, centre: Vector3, aim: Vector3, onLand: (inside: (p: Vector3) => boolean) => void): void;
  tick(dt: number): void;
  dispose(): void;
}

/** Unit-radius wedge in the XZ plane, opening along +Z; UVs planar over the full disc. */
function wedge(name: string, scene: Scene, halfRad: number): Mesh {
  const segs = Math.max(8, Math.ceil((halfRad * 2) / (Math.PI / 48)));
  const pos = [0, 0, 0];
  const uv = [0.5, 0.5];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = -halfRad + (2 * halfRad * i) / segs;
    const x = Math.sin(a);
    const z = Math.cos(a);
    pos.push(x, 0, z);
    uv.push(0.5 + x / 2, 0.5 + z / 2);
    if (i > 0) idx.push(0, i, i + 1);
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(pos, idx, normals);
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.uvs = uv;
  vd.normals = normals;
  const m = new Mesh(name, scene);
  vd.applyToMesh(m);
  m.isPickable = false;
  return m;
}

export function createFanTelegraphs(scene: Scene): FanTelegraphs {
  const tex = (name: string, draw: (g: CanvasRenderingContext2D, w: number) => void): DynamicTexture => {
    const t = new DynamicTexture(name, { width: 512, height: 512 }, scene, true);
    const g = t.getContext() as unknown as CanvasRenderingContext2D;
    g.clearRect(0, 0, 512, 512);
    draw(g, 512);
    t.hasAlpha = true;
    t.update();
    return t;
  };
  const decal = (name: string, t: DynamicTexture, additive: boolean): StandardMaterial => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveTexture = t;
    m.opacityTexture = t;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.backFaceCulling = false;
    if (additive) m.alphaMode = Constants.ALPHA_ADD;
    m.zOffset = -2;
    return m;
  };

  /** The danger bed: dim gradient, claw streaks, a dashed rune ring, a hard rim. */
  const bedTex = (rgb: string, rim: string) =>
    tex(`fanBed_${rgb}`, (g, w) => {
      const c = w / 2;
      const bed = g.createRadialGradient(c, c, 0, c, c, c);
      bed.addColorStop(0, `rgba(${rgb},0.10)`);
      bed.addColorStop(0.7, `rgba(${rgb},0.22)`);
      bed.addColorStop(0.95, `rgba(${rgb},0.42)`);
      bed.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = bed;
      g.fillRect(0, 0, w, w);
      // Claw streaks raking out from the boss: long, tapered, irregular.
      g.lineCap = "round";
      for (let i = 0; i < 90; i++) {
        const a = (i / 90) * Math.PI * 2 + Math.sin(i * 7.3) * 0.02;
        const r0 = c * (0.18 + ((i * 37) % 11) / 40);
        const r1 = c * (0.62 + ((i * 53) % 13) / 40);
        const grad = g.createLinearGradient(c + Math.cos(a) * r0, c + Math.sin(a) * r0, c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        grad.addColorStop(0, `rgba(${rgb},0)`);
        grad.addColorStop(1, `rgba(${rgb},0.38)`);
        g.strokeStyle = grad;
        g.lineWidth = w * (i % 3 === 0 ? 0.006 : 0.0035);
        g.beginPath();
        g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        g.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        g.stroke();
      }
      // Dashed rune ring two-thirds out — "something is being cast".
      g.strokeStyle = `rgba(${rgb},0.55)`;
      g.lineWidth = w * 0.006;
      g.setLineDash([w * 0.03, w * 0.018]);
      g.beginPath();
      g.arc(c, c, c * 0.66, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      // The reach: a hard, glowing rim.
      g.shadowColor = rim;
      g.shadowBlur = w * 0.02;
      g.strokeStyle = rim;
      g.lineWidth = w * 0.014;
      g.beginPath();
      g.arc(c, c, c * 0.975, 0, Math.PI * 2);
      g.stroke();
    });
  /** The creeping fill: faint body, hot leading edge at its own rim. */
  const fillTex = (rgb: string, edge: string) =>
    tex(`fanFill_${rgb}`, (g, w) => {
      const c = w / 2;
      const f = g.createRadialGradient(c, c, 0, c, c, c);
      f.addColorStop(0, `rgba(${rgb},0.05)`);
      f.addColorStop(0.75, `rgba(${rgb},0.22)`);
      f.addColorStop(0.93, `rgba(${rgb},0.6)`);
      f.addColorStop(0.985, edge);
      f.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = f;
      g.fillRect(0, 0, w, w);
    });
  /** The landing flash: near-white core fading to the colour. */
  const flashTex = (rgb: string) =>
    tex(`fanFlash_${rgb}`, (g, w) => {
      const c = w / 2;
      const f = g.createRadialGradient(c, c, 0, c, c, c);
      f.addColorStop(0, "rgba(255,240,235,0.85)");
      f.addColorStop(0.5, `rgba(${rgb},0.75)`);
      f.addColorStop(1, `rgba(${rgb},0.25)`);
      g.fillStyle = f;
      g.fillRect(0, 0, w, w);
    });

  // Dread Sweep: void violet with a crimson rim. Night Terror: ember with white heat.
  const looks = {
    dread: {
      bed: decal("fanBedMat", bedTex("150,60,230", "rgba(255,70,110,0.95)"), false),
      fill: decal("fanFillMat", fillTex("200,70,255", "rgba(255,120,170,0.95)"), true),
      flash: decal("fanFlashMat", flashTex("190,80,255"), true),
      rail: new Color3(1, 0.35, 0.55),
    },
    terror: {
      bed: decal("fanBedMatW", bedTex("230,50,30", "rgba(255,225,190,1)"), false),
      fill: decal("fanFillMatW", fillTex("255,90,40", "rgba(255,240,215,1)"), true),
      flash: decal("fanFlashMatW", flashTex("255,110,50"), true),
      rail: new Color3(1, 0.8, 0.6),
    },
  };
  const railMats = new Map<string, StandardMaterial>();
  const railMat = (key: "dread" | "terror"): StandardMaterial => {
    let m = railMats.get(key);
    if (!m) {
      m = new StandardMaterial(`fanRail_${key}`, scene);
      m.disableLighting = true;
      m.emissiveColor = looks[key].rail;
      m.alphaMode = Constants.ALPHA_ADD;
      m.alpha = 0.85;
      m.backFaceCulling = false;
      m.zOffset = -3;
      railMats.set(key, m);
    }
    return m;
  };

  const live: Live[] = [];

  const drop = (f: Live): void => {
    f.root.dispose(false, false); // children go with it; materials are shared
  };

  return {
    cast(view, centre, aim, onLand) {
      const half = (view.halfAngleDeg * Math.PI) / 180;
      const look = view.wide ? looks.terror : looks.dread;
      const yaw = Math.atan2(aim.x - centre.x, aim.z - centre.z);
      const root = new TransformNode(`fan_${view.id}`, scene);
      root.position.set(centre.x, FLOOR_Y, centre.z);
      root.rotation.y = yaw;

      const bed = wedge(`fanBed_${view.id}`, scene, half);
      bed.material = look.bed;
      bed.parent = root;
      bed.scaling.set(view.radiusM, 1, view.radiusM);

      const fill = wedge(`fanFill_${view.id}`, scene, half);
      fill.material = look.fill;
      fill.parent = root;
      fill.position.y = 0.01;
      fill.scaling.set(0.02, 1, 0.02);

      const flash = wedge(`fanFlash_${view.id}`, scene, half);
      flash.material = look.flash;
      flash.parent = root;
      flash.position.y = 0.02;
      flash.scaling.set(view.radiusM, 1, view.radiusM);
      flash.visibility = 0;

      const rails: Mesh[] = [];
      for (const side of [-1, 1]) {
        const r = MeshBuilder.CreatePlane(`fanRail_${view.id}_${side}`, { width: 0.16, height: view.radiusM }, scene);
        r.material = railMat(view.wide ? "terror" : "dread");
        r.isPickable = false;
        r.parent = root;
        r.rotation.set(Math.PI / 2, side * half, 0);
        // Plane's centre sits half the reach out along its own edge.
        r.position.set(Math.sin(side * half) * view.radiusM * 0.5, 0.015, Math.cos(side * half) * view.radiusM * 0.5);
        rails.push(r);
      }
      live.push({ view, root, bed, fill, rails, flash, yaw, t: 0, landed: false, onLand });
    },

    tick(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const f = live[i]!;
        f.t += dt;
        const w = f.view.windupS;
        if (!f.landed) {
          const k = Math.min(1, f.t / w);
          // Ease-in: the creep starts slow and rushes the last stretch — the
          // "now!" is felt, not just read.
          const s = Math.max(0.02, k * k * 0.35 + k * 0.65) * f.view.radiusM;
          f.fill.scaling.set(s, 1, s);
          const left = w - f.t;
          f.bed.visibility = left < FLICKER_S ? 0.65 + 0.35 * Math.abs(Math.sin(f.t * 40)) : Math.min(1, f.t * 6);
          for (const r of f.rails) r.visibility = f.bed.visibility;
          if (f.t >= w) {
            f.landed = true;
            const { yaw, view } = f;
            const cx = f.root.position.x;
            const cz = f.root.position.z;
            const half = (view.halfAngleDeg * Math.PI) / 180;
            f.onLand((p) => {
              const dx = p.x - cx;
              const dz = p.z - cz;
              const d = Math.hypot(dx, dz);
              if (d > view.radiusM + BODY_R) return false;
              if (d < POINT_BLANK_R) return true;
              let a = Math.atan2(dx, dz) - yaw;
              a = Math.atan2(Math.sin(a), Math.cos(a));
              return Math.abs(a) <= half + Math.atan2(BODY_R, d);
            });
          }
          continue;
        }
        // Landed: flash up hard, then everything fades together.
        const k = (f.t - w) / FLASH_S;
        f.flash.visibility = k < 0.15 ? k / 0.15 : Math.max(0, 1 - (k - 0.15) / 0.85);
        f.flash.scaling.set(f.view.radiusM * (1 + k * 0.04), 1, f.view.radiusM * (1 + k * 0.04));
        const fade = Math.max(0, 1 - k);
        f.bed.visibility = fade;
        f.fill.visibility = fade;
        for (const r of f.rails) r.visibility = fade;
        if (k >= 1) {
          drop(f);
          live.splice(i, 1);
        }
      }
    },

    dispose() {
      for (const f of live) drop(f);
      live.length = 0;
    },
  };
}
