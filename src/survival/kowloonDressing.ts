/**
 * Old Kowloon floor and street dressing (docs/survival-design.md §12):
 *   - streets: the village's tiling road (asphalt) set, darkened and damp;
 *   - squares and pavements: the village paving set, a 2.2 m pavement in front
 *     of every building row, with a concrete kerb line;
 *   - road markings: dashed centre lines and a zebra crossing at the Temple
 *     Square mouth; a few puddles that catch the fog and the neon;
 *   - neon sign faces with real Chinese shop names (our text — generators
 *     write gibberish), and a warm glow on every street lamp.
 *
 * Every family is ONE merged mesh with one material (CLAUDE.md rule 4/5:
 * draw calls matter more than triangles on a phone). Paving UVs are world
 * metres / 4, so a tile is the same size on a 2 m pavement and a 34 m square.
 */
import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import type { MapDef } from "@shared/survival/map/layout";
import type { Lot } from "@shared/survival/map/lots";
import { rng } from "@shared/survival/map/lots";

const TILE_M = 4;
const WALL = "/assets/village/wall";

function tiled(scene: Scene, kind: "road" | "paving", tint: Color3, roughness: number): PBRMaterial {
  const m = new PBRMaterial(`kw_${kind}`, scene);
  m.albedoTexture = new Texture(`${WALL}/${kind}_albedo.ktx2`, scene);
  m.bumpTexture = new Texture(`${WALL}/${kind}_normal.ktx2`, scene);
  m.metallicTexture = new Texture(`${WALL}/${kind}_orm.ktx2`, scene);
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 0;
  m.roughness = roughness;
  m.albedoColor = tint;
  return m;
}

/** A flat rectangle at height y whose UVs are world metres / TILE_M. */
function rect(scene: Scene, name: string, x0: number, z0: number, x1: number, z1: number, y: number): Mesh {
  const m = MeshBuilder.CreateGround(name, { width: x1 - x0, height: z1 - z0 }, scene);
  m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  m.bakeCurrentTransformIntoVertices();
  const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / TILE_M, pos[i + 2] / TILE_M);
  m.setVerticesData(VertexBuffer.UVKind, uv);
  return m;
}

/** A rotated rectangle (centre, length along `yaw`'s right axis, depth along its forward). */
function strip(scene: Scene, name: string, cx: number, cz: number, len: number, depth: number, yaw: number, y: number): Mesh {
  const m = MeshBuilder.CreateGround(name, { width: len, height: depth }, scene);
  m.rotation.y = yaw;
  m.position.set(cx, y, cz);
  m.bakeCurrentTransformIntoVertices();
  const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / TILE_M, pos[i + 2] / TILE_M);
  m.setVerticesData(VertexBuffer.UVKind, uv);
  return m;
}

function merge(parts: Mesh[], name: string, mat: StandardMaterial | PBRMaterial): Mesh | null {
  if (!parts.length) return null;
  const m = Mesh.MergeMeshes(parts, true, true);
  if (!m) return null;
  m.name = name;
  m.material = mat;
  m.isPickable = false;
  m.freezeWorldMatrix();
  return m;
}

