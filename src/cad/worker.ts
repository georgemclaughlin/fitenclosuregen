import * as Comlink from "comlink";
import ManifoldModule from "manifold-3d";
import type {
  AABB, FaceAxis, GenerateRequest, GenerateResult, ItemRequest, MeshData, Primitive, Vec3,
} from "./types";
import { faceAxisNum, faceSignNum } from "./types";
import { buildEnclosureGeometry, cutoutBox } from "./shell";
import { transformedAabb } from "./bbox";
import {
  computeAccessPocket,
  computeCombinedAabbWithFlush,
  computeFlushAccessPocket,
  horizontalOverlap,
} from "./flush";

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

function manifoldAabb(m: ManifoldInst): AABB {
  const box = m.boundingBox();
  return {
    min: [box.min[0], box.min[1], box.min[2]],
    max: [box.max[0], box.max[1], box.max[2]],
  };
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

function localFlushSlab(face: FaceAxis, aabb: AABB, wall: number): AABB {
  const reach = wall + 0.75;
  const margin = 1;
  switch (face) {
    case "+x":
      return { min: [aabb.max[0] - reach, aabb.min[1] - margin, aabb.min[2] - margin], max: [aabb.max[0] + margin, aabb.max[1] + margin, aabb.max[2] + margin] };
    case "-x":
      return { min: [aabb.min[0] - margin, aabb.min[1] - margin, aabb.min[2] - margin], max: [aabb.min[0] + reach, aabb.max[1] + margin, aabb.max[2] + margin] };
    case "+y":
      return { min: [aabb.min[0] - margin, aabb.max[1] - reach, aabb.min[2] - margin], max: [aabb.max[0] + margin, aabb.max[1] + margin, aabb.max[2] + margin] };
    case "-y":
      return { min: [aabb.min[0] - margin, aabb.min[1] - margin, aabb.min[2] - margin], max: [aabb.max[0] + margin, aabb.min[1] + reach, aabb.max[2] + margin] };
    case "+z":
      return { min: [aabb.min[0] - margin, aabb.min[1] - margin, aabb.max[2] - reach], max: [aabb.max[0] + margin, aabb.max[1] + margin, aabb.max[2] + margin] };
    case "-z":
      return { min: [aabb.min[0] - margin, aabb.min[1] - margin, aabb.min[2] - margin], max: [aabb.max[0] + margin, aabb.max[1] + margin, aabb.min[2] + reach] };
  }
}

function buildFlushCutoutFromSlice(
  M: ManifoldNs,
  mesh: MeshData,
  localAabb: AABB,
  face: FaceAxis,
  wall: number,
): ManifoldInst | null {
  const axis = faceAxisNum(face);
  const sign = faceSignNum(face);
  const faceCoord = sign > 0 ? localAabb.max[axis] : localAabb.min[axis];
  const sampleDepth = Math.min(1.0, Math.max(0.5, wall / 2));
  const innerCoord = sign > 0 ? faceCoord - (wall + 0.75) : faceCoord + (wall + 0.75);
  const outerCoord = sign > 0 ? faceCoord + 1 : faceCoord - 1;
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const base: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    const coord = base[axis];
    const nearFace = sign > 0 ? coord >= faceCoord - sampleDepth : coord <= faceCoord + sampleDepth;
    if (!nearFace) continue;
    const inner = [base[0], base[1], base[2]] as Vec3;
    const outer = [base[0], base[1], base[2]] as Vec3;
    inner[axis] = innerCoord;
    outer[axis] = outerCoord;
    pts.push([inner[0], inner[1], inner[2]], [outer[0], outer[1], outer[2]]);
  }
  if (pts.length < 8) return null;
  const hullFn = (M.Manifold as unknown as {
    hull: (p: Array<[number, number, number]>) => ManifoldInst;
  }).hull;
  try {
    const cutout = hullFn(pts);
    return cutout.numTri() === 0 ? null : cutout;
  } catch {
    return null;
  }
}

function pointInTriangle2d(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-9) return false;
  const inv = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6;
}

