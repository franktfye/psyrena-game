/**
 * Rebuild the Freud figure's surfaces from the encoded stream that ships inside this bundle.
 *
 * WHY THIS EXISTS. The demo must not fetch a `.glb` or `.bin` at runtime, and writing the contoured
 * surfaces out as TypeScript numbers is not an option -- hundreds of thousands of vertices come to
 * tens of megabytes of source -- so the question was what in that data is actually information.
 *
 * MOST OF IT IS NOT. The surfaces were contoured with Surface Nets, which places exactly one vertex
 * per sign-changing voxel cell and emits one quad per sign-changing grid edge. Two consequences, both
 * verified against this figure's own data before any of this was used:
 *
 *   the INDEX BUFFER is derivable from cell adjacency
 *   the NORMALS are derivable from the rebuilt triangles
 *
 * What is left is the cell list, the sub-cell offsets and the colours, encoded at roughly 8 bytes per
 * vertex -- small enough to sit in a module.
 *
 * The stream layout, per node, in this order:
 *
 *   cells       varint deltas of the linear cell index, ascending. Sorted deltas are almost always 1,
 *               which is what gets a 5-byte coordinate down to a single byte.
 *   offsets     the position inside the cell, 8 bits per axis. A cell is millimetre-scale, so a step
 *               is microns -- orders finer than the cell, which is the real resolution limit.
 *   colours     8 bits per channel, in the linear working space, exactly as baked.
 *   edges       two bytes per cell, four bits per axis: whether the grid edge leaving it changes sign,
 *               whether the quad winds the other way, and which corner the split starts from. This is
 *               what replaces the index buffer.
 *   exceptions  a varint count, then four vertex indices per quad, for the handful the reduction
 *               cannot express; carrying them verbatim is what makes the rebuild exact rather than
 *               nearly exact.
 *
 * The grid origin is recovered from the builder's own rule, `lo = cloud_min - 5*cell`, carried in each
 * node's metadata. Normals are not carried -- recompute them from the rebuilt triangles.
 */
export type EncodedSurfaceMaterial = {
  materialIndex: number;
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  doubleSided: boolean;
  alphaMode: string;
  alphaCutoff: number;
  emissiveFactor: [number, number, number];
  normalScale: number;
  occlusionStrength: number;
  hasBaseColorTexture: boolean;
  hasMetallicRoughnessTexture: boolean;
  hasNormalTexture: boolean;
  hasOcclusionTexture: boolean;
  hasEmissiveTexture: boolean;
  roughnessMedian: number;
  roughnessP25: number;
  roughnessP75: number;
  metalnessMedian: number;
  metalnessP25: number;
  metalnessP75: number;
  surfaceColourEncoding: string;
};

export type EncodedNode = {
  node: number;
  region: string;
  material?: EncodedSurfaceMaterial | null;
  cellMillimetres: number;
  vertexCount: number;
  origin: [number, number, number];
  dims: [number, number, number];
  bytes: { cells: number; offsets: number; colours: number; edges: number; exceptions: number };
  exceptionQuads: number;
};

export type DecodedSurface = {
  node: number;
  region: string;
  material: EncodedSurfaceMaterial | null;
  cellMillimetres: number;
  position: Float32Array;
  colour: Uint8Array;
  index: Uint32Array;
};

/** The four cells around a grid edge, per axis, in the order the builder wound them. */
const QUAD_NEIGHBOURS: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[0, -1, -1], [0, 0, -1], [0, 0, 0], [0, -1, 0]],
  [[-1, 0, -1], [-1, 0, 0], [0, 0, 0], [0, 0, -1]],
  [[-1, -1, 0], [0, -1, 0], [0, 0, 0], [-1, 0, 0]],
];

function decodeBase64(text: string): Uint8Array {
  if (typeof atob === 'function') {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }
  // Node, for the verification scripts. Buffer is not typed here and is not used in the browser path.
  const buffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (!buffer) throw new Error('no base64 decoder available');
  return buffer.from(text, 'base64');
}