export function buildKowloonFloor(scene: Scene, map: MapDef, lots: Lot[], ground: Mesh): void {
  // Streets: the whole ground plane, asphalt.
  const road = tiled(scene, "road", new Color3(0.42, 0.43, 0.45), 0.5);
  for (const t of [road.albedoTexture, road.bumpTexture, road.metallicTexture] as Texture[]) {
    t.uScale = (map.half * 2) / TILE_M;
    t.vScale = (map.half * 2) / TILE_M;
  }
  ground.material = road;

  // Squares + pavements: paving, one mesh.
  const paving = tiled(scene, "paving", new Color3(0.62, 0.6, 0.56), 0.75);
  const pave: Mesh[] = [];
  for (const [i, sq] of map.squares.entries()) pave.push(rect(scene, `kw_sq${i}`, sq.x0, sq.z0, sq.x1, sq.z1, 0.008));
  const kerbs: Mesh[] = [];
  for (const [i, lot] of lots.entries()) {
    const fx = Math.sin(lot.yaw);
    const fz = Math.cos(lot.yaw);
    // The building face, then the pavement 2.2 m out from it.
    const faceX = lot.x + fx * (lot.depth / 2);
    const faceZ = lot.z + fz * (lot.depth / 2);
    pave.push(strip(scene, `kw_pv${i}`, faceX + fx * 1.1, faceZ + fz * 1.1, lot.len, 2.2, lot.yaw, 0.011 + (i % 3) * 0.0008));
    const k = MeshBuilder.CreateBox(`kw_kb${i}`, { width: lot.len, height: 0.1, depth: 0.22 }, scene);
    k.rotation.y = lot.yaw;
    k.position.set(faceX + fx * 2.2, 0.05, faceZ + fz * 2.2);
    k.bakeCurrentTransformIntoVertices();
    kerbs.push(k);
  }
  merge(pave, "kowloonPaving", paving);
  const kerbMat = new PBRMaterial("kw_kerb", scene);
  kerbMat.albedoColor = new Color3(0.3, 0.3, 0.29); // weathered concrete, not fresh paint
  kerbMat.roughness = 0.9;
  kerbMat.metallic = 0;
  merge(kerbs, "kowloonKerbs", kerbMat);

  // Markings: dashed centre lines on the main road and the cross street, and a
  // zebra at the Temple Square's south mouth.
  const paint = new StandardMaterial("kw_paint", scene);
  paint.diffuseColor = new Color3(0.85, 0.78, 0.45);
  paint.specularColor = new Color3(0, 0, 0);
  const marks: Mesh[] = [];
  const boss = map.squares.find((s) => s.role === "boss");
  const inBoss = (x: number, z: number) => !!boss && x > boss.x0 && x < boss.x1 && z > boss.z0 && z < boss.z1;
  for (let z = -54; z < 44; z += 4) if (!inBoss(0, z + 1)) marks.push(rect(scene, `kw_mk${marks.length}`, -0.08, z, 0.08, z + 2, 0.014));
  for (let x = -54; x < 54; x += 4) if (Math.abs(x + 1) > 8) marks.push(rect(scene, `kw_mk${marks.length}`, x, 25.92, x + 2, 26.08, 0.014));
  if (boss) {
    const zebra = new StandardMaterial("kw_zebra", scene);
    zebra.diffuseColor = new Color3(0.86, 0.86, 0.84);
    zebra.specularColor = new Color3(0, 0, 0);
    const stripes: Mesh[] = [];
    for (let x = -6.5; x < 6.5; x += 1.3) stripes.push(rect(scene, `kw_zb${stripes.length}`, x, boss.z0 - 3.2, x + 0.6, boss.z0 - 0.6, 0.014));
    merge(stripes, "kowloonZebra", zebra);
  }
  merge(marks, "kowloonMarks", paint);

  // Puddles: dark mirrors on the streets (never in the squares' fighting floor).
  const wet = new PBRMaterial("kw_puddle", scene);
  wet.albedoColor = new Color3(0.03, 0.035, 0.04);
  wet.metallic = 0.6;
  wet.roughness = 0.04;
  const rand = rng(77);
  const puddles: Mesh[] = [];
  for (let i = 0; i < 40 && puddles.length < 16; i++) {
    const s = map.streets[Math.floor(rand() * map.streets.length)];
    const x = s.x0 + 1.5 + rand() * (s.x1 - s.x0 - 3);
    const z = s.z0 + 1.5 + rand() * (s.z1 - s.z0 - 3);
    if (map.squares.some((q) => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1)) continue;
    const d = MeshBuilder.CreateDisc(`kw_pd${i}`, { radius: 0.6 + rand() * 1.4, tessellation: 18 }, scene);
    d.rotation.x = Math.PI / 2;
    d.scaling.y = 0.55 + rand() * 0.4;
    d.position.set(x, 0.016, z);
    d.bakeCurrentTransformIntoVertices();
    puddles.push(d);
  }
  merge(puddles, "kowloonPuddles", wet);
}

// ---- Neon sign faces -------------------------------------------------------------

/** Old Kowloon shop signs, vertical, traditional characters. */
const SIGNS: Array<{ text: string; color: string }> = [
  { text: "茶餐廳", color: "#ff5a6e" }, // cha chaan teng
  { text: "押", color: "#ffd166" },     // pawn
  { text: "金舖", color: "#ffcf5a" },   // gold shop
  { text: "藥行", color: "#5ff2c0" },   // herbalist
  { text: "旅館", color: "#ff7ad9" },   // guest house
  { text: "麻雀", color: "#7ab8ff" },   // mahjong
  { text: "冰室", color: "#6ee7ff" },   // ice café
  { text: "酒家", color: "#ff6a3d" },   // restaurant
  { text: "理髮", color: "#b88cff" },   // barber
  { text: "洋服", color: "#9dff6e" },   // tailor
];
const CJK_FONT = `"PingFang TC","Noto Sans CJK TC","Noto Sans TC","Microsoft JhengHei","Heiti TC",serif`;