function pointInRect2d(
  px: number,
  py: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  return px >= minX - 1e-6 && px <= maxX + 1e-6 && py >= minY - 1e-6 && py <= maxY + 1e-6;
}

function orient2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): boolean {
  return (
    px >= Math.min(ax, bx) - 1e-6 &&
    px <= Math.max(ax, bx) + 1e-6 &&
    py >= Math.min(ay, by) - 1e-6 &&
    py <= Math.max(ay, by) + 1e-6
  );
}

function segmentsIntersect2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orient2d(ax, ay, bx, by, cx, cy);
  const o2 = orient2d(ax, ay, bx, by, dx, dy);
  const o3 = orient2d(cx, cy, dx, dy, ax, ay);
  const o4 = orient2d(cx, cy, dx, dy, bx, by);
  if (Math.abs(o1) < 1e-6 && onSegment2d(ax, ay, bx, by, cx, cy)) return true;
  if (Math.abs(o2) < 1e-6 && onSegment2d(ax, ay, bx, by, dx, dy)) return true;
  if (Math.abs(o3) < 1e-6 && onSegment2d(cx, cy, dx, dy, ax, ay)) return true;
  if (Math.abs(o4) < 1e-6 && onSegment2d(cx, cy, dx, dy, bx, by)) return true;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function triangleOverlapsRect2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const triMinX = Math.min(ax, bx, cx);
  const triMaxX = Math.max(ax, bx, cx);
  const triMinY = Math.min(ay, by, cy);
  const triMaxY = Math.max(ay, by, cy);
  if (triMaxX < minX || triMinX > maxX || triMaxY < minY || triMinY > maxY) return false;

  // Ignore near-vertical faces whose XY projection has effectively zero area.
  if (Math.abs(orient2d(ax, ay, bx, by, cx, cy)) < 1e-6) return false;

  if (
    pointInRect2d(ax, ay, minX, minY, maxX, maxY) ||
    pointInRect2d(bx, by, minX, minY, maxX, maxY) ||
    pointInRect2d(cx, cy, minX, minY, maxX, maxY)
  ) {
    return true;
  }

  if (
    pointInTriangle2d(minX, minY, ax, ay, bx, by, cx, cy) ||
    pointInTriangle2d(maxX, minY, ax, ay, bx, by, cx, cy) ||
    pointInTriangle2d(maxX, maxY, ax, ay, bx, by, cx, cy) ||
    pointInTriangle2d(minX, maxY, ax, ay, bx, by, cx, cy)
  ) {
    return true;
  }

  const triEdges: Array<[number, number, number, number]> = [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay],
  ];
  const rectEdges: Array<[number, number, number, number]> = [
    [minX, minY, maxX, minY],
    [maxX, minY, maxX, maxY],
    [maxX, maxY, minX, maxY],
    [minX, maxY, minX, minY],
  ];
  for (const [tx0, ty0, tx1, ty1] of triEdges) {
    for (const [rx0, ry0, rx1, ry1] of rectEdges) {
      if (segmentsIntersect2d(tx0, ty0, tx1, ty1, rx0, ry0, rx1, ry1)) return true;
    }
  }
  return false;
}

