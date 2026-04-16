import type { MeshData } from "./types";

/**
 * Split a possibly-disjoint mesh into connected components.
 *
 * STEP/3MF imports often contain many separate solids (PCB body, ICs,
 * connectors, headers...). Manifold CSG requires each input to be a single
 * watertight solid, so unioning the file as-is fails. Splitting first lets
 * us manifoldize each piece independently and union the successful ones,
 * which is enough to get clean silhouette cutouts for the parts that matter
 * (USB connectors, headers, displays, etc.).
 *
 * Vertex welding tolerance is in model units (mm).
 */
export function connectedComponents(
  positions: Float32Array,
  indices: Uint32Array,
  weldTol = 1e-4,
): MeshData[] {
  if (indices.length === 0) return [];
  const inv = 1 / weldTol;

  // Step 1: weld near-coincident verts to a canonical index.
  const remap = new Uint32Array(positions.length / 3);
  const map = new Map<string, number>();
  const welded: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = Math.round(positions[i] * inv);
    const y = Math.round(positions[i + 1] * inv);
    const z = Math.round(positions[i + 2] * inv);
    const k = `${x},${y},${z}`;
    let idx = map.get(k);
    if (idx === undefined) {
      idx = welded.length / 3;
      welded.push(positions[i], positions[i + 1], positions[i + 2]);
      map.set(k, idx);
    }
    remap[i / 3] = idx;
  }
  const weldedIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) weldedIdx[i] = remap[indices[i]];

  // Step 2: union-find on triangles by shared welded vertex.
  const numTris = weldedIdx.length / 3;
  const parent = new Int32Array(numTris);
  for (let i = 0; i < numTris; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n; }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const vertToTri = new Map<number, number>();
  for (let t = 0; t < numTris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = weldedIdx[t * 3 + k];
      const prev = vertToTri.get(v);
      if (prev === undefined) vertToTri.set(v, t);
      else union(t, prev);
    }
  }

  // Step 3: group triangles by root, emit one MeshData per group.
  const groups = new Map<number, number[]>();
  for (let t = 0; t < numTris; t++) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(t);
  }

  const out: MeshData[] = [];
  for (const tris of groups.values()) {
    const usedVerts = new Map<number, number>();
    const ind = new Uint32Array(tris.length * 3);
    const pos: number[] = [];
    for (let i = 0; i < tris.length; i++) {
      const t3 = tris[i] * 3;
      for (let k = 0; k < 3; k++) {
        const v = weldedIdx[t3 + k];
        let nv = usedVerts.get(v);
        if (nv === undefined) {
          nv = pos.length / 3;
          pos.push(welded[v * 3], welded[v * 3 + 1], welded[v * 3 + 2]);
          usedVerts.set(v, nv);
        }
        ind[i * 3 + k] = nv;
      }
    }
    out.push({ positions: new Float32Array(pos), indices: ind });
  }
  return out;
}
