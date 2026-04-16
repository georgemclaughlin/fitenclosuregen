import * as Comlink from "comlink";
import ManifoldModule from "manifold-3d";
import type {
  AABB, GenerateRequest, GenerateResult, ItemRequest, MeshData, Primitive, Vec3,
} from "./types";
import { buildEnclosureGeometry, cutoutBox } from "./shell";
import { transformedAabb, unionAabbs } from "./bbox";

type ManifoldNs = Awaited<ReturnType<typeof ManifoldModule>>;
type ManifoldInst = ReturnType<ManifoldNs["Manifold"]["cube"]>;

let modulePromise: Promise<ManifoldNs> | null = null;
async function getManifold(): Promise<ManifoldNs> {
  if (!modulePromise) {
    modulePromise = ManifoldModule().then(async (m) => {
      await m.setup();
      return m;
    });
  }
  return modulePromise;
}

function boxFromAabb(Manifold: ManifoldNs["Manifold"], a: AABB): ManifoldInst {
  const sx = a.max[0] - a.min[0];
  const sy = a.max[1] - a.min[1];
  const sz = a.max[2] - a.min[2];
  if (sx <= 0 || sy <= 0 || sz <= 0) return Manifold.cube([0, 0, 0], false);
  return Manifold.cube([sx, sy, sz], false).translate([a.min[0], a.min[1], a.min[2]]);
}

function roundedBoxFromAabb(M: ManifoldNs, a: AABB, r: number): ManifoldInst {
  const sx = a.max[0] - a.min[0];
  const sy = a.max[1] - a.min[1];
  const sz = a.max[2] - a.min[2];
  const rr = Math.min(r, sx / 2 - 1e-3, sy / 2 - 1e-3, sz / 2 - 1e-3);
  if (rr <= 0) return boxFromAabb(M.Manifold, a);
  const latSegs = 6;
  const lonSegs = 12;
  const cornerX = [a.min[0] + rr, a.max[0] - rr];
  const cornerY = [a.min[1] + rr, a.max[1] - rr];
  const cornerZ = [a.min[2] + rr, a.max[2] - rr];
  const pts: Array<[number, number, number]> = [];
  for (const cz of cornerZ) {
    for (const cy of cornerY) {
      for (const cx of cornerX) {
        for (let i = 0; i <= latSegs; i++) {
          const lat = -Math.PI / 2 + Math.PI * (i / latSegs);
          const cl = Math.cos(lat), sl = Math.sin(lat);
          for (let j = 0; j < lonSegs; j++) {
            const lon = 2 * Math.PI * (j / lonSegs);
            pts.push([
              cx + rr * cl * Math.cos(lon),
              cy + rr * cl * Math.sin(lon),
              cz + rr * sl,
            ]);
          }
        }
      }
    }
  }
  const hullFn = (M.Manifold as unknown as {
    hull: (p: Array<[number, number, number]>) => ManifoldInst;
  }).hull;
  return hullFn(pts);
}

function toMeshData(m: ManifoldInst): MeshData {
  const mesh = m.getMesh();
  const numProp = mesh.numProp ?? 3;
  const verts = mesh.vertProperties;
  let positions: Float32Array;
  if (numProp === 3) {
    positions = new Float32Array(verts.buffer.slice(verts.byteOffset, verts.byteOffset + verts.byteLength));
  } else {
    const n = verts.length / numProp;
    positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = verts[i * numProp];
      positions[i * 3 + 1] = verts[i * numProp + 1];
      positions[i * 3 + 2] = verts[i * numProp + 2];
    }
  }
  const indices = new Uint32Array(mesh.triVerts.buffer.slice(
    mesh.triVerts.byteOffset,
    mesh.triVerts.byteOffset + mesh.triVerts.byteLength,
  ));
  return { positions, indices };
}

function isPositive(a: AABB): boolean {
  return a.max[0] > a.min[0] && a.max[1] > a.min[1] && a.max[2] > a.min[2];
}