export function computeHeightfieldColumns(
  mesh: MeshData,
  localAabb: AABB,
  clearance: number,
  cell = 1.0,
): AABB[] {
  const nx = Math.max(1, Math.ceil((localAabb.max[0] - localAabb.min[0]) / cell));
  const ny = Math.max(1, Math.ceil((localAabb.max[1] - localAabb.min[1]) / cell));
  const minZ = new Float32Array(nx * ny);
  minZ.fill(Infinity);

  const p = mesh.positions;
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i] * 3;
    const ib = idx[i + 1] * 3;
    const ic = idx[i + 2] * 3;
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
    const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
    const triMinX = Math.min(ax, bx, cx);
    const triMaxX = Math.max(ax, bx, cx);
    const triMinY = Math.min(ay, by, cy);
    const triMaxY = Math.max(ay, by, cy);
    const x0 = Math.max(0, Math.floor((triMinX - localAabb.min[0]) / cell));
    const x1 = Math.min(nx - 1, Math.floor((triMaxX - localAabb.min[0]) / cell));
    const y0 = Math.max(0, Math.floor((triMinY - localAabb.min[1]) / cell));
    const y1 = Math.min(ny - 1, Math.floor((triMaxY - localAabb.min[1]) / cell));
    const triMinZ = Math.min(az, bz, cz);
    for (let yi = y0; yi <= y1; yi++) {
      const cellMinY = localAabb.min[1] + yi * cell;
      const cellMaxY = cellMinY + cell;
      for (let xi = x0; xi <= x1; xi++) {
        const cellMinX = localAabb.min[0] + xi * cell;
        const cellMaxX = cellMinX + cell;
        if (!triangleOverlapsRect2d(ax, ay, bx, by, cx, cy, cellMinX, cellMinY, cellMaxX, cellMaxY)) {
          continue;
        }
        const slot = yi * nx + xi;
        if (triMinZ < minZ[slot]) minZ[slot] = triMinZ;
      }
    }
  }

  const top = localAabb.max[2] + clearance;
  const zQuant = 0.5;
  const boxes: AABB[] = [];
  for (let yi = 0; yi < ny; yi++) {
    let runStart = -1;
    let runZ = 0;
    for (let xi = 0; xi <= nx; xi++) {
      const slot = yi * nx + xi;
      const z = xi < nx ? minZ[slot] : Infinity;
      const qz = Number.isFinite(z) ? Math.round((z - clearance) / zQuant) * zQuant : Infinity;
      if (runStart < 0) {
        if (Number.isFinite(qz)) {
          runStart = xi;
          runZ = qz;
        }
        continue;
      }
      if (Number.isFinite(qz) && Math.abs(qz - runZ) < 1e-6) continue;
      const min: Vec3 = [
        localAabb.min[0] + runStart * cell,
        localAabb.min[1] + yi * cell,
        runZ,
      ];
      const max: Vec3 = [
        localAabb.min[0] + xi * cell,
        localAabb.min[1] + (yi + 1) * cell,
        top,
      ];
      boxes.push({ min, max });
      runStart = Number.isFinite(qz) ? xi : -1;
      runZ = qz;
    }
  }
  return boxes;
}