export function createNeonSigns(scene: Scene): { place(x: number, y: number, z: number, yaw: number, i: number): void; done(): void } {
  const mats = SIGNS.map((s, i) => {
    const tex = new DynamicTexture(`kw_signtex${i}`, { width: 128, height: 384 }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = "#0b0d14";
    ctx.fillRect(0, 0, 128, 384);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, 112, 368);
    ctx.fillStyle = s.color;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 14;
    const chars = [...s.text];
    const size = Math.min(96, Math.floor(330 / chars.length));
    ctx.font = `bold ${size}px ${CJK_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    chars.forEach((c, k) => ctx.fillText(c, 64, 30 + (k + 0.5) * (330 / chars.length)));
    tex.update();
    const m = new StandardMaterial(`kw_sign${i}`, scene);
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    m.emissiveTexture = tex;
    m.disableLighting = true;
    return m;
  });
  const parts: Mesh[][] = SIGNS.map(() => []);
  return {
    place(x, y, z, yaw, i) {
      // Two faces back to back: readable from both directions down the street.
      for (const flip of [0, Math.PI]) {
        const p = MeshBuilder.CreatePlane(`kw_sg`, { width: 0.95, height: 2.85 }, scene);
        p.rotation.y = yaw + flip;
        p.position.set(x, y, z);
        p.bakeCurrentTransformIntoVertices();
        parts[i % SIGNS.length].push(p);
      }
    },
    /** Merge each sign's faces into one mesh: one draw call per shop name. */
    done() {
      for (const [i, list] of parts.entries()) if (list.length) merge(list.splice(0), `kowloonSigns${i}`, mats[i]);
    },
  };
}

/** A warm glowing head on every street lamp (one merged emissive mesh). */
export function buildLampGlows(scene: Scene, lamps: Array<{ x: number; z: number }>, headY: number): void {
  const m = new StandardMaterial("kw_lampGlow", scene);
  m.disableLighting = true;
  m.emissiveColor = new Color3(1, 0.78, 0.45);
  const parts = lamps.map((l, i) => {
    const s = MeshBuilder.CreateSphere(`kw_lg${i}`, { diameter: 0.42, segments: 6 }, scene);
    s.position.set(l.x, headY, l.z);
    s.bakeCurrentTransformIntoVertices();
    return s;
  });
  merge(parts, "kowloonLampGlows", m);
}

// ---- Border walls: old concrete, layered street spray-paint art --------------------

/**
 * The map's edge (§12.1): 6 m graffiti walls west, east and south, a 3 m
 * graffiti sea wall along the harbour so the fog over the water still shows.
 * Three texture variants (assets/work/kowloon/walls, made seamless in X),
 * panels of 12 m cycling through them: one merged mesh per variant.
 */
export function buildBorderWalls(scene: Scene, half: number): void {
  const PANEL = 12;
  const mats = [1, 2, 3].map((i) => {
    const m = new PBRMaterial(`kw_wall${i}`, scene);
    m.albedoTexture = new Texture(`/assets/survival/kowloon/walls/wall_${i}_albedo.ktx2`, scene);
    m.bumpTexture = new Texture(`/assets/survival/kowloon/walls/wall_${i}_normal.ktx2`, scene);
    m.metallic = 0;
    m.roughness = 0.95;
    m.backFaceCulling = false;
    return m;
  });
  const parts: Mesh[][] = [[], [], []];
  let k = 0;
  const run = (fixed: number, axis: "x" | "z", inward: number, height: number) => {
    const span = half * 2;
    const n = Math.ceil(span / PANEL);
    for (let i = 0; i < n; i++) {
      const len = Math.min(PANEL, span - i * PANEL);
      const c = -half + i * PANEL + len / 2;
      const p = MeshBuilder.CreatePlane(`kw_wp${k}`, { width: len, height }, scene);
      // Face the playfield. Plane front is -Z; yaw turns it toward the inside.
      if (axis === "x") { p.position.set(c, height / 2, fixed); p.rotation.y = inward > 0 ? Math.PI : 0; }
      else { p.position.set(fixed, height / 2, c); p.rotation.y = inward > 0 ? -Math.PI / 2 : Math.PI / 2; }
      p.bakeCurrentTransformIntoVertices();
      // A short panel shows the BOTTOM of the texture (the hazard stripe, the tags),
      // and a partial-length panel crops instead of squashing.
      const uv = p.getVerticesData(VertexBuffer.UVKind)!;
      const vMax = height / 6;
      const uMax = len / PANEL;
      for (let j = 0; j < uv.length; j += 2) { uv[j] *= uMax; uv[j + 1] *= vMax; }
      p.setVerticesData(VertexBuffer.UVKind, uv);
      parts[k % 3].push(p);
      k++;
    }
  };
  // 2 cm in front of the wall mass's face (which sits at ±(half + 0.05)): no z-fight.
  run(-half + 0.03, "x", 1, 6);   // south, facing +z
  run(half - 0.03, "x", -1, 3);   // north sea wall, facing -z
  run(-half + 0.03, "z", 1, 6);   // west, facing +x
  run(half - 0.03, "z", -1, 6);   // east, facing -x
  parts.forEach((list, i) => merge(list, `kowloonWalls${i}`, mats[i]));

  // Concrete coping along the top, and the dark back of the wall (thickness).
  const coping = new PBRMaterial("kw_coping", scene);
  coping.albedoColor = new Color3(0.26, 0.26, 0.25);
  coping.roughness = 1;
  coping.metallic = 0;
  const caps: Mesh[] = [];
  for (const [w, d, x, z, h] of [
    [half * 2 + 1, 0.9, 0, -half - 0.5, 6], [half * 2 + 1, 0.9, 0, half + 0.5, 3],
    [0.9, half * 2 + 1, -half - 0.5, 0, 6], [0.9, half * 2 + 1, half + 0.5, 0, 6],
  ] as const) {
    const b = MeshBuilder.CreateBox(`kw_cap${caps.length}`, { width: w, depth: d, height: h + 0.3 }, scene);
    b.position.set(x, (h + 0.3) / 2, z);
    b.bakeCurrentTransformIntoVertices();
    caps.push(b);
  }
  merge(caps, "kowloonWallMass", coping);
}