function partHull(M: ManifoldNs, mesh: MeshData, inflate = 0): ManifoldInst | null {
  const pos = mesh.positions;
  if (pos.length < 12) return null;
  const hullFn = (M.Manifold as unknown as {
    hull: (p: Array<[number, number, number]>) => ManifoldInst;
  }).hull;
  let pts: Array<[number, number, number]>;
  if (inflate > 0) {
    const c = inflate;
    const corners: Array<[number, number, number]> = [
      [-c, -c, -c], [c, -c, -c], [-c, c, -c], [c, c, -c],
      [-c, -c,  c], [c, -c,  c], [-c, c,  c], [c, c,  c],
    ];
    const n = pos.length / 3;
    pts = new Array(n * 8);
    let k = 0;
    for (let i = 0; i < pos.length; i += 3) {
      for (let j = 0; j < 8; j++) {
        const co = corners[j];
        pts[k++] = [pos[i] + co[0], pos[i + 1] + co[1], pos[i + 2] + co[2]];
      }
    }
  } else {
    pts = new Array(pos.length / 3);
    for (let i = 0, j = 0; i < pos.length; i += 3, j++) {
      pts[j] = [pos[i], pos[i + 1], pos[i + 2]];
    }
  }
  try {
    const m = hullFn(pts);
    if (m.numTri() === 0) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Build a convex-cylinder manifold of radius `r`, length `h`, oriented along
 * the given axis, centered at origin. Uses hull of 2 circles so we get a
 * closed solid that supports the inflate trick for clearance.
 */
function cylinderManifold(M: ManifoldNs, r: number, h: number, axis: "x" | "y" | "z"): ManifoldInst {
  const segs = 48;
  const he = h / 2;
  const hullFn = (M.Manifold as unknown as {
    hull: (p: Array<[number, number, number]>) => ManifoldInst;
  }).hull;
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = r * Math.cos(a), s = r * Math.sin(a);
    if (axis === "x") {
      pts.push([-he, c, s]);
      pts.push([ he, c, s]);
    } else if (axis === "y") {
      pts.push([c, -he, s]);
      pts.push([c,  he, s]);
    } else {
      pts.push([c, s, -he]);
      pts.push([c, s,  he]);
    }
  }
  return hullFn(pts);
}

/** Minkowski-expand a primitive's dimensions by `inflate` on each side. */
function expandedPrimitive(p: Primitive, inflate: number): Primitive {
  if (p.kind === "box") {
    return {
      kind: "box",
      size: [
        p.size[0] + 2 * inflate,
        p.size[1] + 2 * inflate,
        p.size[2] + 2 * inflate,
      ],
    };
  }
  return {
    kind: "cylinder",
    axis: p.axis,
    radius: p.radius + inflate,
    height: p.height + 2 * inflate,
  };
}

function buildPrimitive(M: ManifoldNs, prim: Primitive): ManifoldInst {
  if (prim.kind === "box") {
    const [sx, sy, sz] = prim.size;
    return M.Manifold.cube([sx, sy, sz], true); // centered
  }
  return cylinderManifold(M, prim.radius, prim.height, prim.axis);
}

function applyPose(m: ManifoldInst, rotation: Vec3, position: Vec3): ManifoldInst {
  let out = m;
  if (rotation[0] !== 0 || rotation[1] !== 0 || rotation[2] !== 0) {
    out = out.rotate(rotation);
  }
  return out.translate(position);
}

/** Build local-frame (pre-pose) manifolds for an item. */
function buildItemLocal(
  M: ManifoldNs, item: ItemRequest, clearance: number,
): { cavity: ManifoldInst; cutout: ManifoldInst } | null {
  if (item.kind === "primitive" && item.primitive) {
    const bare = buildPrimitive(M, item.primitive);
    const infl = buildPrimitive(M, expandedPrimitive(item.primitive, clearance));
    return { cavity: infl, cutout: bare };
  }
  if (item.kind === "import" && item.parts && item.parts.length > 0) {
    const bareHulls: ManifoldInst[] = [];
    const infHulls: ManifoldInst[] = [];
    for (const p of item.parts) {
      const b = partHull(M, p, 0);
      if (b) bareHulls.push(b);
      const inf = partHull(M, p, clearance);
      if (inf) infHulls.push(inf);
    }
    if (bareHulls.length === 0 || infHulls.length === 0) return null;
    const bareRaw = bareHulls.length === 1 ? bareHulls[0] : M.Manifold.union(bareHulls);
    const cavityRaw = infHulls.length === 1 ? infHulls[0] : M.Manifold.union(infHulls);
    return { cavity: cavityRaw, cutout: bareRaw };
  }
  return null;
}

interface ItemCacheEntry {
  cavityLocal: ManifoldInst;
  cutoutLocal: ManifoldInst;
}
const itemCache = new Map<string, ItemCacheEntry>();

async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const M = await getManifold();
  const { Manifold } = M;
  const { params, items, cutouts } = req;
  const clearance = params.clearance;

  if (items.length === 0) {
    // Empty-state: tiny placeholder box so UI never NaNs.
    const empty: AABB = { min: [-1, -1, -1], max: [1, 1, 1] };
    const geom = buildEnclosureGeometry(empty, params);
    const shell = boxFromAabb(Manifold, geom.outer).subtract(boxFromAabb(Manifold, geom.inner));
    return { base: toMeshData(shell), lid: toMeshData(shell), outer: geom.outer };
  }

  // Per-item manifolds.
  const perItemCavity: ManifoldInst[] = [];
  const perItemCutout: ManifoldInst[] = [];
  const perItemAabb: AABB[] = [];
  for (const it of items) {
    // Cache the un-posed local manifolds. Pose (rotation + translation) is
    // applied every generate so reposition/rotation are cheap.
    const cacheKey = it.kind === "primitive"
      ? `${it.id}|prim|${JSON.stringify(it.primitive)}|${clearance}`
      : `${it.id}|imp|${clearance}`;
    let entry = itemCache.get(cacheKey);
    if (!entry) {
      const built = buildItemLocal(M, it, clearance);
      if (built) {
        entry = { cavityLocal: built.cavity, cutoutLocal: built.cutout };
        itemCache.set(cacheKey, entry);
      }
    }
    if (entry) {
      perItemCavity.push(applyPose(entry.cavityLocal, it.rotation, it.position));
      perItemCutout.push(applyPose(entry.cutoutLocal, it.rotation, it.position));
    }
    perItemAabb.push(transformedAabb(it.aabb, it.rotation, it.position));
  }

  const combinedAabb = unionAabbs(perItemAabb);
  const geom = buildEnclosureGeometry(combinedAabb, params);

  const outerBox = params.fillet > 0
    ? roundedBoxFromAabb(M, geom.outer, params.fillet)
    : boxFromAabb(Manifold, geom.outer);

  // Union per-item cavities into one, intersect with inner AABB so curved
  // silhouettes can't pierce walls. Ports/connectors poke through via the
  // bare cutout hull subtraction below.
  let cavity: ManifoldInst | null = null;
  if (perItemCavity.length > 0) {
    cavity = perItemCavity.length === 1 ? perItemCavity[0] : Manifold.union(perItemCavity);
    cavity = cavity.intersect(boxFromAabb(Manifold, geom.inner));
  }

  let shell: ManifoldInst = cavity
    ? outerBox.subtract(cavity)
    : outerBox.subtract(boxFromAabb(Manifold, geom.inner));

  // Poke holes where bare item silhouettes cross the outer wall.
  let cutoutHull: ManifoldInst | null = null;
  if (perItemCutout.length > 0) {
    cutoutHull = perItemCutout.length === 1 ? perItemCutout[0] : Manifold.union(perItemCutout);
    shell = shell.subtract(cutoutHull);
  }

  // Manual face-local cutouts (subtract from full shell).
  for (const c of cutouts) {
    const box = cutoutBox(c, geom.outer, params.wall);
    if (!isPositive(box)) continue;
    shell = shell.subtract(boxFromAabb(Manifold, box));
  }

  // Split at splitZ.
  const bigSize = Math.max(
    geom.outer.max[0] - geom.outer.min[0],
    geom.outer.max[1] - geom.outer.min[1],
    geom.outer.max[2] - geom.outer.min[2],
  ) * 4;
  const halfBelow = boxFromAabb(Manifold, {
    min: [geom.outer.min[0] - bigSize, geom.outer.min[1] - bigSize, geom.outer.min[2] - bigSize],
    max: [geom.outer.max[0] + bigSize, geom.outer.max[1] + bigSize, geom.splitZ],
  });
  const halfAbove = boxFromAabb(Manifold, {
    min: [geom.outer.min[0] - bigSize, geom.outer.min[1] - bigSize, geom.splitZ],
    max: [geom.outer.max[0] + bigSize, geom.outer.max[1] + bigSize, geom.outer.max[2] + bigSize],
  });

  let base: ManifoldInst = shell.intersect(halfBelow);
  let lid: ManifoldInst = shell.intersect(halfAbove);

  if (isPositive(geom.tongueOuter) && isPositive(geom.tongueInner)) {
    const to = boxFromAabb(Manifold, geom.tongueOuter);
    const ti = boxFromAabb(Manifold, geom.tongueInner);
    let ring = to.subtract(ti);
    if (geom.snapBeadOuter && geom.snapBeadInner
        && isPositive(geom.snapBeadOuter) && isPositive(geom.snapBeadInner)) {
      const bo = boxFromAabb(Manifold, geom.snapBeadOuter);
      const bi = boxFromAabb(Manifold, geom.snapBeadInner);
      ring = Manifold.union([ring, bo.subtract(bi)]);
    }
    if (cutoutHull) ring = ring.subtract(cutoutHull);
    for (const c of cutouts) {
      const b = cutoutBox(c, geom.outer, params.wall);
      if (isPositive(b)) ring = ring.subtract(boxFromAabb(Manifold, b));
    }
    base = Manifold.union([base, ring]);
  }

  if (isPositive(geom.grooveOuter) && isPositive(geom.grooveInner)) {
    const go = boxFromAabb(Manifold, geom.grooveOuter);
    const gi = boxFromAabb(Manifold, geom.grooveInner);
    let groove = go.subtract(gi);
    if (geom.snapRecessOuter && geom.snapRecessInner
        && isPositive(geom.snapRecessOuter) && isPositive(geom.snapRecessInner)) {
      const ro = boxFromAabb(Manifold, geom.snapRecessOuter);
      const ri = boxFromAabb(Manifold, geom.snapRecessInner);
      groove = Manifold.union([groove, ro.subtract(ri)]);
    }
    lid = lid.subtract(groove);
  }

  return {
    base: toMeshData(base),
    lid: toMeshData(lid),
    outer: geom.outer,
  };
}

export const api = { generate };
export type WorkerApi = typeof api;

Comlink.expose(api);