function buildHeightfieldCavity(
  M: ManifoldNs,
  mesh: MeshData,
  localAabb: AABB,
  clearance: number,
): ManifoldInst | null {
  const columns = computeHeightfieldColumns(mesh, localAabb, clearance);
  const boxes = columns.map((box) => boxFromAabb(M.Manifold, box));
  if (boxes.length === 0) return null;
  return boxes.length === 1 ? boxes[0] : M.Manifold.union(boxes);
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

function flushCutoutSlab(face: FaceAxis, outer: AABB, wall: number): AABB {
  const reach = wall + 0.75;
  const margin = 1;
  const big = Math.max(
    outer.max[0] - outer.min[0],
    outer.max[1] - outer.min[1],
    outer.max[2] - outer.min[2],
  ) + margin * 2;
  switch (face) {
    case "+x":
      return {
        min: [outer.max[0] - reach, outer.min[1] - big, outer.min[2] - big],
        max: [outer.max[0] + margin, outer.max[1] + big, outer.max[2] + big],
      };
    case "-x":
      return {
        min: [outer.min[0] - margin, outer.min[1] - big, outer.min[2] - big],
        max: [outer.min[0] + reach, outer.max[1] + big, outer.max[2] + big],
      };
    case "+y":
      return {
        min: [outer.min[0] - big, outer.max[1] - reach, outer.min[2] - big],
        max: [outer.max[0] + big, outer.max[1] + margin, outer.max[2] + big],
      };
    case "-y":
      return {
        min: [outer.min[0] - big, outer.min[1] - margin, outer.min[2] - big],
        max: [outer.max[0] + big, outer.min[1] + reach, outer.max[2] + big],
      };
    case "+z":
      return {
        min: [outer.min[0] - big, outer.min[1] - big, outer.max[2] - reach],
        max: [outer.max[0] + big, outer.max[1] + big, outer.max[2] + margin],
      };
    case "-z":
      return {
        min: [outer.min[0] - big, outer.min[1] - big, outer.min[2] - margin],
        max: [outer.max[0] + big, outer.max[1] + big, outer.min[2] + reach],
      };
  }
}

/** Build local-frame (pre-pose) manifolds for an item. */
function buildItemLocal(
  M: ManifoldNs, item: ItemRequest, clearance: number, wall: number,
): { cavity: ManifoldInst; cutout: ManifoldInst } | null {
  if (item.kind === "primitive" && item.primitive) {
    const bare = buildPrimitive(M, item.primitive);
    const infl = buildPrimitive(M, expandedPrimitive(item.primitive, clearance));
    const cutout = item.flushFace
      ? bare.intersect(boxFromAabb(M.Manifold, localFlushSlab(item.flushFace, item.aabb, wall)))
      : bare;
    return { cavity: infl, cutout };
  }
  if (item.kind === "import" && item.parts && item.parts.length > 0) {
    const cavityParts: ManifoldInst[] = [];
    const cutoutParts: ManifoldInst[] = [];
    for (const p of item.parts) {
      const cavity = buildHeightfieldCavity(M, p, item.aabb, clearance);
      if (cavity) cavityParts.push(cavity);
      if (item.flushFace) {
        const sliced = buildFlushCutoutFromSlice(M, p, item.aabb, item.flushFace, wall);
        if (sliced) cutoutParts.push(sliced);
      }
    }
    if (cavityParts.length === 0) return null;
    const cavityRaw = cavityParts.length === 1 ? cavityParts[0] : M.Manifold.union(cavityParts);
    const cutoutRaw = cutoutParts.length > 0
      ? (cutoutParts.length === 1 ? cutoutParts[0] : M.Manifold.union(cutoutParts))
      : (() => {
          const bareHulls: ManifoldInst[] = [];
          for (const p of item.parts) {
            const b = partHull(M, p, 0);
            if (b) bareHulls.push(b);
          }
          if (bareHulls.length === 0) return M.Manifold.cube([0, 0, 0], false);
          const bareRaw = bareHulls.length === 1 ? bareHulls[0] : M.Manifold.union(bareHulls);
          return item.flushFace
            ? bareRaw.intersect(boxFromAabb(M.Manifold, localFlushSlab(item.flushFace, item.aabb, wall)))
            : bareRaw;
        })();
    return { cavity: cavityRaw, cutout: cutoutRaw };
  }
  return null;
}

interface ItemCacheEntry {
  cavityLocal: ManifoldInst;
  cutoutLocal: ManifoldInst;
}
const itemCache = new Map<string, ItemCacheEntry>();

export async function generate(req: GenerateRequest): Promise<GenerateResult> {
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

  // Per-item world AABBs + local-fit cavities. Flushed items additionally
  // contribute a wall cutout used to pierce the shell.
  const perItemCutout: Array<{ face: FaceAxis; manifold: ManifoldInst } | null> = [];
  const perItemCavity: Array<ManifoldInst | null> = [];
  const perItemAabb: AABB[] = [];
  for (const it of items) {
    const worldAabb = transformedAabb(it.aabb, it.rotation, it.position);
    perItemAabb.push(worldAabb);
    const cacheKey = it.kind === "primitive"
      ? `${it.id}|prim|${it.flushFace}|${params.wall}|${JSON.stringify(it.primitive)}|${clearance}`
      : `${it.id}|imp|${it.flushFace}|${params.wall}|${it.meshVersion ?? 0}|${clearance}`;
    let entry = itemCache.get(cacheKey);
    if (!entry) {
      const built = buildItemLocal(M, it, clearance, params.wall);
      if (built) {
        entry = { cavityLocal: built.cavity, cutoutLocal: built.cutout };
        itemCache.set(cacheKey, entry);
      }
    }
    if (entry) {
      perItemCavity.push(applyPose(entry.cavityLocal, it.rotation, it.position));
      if (it.flushFace) {
        perItemCutout.push({
          face: it.flushFace,
          manifold: applyPose(entry.cutoutLocal, it.rotation, it.position),
        });
      } else {
        perItemCutout.push(null);
      }
    } else {
      perItemCavity.push(null);
      perItemCutout.push(null);
    }
  }

  // Compute combinedAabb with flush exclusion: flushed items' contribution
  // on their flushed axis/side is excluded so the outer box doesn't grow to
  // accommodate the overshoot.
  const combinedAabb = computeCombinedAabbWithFlush(items, perItemAabb);
  const geom = buildEnclosureGeometry(combinedAabb, params);

  const outerBox = params.fillet > 0
    ? roundedBoxFromAabb(M, geom.outer, params.fillet)
    : boxFromAabb(Manifold, geom.outer);
  const clippedCutouts = perItemCutout.map((cutout) => cutout && ({
    face: cutout.face,
    manifold: cutout.manifold.intersect(
      boxFromAabb(Manifold, flushCutoutSlab(cutout.face, geom.outer, params.wall)),
    ),
  }));

  const clippedCutoutManifolds = clippedCutouts
    .map((cutout) => (cutout && cutout.manifold.numTri() > 0 ? cutout.manifold : null))
    .filter((cutout): cutout is ManifoldInst => cutout !== null);

  const clippedCutoutBounds = clippedCutouts.map((cutout) =>
    cutout && cutout.manifold.numTri() > 0 ? manifoldAabb(cutout.manifold) : null,
  );

  const cavityBlocks: ManifoldInst[] = [];
  for (let i = 0; i < items.length; i++) {
    const cavity = perItemCavity[i];
    if (cavity) cavityBlocks.push(cavity);

    let supportZ = -Infinity;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (!horizontalOverlap(perItemAabb[i], perItemAabb[j])) continue;
      if (perItemAabb[j].max[2] >= perItemAabb[i].max[2]) continue;
      supportZ = Math.max(supportZ, perItemAabb[j].max[2] + clearance);
    }

    if (supportZ > -Infinity) {
      const accessPocket = computeAccessPocket(
        perItemAabb[i], clearance, geom.splitZ, null, geom.inner, supportZ,
      );
      cavityBlocks.push(boxFromAabb(Manifold, accessPocket));
    }

    const flushFace = items[i].flushFace;
    const cutoutBounds = clippedCutoutBounds[i];
    if (!flushFace || !cutoutBounds) continue;

    const flushPocket = computeFlushAccessPocket(
      cutoutBounds, clearance, geom.splitZ, geom.inner,
    );
    if (flushPocket) cavityBlocks.push(boxFromAabb(Manifold, flushPocket));
  }

  let cavity: ManifoldInst | null = null;
  if (cavityBlocks.length > 0) {
    cavity = cavityBlocks.length === 1 ? cavityBlocks[0] : Manifold.union(cavityBlocks);
    cavity = cavity.intersect(boxFromAabb(Manifold, geom.inner));
  }

  let shell: ManifoldInst = cavity
    ? outerBox.subtract(cavity)
    : outerBox.subtract(boxFromAabb(Manifold, geom.inner));

  // Poke holes where bare item silhouettes cross the outer wall.
  let cutoutHull: ManifoldInst | null = null;
  if (clippedCutoutManifolds.length > 0) {
    cutoutHull = clippedCutoutManifolds.length === 1
      ? clippedCutoutManifolds[0]
      : Manifold.union(clippedCutoutManifolds);
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
  if (cutoutHull) {
    lid = lid.subtract(cutoutHull);
  }

  return {
    base: toMeshData(base),
    lid: toMeshData(lid),
    outer: geom.outer,
  };
}

export const api = { generate };
export type WorkerApi = typeof api;

if (typeof self !== "undefined") {
  Comlink.expose(api);
}