export function decodeSurfaces(base64: string, nodes: readonly EncodedNode[]): DecodedSurface[] {
  const stream = decodeBase64(base64);
  let at = 0;
  // The cursor walks one shared stream across all nodes, so a single miscounted section would
  // silently shift every node after it. Checked at the end against the stream length: see below.
  const readVarint = (): number => {
    let value = 0; let shift = 1;
    for (;;) {
      const byte = stream[at]; at += 1;
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return value;
      shift *= 128;
    }
  };

  const surfaces = nodes.map((meta) => {
    const n = meta.vertexCount;
    const cell = meta.cellMillimetres / 1000;
    const [dx, dy, dz] = meta.dims;

    // Cells first: the linear index is (i * dy + j) * dz + k, so the coordinates come back out of it.
    const cellsAt = at;
    const linear = new Float64Array(n);
    let previous = 0;
    for (let i = 0; i < n; i += 1) {
      // Zigzag: the source order is kept rather than sorted, and the collision search can step a
      // vertex backwards, so the delta is signed. Encoding it unsigned made -1 into 255, a continuation
      // byte that read past the section and drifted every node after it.
      const raw = readVarint();
      previous += raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
      linear[i] = previous;
    }
    // PER-NODE, not just per-stream. A varint run that reads one byte too few would shift every later
    // node, and a total-length check at the end can only say that something drifted, not where. The
    // encoder records each section's size, so each one is checked as it is consumed.
    if (at - cellsAt !== meta.bytes.cells) {
      throw new Error(`node ${meta.node}: cell section ${at - cellsAt} bytes, expected ${meta.bytes.cells}`);
    }
    if (meta.bytes.offsets !== n * 3 || meta.bytes.colours !== n * 3 || meta.bytes.edges !== n * 2) {
      throw new Error(`node ${meta.node}: section sizes disagree with the vertex count`);
    }
    const offsets = stream.subarray(at, at + n * 3); at += n * 3;
    const colour = stream.slice(at, at + n * 3); at += n * 3;
    // Two bytes per cell, little-endian: four bits per axis, holding whether the edge exists, whether
    // the winding is reversed, and WHICH CORNER the split starts from. The last one is not cosmetic --
    // rotating the corners cuts the other diagonal, and a Surface Nets quad is rarely planar.
    const edgeLo = stream.subarray(at, at + n * 2); at += n * 2;

    const position = new Float32Array(n * 3);
    // Linear index -> vertex, for the adjacency lookups that rebuild the quads.
    const vertexAt = new Map<number, number>();
    for (let i = 0; i < n; i += 1) {
      const value = linear[i];
      const k = value % dz;
      const j = Math.floor(value / dz) % dy;
      const iCell = Math.floor(value / (dz * dy));
      position[3 * i] = meta.origin[0] + (iCell + offsets[3 * i] / 255) * cell;
      position[3 * i + 1] = meta.origin[1] + (j + offsets[3 * i + 1] / 255) * cell;
      position[3 * i + 2] = meta.origin[2] + (k + offsets[3 * i + 2] / 255) * cell;
      vertexAt.set(value, i);
    }

    // Quads from the edge bits. Each set bit names one grid edge, and the four cells around it are the
    // quad's corners -- so the index buffer is rebuilt rather than stored.
    const indices: number[] = [];
    const pushQuad = (corner: number[], reversed: boolean, rotation: number): void => {
      const seq = reversed ? [...corner].reverse() : corner;
      const q = [seq[rotation], seq[(rotation + 1) % 4], seq[(rotation + 2) % 4], seq[(rotation + 3) % 4]];
      indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    };
    for (let i = 0; i < n; i += 1) {
      const bits = edgeLo[2 * i] | (edgeLo[2 * i + 1] << 8);
      if (bits === 0) continue;
      const value = linear[i];
      const k = value % dz;
      const j = Math.floor(value / dz) % dy;
      const iCell = Math.floor(value / (dz * dy));
      for (let axis = 0; axis < 3; axis += 1) {
        const nibble = (bits >> (4 * axis)) & 0xf;
        if ((nibble & 1) === 0) continue;
        const corner: number[] = [];
        let complete = true;
        for (const [di, dj, dk] of QUAD_NEIGHBOURS[axis]) {
          const ni = iCell + di; const nj = j + dj; const nk = k + dk;
          // RANGE-CHECK BEFORE PACKING. A negative j or k does not produce an out-of-range linear index,
          // it wraps into a DIFFERENT valid cell -- (i, -1, k) packs to the same number as
          // (i - 1, dy - 1, k) -- and if that cell happens to be active the quad silently joins the
          // wrong vertices. Without this the rebuilt mesh rendered with flakes and holes across the
          // whole figure while every count still matched.
          if (nj < 0 || nj >= dy || nk < 0 || nk >= dz || ni < 0 || ni >= dx) { complete = false; break; }
          const found = vertexAt.get((ni * dy + nj) * dz + nk);
          if (found === undefined) { complete = false; break; }
          corner.push(found);
        }
        if (!complete) continue;
        pushQuad(corner, (nibble & 2) !== 0, nibble >> 2);
      }
    }

    const exceptionsAt = at;
    const exceptionCount = readVarint();
    for (let q = 0; q < exceptionCount; q += 1) {
      const a = readVarint(); const b = readVarint(); const c = readVarint(); const d = readVarint();
      pushQuad([a, b, c, d], false, 0);
    }
    if (at - exceptionsAt !== meta.bytes.exceptions) {
      throw new Error(`node ${meta.node}: exception section ${at - exceptionsAt} bytes, `
        + `expected ${meta.bytes.exceptions}`);
    }
    if (exceptionCount !== meta.exceptionQuads) {
      throw new Error(`node ${meta.node}: ${exceptionCount} exception quads, expected ${meta.exceptionQuads}`);
    }

    return {
      node: meta.node,
      region: meta.region,
      material: meta.material ?? null,
      cellMillimetres: meta.cellMillimetres,
      position,
      colour,
      index: new Uint32Array(indices),
    };
  });
  // EXACTLY consumed, not approximately. Any drift in a varint run, a section length or the exception
  // list would leave the cursor short or long, and every node after the drift would decode from the
  // wrong offset -- which reads as geometry, not as an error.
  if (at !== stream.length) {
    throw new Error(`encoded surfaces: consumed ${at} of ${stream.length} bytes`);
  }
  return surfaces;
}
