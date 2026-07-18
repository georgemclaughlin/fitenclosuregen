import * as Comlink from "comlink";
import ManifoldModule from "manifold-3d";
import type {
  AABB, Connection, ConnectionEndpoint, DebugMesh, FaceAxis, GenerateRequest, GenerateResult, ItemRequest, MeshData, Primitive, Vec3,
} from "./types";
import { faceAxisNum, faceSignNum } from "./types";
import { buildEnclosureGeometry, cutoutBox, faceFrame } from "./shell";
import { transformedAabb } from "./bbox";
import {
  computeAccessPocket,
  computeCavityPocket,
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

function unionAll(M: ManifoldNs["Manifold"], parts: ManifoldInst[]): ManifoldInst | null {
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : M.union(parts);
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
        localAabb.min[0] + runStart * cell - clearance,
        localAabb.min[1] + yi * cell - clearance,
        runZ,
      ];
      const max: Vec3 = [
        localAabb.min[0] + xi * cell + clearance,
        localAabb.min[1] + (yi + 1) * cell + clearance,
        top,
      ];
      boxes.push({ min, max });
      runStart = Number.isFinite(qz) ? xi : -1;
      runZ = qz;
    }
  }
  return boxes;
}

function computeImportUpperAccessFloor(
  parts: MeshData[],
  localAabb: AABB,
  clearance: number,
): number | null {
  const samples: Array<{ z: number; area: number }> = [];
  for (const part of parts) {
    for (const col of computeHeightfieldColumns(part, localAabb, clearance)) {
      const area = Math.max(0, col.max[0] - col.min[0]) * Math.max(0, col.max[1] - col.min[1]);
      if (area > 0 && Number.isFinite(col.min[2])) samples.push({ z: col.min[2], area });
    }
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a.z - b.z);
  const totalArea = samples.reduce((sum, sample) => sum + sample.area, 0);
  const target = totalArea * 0.35;
  let area = 0;
  let floor = samples[samples.length - 1].z;
  for (const sample of samples) {
    area += sample.area;
    if (area >= target) {
      floor = sample.z;
      break;
    }
  }

  const upperStack = localAabb.max[2] - floor;
  const lowerSparseRelief = floor - localAabb.min[2];
  if (upperStack < 6 || lowerSparseRelief < 1.5) return null;
  return floor;
}

function buildHeightfieldCavity(
  M: ManifoldNs,
  columns: AABB[],
): ManifoldInst | null {
  const boxes = columns.map((box) => boxFromAabb(M.Manifold, box));
  if (boxes.length === 0) return null;
  return boxes.length === 1 ? boxes[0] : M.Manifold.union(boxes);
}

function unionAabbs(boxes: AABB[]): AABB | null {
  if (boxes.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], box.min[axis]);
      max[axis] = Math.max(max[axis], box.max[axis]);
    }
  }
  return { min, max };
}

function nearFaceReliefAabb(
  columns: AABB[],
  localAabb: AABB,
  face: FaceAxis,
  depth: number,
): AABB | null {
  const axis = faceAxisNum(face);
  const sign = faceSignNum(face);
  const faceCoord = sign > 0 ? localAabb.max[axis] : localAabb.min[axis];
  const near = columns.filter((col) => {
    if (sign > 0) return col.max[axis] >= faceCoord - depth;
    return col.min[axis] <= faceCoord + depth;
  });
  return unionAabbs(near);
}

function clampAabb(box: AABB, bounds: AABB): AABB | null {
  const min: Vec3 = [
    Math.max(box.min[0], bounds.min[0]),
    Math.max(box.min[1], bounds.min[1]),
    Math.max(box.min[2], bounds.min[2]),
  ];
  const max: Vec3 = [
    Math.min(box.max[0], bounds.max[0]),
    Math.min(box.max[1], bounds.max[1]),
    Math.min(box.max[2], bounds.max[2]),
  ];
  const out = { min, max };
  return isPositive(out) ? out : null;
}

function flushWallPocket(
  footprint: AABB,
  face: FaceAxis,
  outer: AABB,
  inner: AABB,
): AABB | null {
  const axis = faceAxisNum(face);
  const min: Vec3 = [...footprint.min];
  const max: Vec3 = [...footprint.max];
  if (faceSignNum(face) > 0) {
    min[axis] = inner.max[axis];
    max[axis] = outer.max[axis];
  } else {
    min[axis] = outer.min[axis];
    max[axis] = inner.min[axis];
  }
  const out = { min, max };
  return isPositive(out) ? out : null;
}

function shouldAddFrontRelief(face: FaceAxis, reliefBounds: AABB, cutoutBounds: AABB): boolean {
  const axis = faceAxisNum(face);
  const lateralAxis = axis === 0 ? 1 : 0;
  const reliefSpan = reliefBounds.max[lateralAxis] - reliefBounds.min[lateralAxis];
  const cutoutSpan = cutoutBounds.max[lateralAxis] - cutoutBounds.min[lateralAxis];
  return reliefSpan > cutoutSpan + 2;
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

function extendCutoutToOuter(
  M: ManifoldNs,
  cutout: ManifoldInst,
  face: FaceAxis,
  bodyOuter: AABB,
  reinforcedOuter: AABB,
): ManifoldInst {
  const axis = faceAxisNum(face);
  const sign = faceSignNum(face);
  const extension = outerExtensionForFace(face, bodyOuter, reinforcedOuter);
  if (extension <= 1e-6) return cutout;
  const offset: Vec3 = [0, 0, 0];
  offset[axis] = sign * (extension + 0.1);
  return M.Manifold.hull([cutout, cutout.translate(offset)]);
}

function outerExtensionForFace(face: FaceAxis, bodyOuter: AABB, reinforcedOuter: AABB): number {
  const axis = faceAxisNum(face);
  return faceSignNum(face) > 0
    ? Math.max(0, reinforcedOuter.max[axis] - bodyOuter.max[axis])
    : Math.max(0, bodyOuter.min[axis] - reinforcedOuter.min[axis]);
}

/** Build local-frame (pre-pose) manifolds for an item. */
function buildItemLocal(
  M: ManifoldNs, item: ItemRequest, clearance: number, wall: number,
): { cavity: ManifoldInst; cutout: ManifoldInst; reliefLocal?: AABB | null } | null {
  if (item.kind === "primitive" && item.primitive) {
    const bare = buildPrimitive(M, item.primitive);
    const infl = buildPrimitive(M, expandedPrimitive(item.primitive, clearance));
    const cutout = item.flushFace
      ? bare.intersect(boxFromAabb(M.Manifold, localFlushSlab(item.flushFace, item.aabb, wall)))
      : bare;
    return { cavity: infl, cutout, reliefLocal: null };
  }
  if (item.kind === "import" && item.parts && item.parts.length > 0) {
    const cavityParts: ManifoldInst[] = [];
    const cutoutParts: ManifoldInst[] = [];
    const reliefBoxes: AABB[] = [];
    for (const p of item.parts) {
      const columns = computeHeightfieldColumns(p, item.aabb, clearance);
      const cavity = buildHeightfieldCavity(M, columns);
      if (cavity) cavityParts.push(cavity);
      if (item.flushFace) {
        const sliced = buildFlushCutoutFromSlice(M, p, item.aabb, item.flushFace, wall);
        if (sliced) cutoutParts.push(sliced);
        const relief = nearFaceReliefAabb(
          columns,
          item.aabb,
          item.flushFace,
          Math.max(2.5, wall + clearance + 0.75),
        );
        if (relief) reliefBoxes.push(relief);
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
    return { cavity: cavityRaw, cutout: cutoutRaw, reliefLocal: unionAabbs(reliefBoxes) };
  }
  return null;
}

interface ItemCacheEntry {
  cavityLocal: ManifoldInst;
  cutoutLocal: ManifoldInst;
  reliefLocal?: AABB | null;
}
const itemCache = new Map<string, ItemCacheEntry>();
const MAX_ITEM_CACHE_ENTRIES = 64;

function disposeManifold(m: ManifoldInst): void {
  const disposable = m as unknown as { delete?: () => void };
  if (typeof disposable.delete === "function") disposable.delete();
}

function disposeCacheEntry(entry: ItemCacheEntry): void {
  disposeManifold(entry.cavityLocal);
  disposeManifold(entry.cutoutLocal);
}

function setItemCacheEntry(key: string, entry: ItemCacheEntry): void {
  itemCache.set(key, entry);
  while (itemCache.size > MAX_ITEM_CACHE_ENTRIES) {
    const oldestKey = itemCache.keys().next().value as string | undefined;
    if (!oldestKey || oldestKey === key) break;
    const oldest = itemCache.get(oldestKey);
    itemCache.delete(oldestKey);
    if (oldest) disposeCacheEntry(oldest);
  }
}

function manualCutoutManifold(
  M: ManifoldNs,
  c: GenerateRequest["cutouts"][number],
  outer: AABB,
  wall: number,
): ManifoldInst | null {
  const bounds = cutoutBox(c, outer, wall);
  if (!isPositive(bounds)) return null;
  if (c.shape === "rect") return boxFromAabb(M.Manifold, bounds);

  const face = faceFrame(c.face, outer);
  const radius = Math.min(c.w, c.h) / 2;
  if (radius <= 0) return null;
  const length = bounds.max[face.nAxis] - bounds.min[face.nAxis];
  if (length <= 0) return null;

  const center: Vec3 = [0, 0, 0];
  center[face.nAxis] = (bounds.min[face.nAxis] + bounds.max[face.nAxis]) / 2;
  center[face.uAxis] = face.uMin + c.u;
  center[face.vAxis] = face.vMin + c.v;
  const axis = face.nAxis === 0 ? "x" : face.nAxis === 1 ? "y" : "z";
  return cylinderManifold(M, radius, length, axis).translate(center);
}

function expandBox(box: AABB, amount: number): AABB {
  return {
    min: [box.min[0] - amount, box.min[1] - amount, box.min[2] - amount],
    max: [box.max[0] + amount, box.max[1] + amount, box.max[2] + amount],
  };
}

function subVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addScaled(a: Vec3, b: Vec3, scale: number): Vec3 {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vecLen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 | null {
  const len = vecLen(v);
  if (len <= 1e-6) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function eulerMatrix(rot: Vec3): number[] {
  const [rx, ry, rz] = rot.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
    cy * sz, cx * cz + sx * sy * sz, -cz * sx + cx * sy * sz,
    -sy,     cy * sx,                cx * cy,
  ];
}

function transformPoint(p: Vec3, rotation: Vec3, position: Vec3): Vec3 {
  const m = eulerMatrix(rotation);
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + position[0],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + position[1],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + position[2],
  ];
}

function rotateVector(v: Vec3, rotation: Vec3): Vec3 {
  const m = eulerMatrix(rotation);
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function perpendicularFrame(direction: Vec3): { u: Vec3; v: Vec3 } | null {
  const dir = normalize(direction);
  if (!dir) return null;
  const seed: Vec3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = normalize(cross(dir, seed));
  if (!u) return null;
  const v = normalize(cross(dir, u));
  return v ? { u, v } : null;
}

function distance(a: Vec3, b: Vec3): number {
  return vecLen(subVec(a, b));
}

function routeRadius(connection: Connection): number {
  const core = connection.shape === "round"
    ? connection.width / 2
    : Math.max(connection.width, connection.height) / 2;
  return Math.max(0, core + connection.clearance);
}

function segmentAabbInterval(a: Vec3, b: Vec3, box: AABB): { min: number; max: number } | null {
  const d = subVec(b, a);
  let tMin = 0;
  let tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-8) {
      if (a[axis] < box.min[axis] || a[axis] > box.max[axis]) return null;
      continue;
    }
    const inv = 1 / d[axis];
    let t0 = (box.min[axis] - a[axis]) * inv;
    let t1 = (box.max[axis] - a[axis]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) return null;
  }
  return { min: tMin, max: tMax };
}

function segmentClear(a: Vec3, b: Vec3, obstacles: AABB[]): boolean {
  for (const obstacle of obstacles) {
    const hit = segmentAabbInterval(a, b, obstacle);
    if (!hit) continue;
    const nearStart = hit.min <= 1e-4 && hit.max <= 0.2;
    const nearEnd = hit.max >= 1 - 1e-4 && hit.min >= 0.8;
    if (!nearStart && !nearEnd) return false;
  }
  return true;
}

function pathClear(points: Vec3[], obstacles: AABB[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (!segmentClear(points[i], points[i + 1], obstacles)) return false;
  }
  return true;
}

function pathLength(points: Vec3[]): number {
  let out = 0;
  for (let i = 0; i < points.length - 1; i++) out += distance(points[i], points[i + 1]);
  return out;
}

function routeCost(points: Vec3[], floorZ: number): number {
  let cost = pathLength(points);
  let minZ = Infinity;
  let zTravel = 0;
  for (let i = 0; i < points.length; i++) {
    minZ = Math.min(minZ, points[i][2]);
    if (i > 0) zTravel += Math.abs(points[i][2] - points[i - 1][2]);
  }
  if (minZ < floorZ) cost += (floorZ - minZ) * 1000;
  cost += zTravel * 50;
  return cost;
}

function pointInAabb(p: Vec3, bounds: AABB): boolean {
  return p[0] >= bounds.min[0] && p[0] <= bounds.max[0]
    && p[1] >= bounds.min[1] && p[1] <= bounds.max[1]
    && p[2] >= bounds.min[2] && p[2] <= bounds.max[2];
}

function pathInsideBounds(points: Vec3[], bounds: AABB | null): boolean {
  return !bounds || points.every((p) => pointInAabb(p, bounds));
}

function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): { point: Vec3; t: number; distance: number } {
  const ab = subVec(b, a);
  const lenSq = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const rawT = lenSq <= 1e-9 ? 0 : (
    ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / lenSq
  );
  const t = Math.max(0, Math.min(1, rawT));
  const point: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return { point, t, distance: distance(p, point) };
}

function closestPointOnRoute(p: Vec3, route: Vec3[]): { point: Vec3; segment: number; t: number; distance: number } | null {
  let best: { point: Vec3; segment: number; t: number; distance: number } | null = null;
  for (let i = 0; i < route.length - 1; i++) {
    const hit = closestPointOnSegment(p, route[i], route[i + 1]);
    if (!best || hit.distance < best.distance) best = { ...hit, segment: i };
  }
  return best;
}

function subRoute(route: Vec3[], from: { point: Vec3; segment: number }, to: { point: Vec3; segment: number }): Vec3[] {
  if (from.segment === to.segment) return [from.point, to.point];
  const out: Vec3[] = [from.point];
  for (let i = from.segment + 1; i <= to.segment; i++) out.push(route[i]);
  out.push(to.point);
  return out;
}

function sharedRouteCandidates(a: Vec3, b: Vec3, priorRoutes: Vec3[][], maxJoin: number): Vec3[][] {
  const out: Vec3[][] = [];
  for (const route of priorRoutes) {
    const start = closestPointOnRoute(a, route);
    const end = closestPointOnRoute(b, route);
    if (!start || !end || start.distance > maxJoin || end.distance > maxJoin) continue;
    const forward = start.segment < end.segment || (start.segment === end.segment && start.t <= end.t);
    const trunk = forward
      ? subRoute(route, start, end)
      : subRoute([...route].reverse(), closestPointOnRoute(a, [...route].reverse())!, closestPointOnRoute(b, [...route].reverse())!);
    out.push([a, ...trunk, b]);
  }
  return out;
}

function sharedRouteTrunks(a: Vec3, b: Vec3, priorRoutes: Vec3[][], maxJoin: number): Vec3[][] {
  const out: Vec3[][] = [];
  for (const route of priorRoutes) {
    const start = closestPointOnRoute(a, route);
    const end = closestPointOnRoute(b, route);
    if (!start || !end || start.distance > maxJoin || end.distance > maxJoin) continue;
    const forward = start.segment < end.segment || (start.segment === end.segment && start.t <= end.t);
    out.push(forward
      ? subRoute(route, start, end)
      : subRoute([...route].reverse(), closestPointOnRoute(a, [...route].reverse())!, closestPointOnRoute(b, [...route].reverse())!));
  }
  return out;
}

function planarizeRoute(a: Vec3, b: Vec3): Vec3[] {
  const routeZ = Math.max(a[2], b[2]);
  const start: Vec3 = [a[0], a[1], routeZ];
  const end: Vec3 = [b[0], b[1], routeZ];
  const out: Vec3[] = [];
  if (Math.abs(a[2] - routeZ) > 1e-6) out.push(a);
  out.push(start);
  if (Math.abs(start[0] - end[0]) > 1e-6 || Math.abs(start[1] - end[1]) > 1e-6) out.push(end);
  if (Math.abs(b[2] - routeZ) > 1e-6) out.push(b);
  return out;
}

function routedConnectionPoints(
  a: Vec3,
  b: Vec3,
  obstacles: AABB[],
  radius: number,
  preferredBounds: AABB | null,
  priorRoutes: Vec3[][] = [],
): Vec3[] {
  const planar = planarizeRoute(a, b);
  const floorZ = Math.min(a[2], b[2]);
  const joinLimit = Math.max(8, radius * 4);
  const shared = sharedRouteCandidates(a, b, priorRoutes, joinLimit)
    .filter((candidate) => pathClear(candidate, obstacles) && pathInsideBounds(candidate, preferredBounds));
  for (const trunk of sharedRouteTrunks(a, b, priorRoutes, joinLimit)) {
    const trunkStart = trunk[0];
    const trunkEnd = trunk[trunk.length - 1];
    const joinA = routedConnectionPoints(a, trunkStart, obstacles, radius, preferredBounds, []);
    const joinB = routedConnectionPoints(trunkEnd, b, obstacles, radius, preferredBounds, []);
    const candidate = [...joinA, ...trunk.slice(1), ...joinB.slice(1)];
    if (pathClear(candidate, obstacles) && pathInsideBounds(candidate, preferredBounds)) shared.push(candidate);
  }
  const directCandidates = [
    planar,
    [a, b],
  ].filter((candidate) => pathClear(candidate, obstacles) && pathInsideBounds(candidate, preferredBounds));
  const baseline = directCandidates[0] ?? null;
  const baselineLen = baseline ? pathLength(baseline) : Infinity;
  let bestShared: Vec3[] | null = null;
  let bestSharedLen = Infinity;
  for (const candidate of shared) {
    const len = routeCost(candidate, floorZ);
    if (len < bestSharedLen) {
      bestShared = candidate;
      bestSharedLen = len;
    }
  }
  // Prefer reusing an existing corridor: a slightly longer shared trunk is
  // usually better than carving two parallel wire channels through the base.
  if (bestShared && bestSharedLen <= baselineLen * 1.9 + 30) return bestShared;
  if (baseline) return baseline;


  const margin = Math.max(1, radius + 0.75);
  const candidates: Vec3[][] = [];
  for (const axis of [0, 1]) {
    const coords = new Set<number>();
    for (const obstacle of obstacles) {
      coords.add(obstacle.min[axis] - margin);
      coords.add(obstacle.max[axis] + margin);
    }
    for (const coord of coords) {
      const p1: Vec3 = [...a];
      const p2: Vec3 = [...b];
      p1[axis] = coord;
      p2[axis] = coord;
      candidates.push([a, p1, p2, b]);
    }
  }

  const internal = preferredBounds
    ? candidates.filter((candidate) => pathInsideBounds(candidate, preferredBounds))
    : candidates;
  let best: Vec3[] | null = null;
  let bestLen = Infinity;
  for (const candidate of internal) {
    if (!pathClear(candidate, obstacles)) continue;
    const len = routeCost(candidate, floorZ);
    if (len < bestLen) {
      best = candidate;
      bestLen = len;
    }
  }
  if (best) return best;

  for (const candidate of candidates) {
    if (!pathClear(candidate, obstacles)) continue;
    const len = routeCost(candidate, floorZ);
    if (len < bestLen) {
      best = candidate;
      bestLen = len;
    }
  }
  if (best) return best;

  const zCandidates: Vec3[][] = [];
  for (const obstacle of obstacles) {
    for (const coord of [obstacle.min[2] - margin, obstacle.max[2] + margin]) {
      const p1: Vec3 = [...a];
      const p2: Vec3 = [...b];
      p1[2] = coord;
      p2[2] = coord;
      zCandidates.push([a, p1, p2, b]);
    }
  }
  for (const candidate of zCandidates) {
    if (!pathClear(candidate, obstacles)) continue;
    const len = routeCost(candidate, floorZ);
    if (len < bestLen) {
      best = candidate;
      bestLen = len;
    }
  }
  return best ?? [a, b];
}

function localConnectionEndpointBox(
  endpoint: ConnectionEndpoint,
  connection: Connection,
  itemAabb: AABB,
): AABB | null {
  const face = faceFrame(endpoint.face, itemAabb);
  const diameter = Math.max(0, connection.width);
  const halfW = (connection.shape === "round" ? diameter : connection.width) / 2 + connection.clearance;
  const halfH = (connection.shape === "round" ? diameter : connection.height) / 2 + connection.clearance;
  if (halfW <= 0 || halfH <= 0) return null;
  const uCenter = face.uMin + endpoint.u;
  const vCenter = face.vMin + endpoint.v;
  const depth = Math.max(0.5, endpoint.depth) + connection.clearance;
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  min[face.uAxis] = uCenter - halfW;
  max[face.uAxis] = uCenter + halfW;
  min[face.vAxis] = vCenter - halfH;
  max[face.vAxis] = vCenter + halfH;
  if (face.outward > 0) {
    min[face.nAxis] = face.plane - depth;
    max[face.nAxis] = face.plane + depth;
  } else {
    min[face.nAxis] = face.plane - depth;
    max[face.nAxis] = face.plane + depth;
  }
  return { min, max };
}

function connectionEndpointRoutePoints(
  endpoint: ConnectionEndpoint,
  connection: Connection,
  item: ItemRequest,
): { surface: Vec3; escape: Vec3 } {
  const face = faceFrame(endpoint.face, item.aabb);
  const local: Vec3 = [0, 0, 0];
  local[face.nAxis] = face.plane;
  local[face.uAxis] = face.uMin + endpoint.u;
  local[face.vAxis] = face.vMin + endpoint.v;
  const normal: Vec3 = [0, 0, 0];
  normal[face.nAxis] = face.outward;
  const surface = transformPoint(local, item.rotation, item.position);
  const worldNormal = normalize(rotateVector(normal, item.rotation)) ?? normal;
  const escape = Math.abs(worldNormal[2]) > 0.8
    ? surface
    : addScaled(surface, worldNormal, routeRadius(connection) + 0.75);
  return { surface, escape };
}

function connectionSegmentManifold(
  M: ManifoldNs,
  connection: Connection,
  aCenter: Vec3,
  bCenter: Vec3,
): ManifoldInst | null {
  const delta = subVec(bCenter, aCenter);
  const frame = perpendicularFrame(delta);
  if (!frame) return null;

  const hullFn = (M.Manifold as unknown as {
    hull: (p: Array<[number, number, number]>) => ManifoldInst;
  }).hull;
  const pts: Array<[number, number, number]> = [];
  if (connection.shape === "round") {
    const radius = Math.max(0, connection.width / 2 + connection.clearance);
    if (radius <= 0) return null;
    const segs = 32;
    for (const center of [aCenter, bCenter]) {
      for (let i = 0; i < segs; i++) {
        const t = (i / segs) * Math.PI * 2;
        const p = addScaled(addScaled(center, frame.u, Math.cos(t) * radius), frame.v, Math.sin(t) * radius);
        pts.push(p);
      }
    }
  } else {
    const halfW = Math.max(0, connection.width / 2 + connection.clearance);
    const halfH = Math.max(0, connection.height / 2 + connection.clearance);
    if (halfW <= 0 || halfH <= 0) return null;
    for (const center of [aCenter, bCenter]) {
      for (const uSign of [-1, 1]) {
        for (const vSign of [-1, 1]) {
          const p = addScaled(addScaled(center, frame.u, uSign * halfW), frame.v, vSign * halfH);
          pts.push(p);
        }
      }
    }
  }
  return hullFn(pts);
}

function connectionCorridorManifolds(
  M: ManifoldNs,
  connection: Connection,
  route: Vec3[],
): ManifoldInst[] {
  const out: ManifoldInst[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const segment = connectionSegmentManifold(M, connection, route[i], route[i + 1]);
    if (segment) out.push(segment);
  }
  return out;
}

function connectionHeadspaceManifolds(
  M: ManifoldNs,
  connection: Connection,
  route: Vec3[],
  zMax: number,
): ManifoldInst[] {
  const pad = routeRadius(connection);
  const hullFn = (M.Manifold as unknown as {
    hull: (p: Array<[number, number, number]>) => ManifoldInst;
  }).hull;
  const manifolds: ManifoldInst[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const zMin = Math.min(a[2], b[2]) - pad;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len <= 1e-6) {
      const box = {
        min: [a[0] - pad, a[1] - pad, zMin] as Vec3,
        max: [a[0] + pad, a[1] + pad, zMax] as Vec3,
      };
      if (isPositive(box)) manifolds.push(boxFromAabb(M.Manifold, box));
      continue;
    }
    const nx = -dy / len;
    const ny = dx / len;
    const corners: Array<[number, number, number]> = [];
    for (const z of [zMin, zMax]) {
      corners.push(
        [a[0] + nx * pad, a[1] + ny * pad, z],
        [a[0] - nx * pad, a[1] - ny * pad, z],
        [b[0] + nx * pad, b[1] + ny * pad, z],
        [b[0] - nx * pad, b[1] - ny * pad, z],
      );
    }
    manifolds.push(hullFn(corners));
  }
  const capRadius = pad * 1.15;
  for (const point of route) {
    const box = {
      min: [point[0] - capRadius, point[1] - capRadius, point[2] - pad] as Vec3,
      max: [point[0] + capRadius, point[1] + capRadius, zMax] as Vec3,
    };
    if (isPositive(box)) manifolds.push(boxFromAabb(M.Manifold, box));
  }
  return manifolds;
}

interface PlannedConnection {
  aWorld: AABB;
  bWorld: AABB;
  route: Vec3[];
  bounds: AABB;
  connection: Connection;
}

function aabbFromPoints(points: Vec3[], pad: number): AABB {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    min[0] = Math.min(min[0], p[0] - pad);
    min[1] = Math.min(min[1], p[1] - pad);
    min[2] = Math.min(min[2], p[2] - pad);
    max[0] = Math.max(max[0], p[0] + pad);
    max[1] = Math.max(max[1], p[1] + pad);
    max[2] = Math.max(max[2], p[2] + pad);
  }
  return { min, max };
}

function unionTwoAabbs(a: AABB, b: AABB): AABB {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

function planConnections(
  connections: Connection[],
  items: ItemRequest[],
  preferredBounds: AABB | null,
): PlannedConnection[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const planned: PlannedConnection[] = [];
  for (const connection of connections) {
    const aItem = byId.get(connection.a.itemId);
    const bItem = byId.get(connection.b.itemId);
    if (!aItem || !bItem) continue;
    const aLocal = localConnectionEndpointBox(connection.a, connection, aItem.aabb);
    const bLocal = localConnectionEndpointBox(connection.b, connection, bItem.aabb);
    if (!aLocal || !bLocal) continue;
    const aWorld = transformedAabb(aLocal, aItem.rotation, aItem.position);
    const bWorld = transformedAabb(bLocal, bItem.rotation, bItem.position);
    const radius = routeRadius(connection);
    const obstacles = items
      .filter((item) =>
        !(item.id === aItem.id && connection.a.face === "+z") &&
        !(item.id === bItem.id && connection.b.face === "+z")
      )
      .map((item) => expandBox(transformedAabb(item.aabb, item.rotation, item.position), radius));
    const aRoute = connectionEndpointRoutePoints(connection.a, connection, aItem);
    const bRoute = connectionEndpointRoutePoints(connection.b, connection, bItem);
    const coreRoute = routedConnectionPoints(
      aRoute.escape,
      bRoute.escape,
      obstacles,
      radius,
      preferredBounds,
      planned.map((prior) => prior.route),
    );
    const route = [aRoute.surface, ...coreRoute, bRoute.surface];
    const bounds = unionTwoAabbs(unionTwoAabbs(aWorld, bWorld), aabbFromPoints(route, radius));
    planned.push({ aWorld, bWorld, route, bounds, connection });
  }
  return planned;
}

export function debugPlanConnectionRoutes(
  connections: Connection[],
  items: ItemRequest[],
  preferredBounds: AABB | null,
): Vec3[][] {
  return planConnections(connections, items, preferredBounds).map((planned) => planned.route);
}

function connectionManifolds(
  M: ManifoldNs,
  planned: PlannedConnection[],
): { cavity: ManifoldInst[]; debug: ManifoldInst[] } {
  const cavity: ManifoldInst[] = [];
  const debug: ManifoldInst[] = [];
  for (const { connection, aWorld, bWorld, route } of planned) {
    const corridor = connectionCorridorManifolds(M, connection, route);
    const aPad = boxFromAabb(M.Manifold, aWorld);
    const bPad = boxFromAabb(M.Manifold, bWorld);
    cavity.push(aPad, bPad);
    debug.push(aPad, bPad);
    if (corridor.length > 0) {
      cavity.push(...corridor);
      debug.push(...corridor);
    }
  }
  return { cavity, debug };
}

export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const M = await getManifold();
  const { Manifold } = M;
  const { params, items, cutouts } = req;
  const connections = req.connections ?? [];
  const globalClearance = params.clearance;

  if (items.length === 0) {
    // Empty-state: tiny placeholder box so UI never NaNs.
    const empty: AABB = { min: [-1, -1, -1], max: [1, 1, 1] };
    const geom = buildEnclosureGeometry(empty, params);
    const shell = boxFromAabb(Manifold, geom.outer).subtract(boxFromAabb(Manifold, geom.inner));
    const mesh = toMeshData(shell);
    return Comlink.transfer(
      { base: mesh, lid: mesh, outer: geom.outer, bodyOuter: geom.outer },
      [mesh.positions.buffer, mesh.indices.buffer],
    );
  }

  // Per-item world AABBs + local-fit cavities. Flushed items additionally
  // contribute a wall cutout used to pierce the shell.
  const perItemCutout: Array<{ face: FaceAxis; manifold: ManifoldInst } | null> = [];
  const perItemCavity: Array<ManifoldInst | null> = [];
  const perItemRelief: Array<AABB | null> = [];
  const perItemAabb: AABB[] = [];
  const perItemSizingAabb: AABB[] = [];
  const perItemClearance: number[] = [];
  for (const it of items) {
    const itemClearance = it.fitClearance ?? globalClearance;
    perItemClearance.push(itemClearance);
    const worldAabb = transformedAabb(it.aabb, it.rotation, it.position);
    perItemAabb.push(worldAabb);
    perItemSizingAabb.push(expandBox(worldAabb, Math.max(0, itemClearance - globalClearance)));
    const cacheKey = it.kind === "primitive"
      ? `${it.id}|prim|${it.flushFace}|${params.wall}|${JSON.stringify(it.primitive)}|${itemClearance}`
      : `${it.id}|imp|${it.flushFace}|${params.wall}|${it.meshVersion ?? 0}|${itemClearance}`;
    let entry = itemCache.get(cacheKey);
    if (!entry) {
      const built = buildItemLocal(M, it, itemClearance, params.wall);
      if (built) {
        entry = { cavityLocal: built.cavity, cutoutLocal: built.cutout, reliefLocal: built.reliefLocal };
        setItemCacheEntry(cacheKey, entry);
      }
    }
    if (entry) {
      perItemCavity.push(applyPose(entry.cavityLocal, it.rotation, it.position));
      perItemRelief.push(entry.reliefLocal ? transformedAabb(entry.reliefLocal, it.rotation, it.position) : null);
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
      perItemRelief.push(null);
      perItemCutout.push(null);
    }
  }

  // Compute combinedAabb with flush exclusion: flushed items' contribution
  // on their flushed axis/side is excluded so the outer box doesn't grow to
  // accommodate the overshoot.
  const itemCombinedAabb = computeCombinedAabbWithFlush(items, perItemSizingAabb);
  const preliminaryGeom = buildEnclosureGeometry(itemCombinedAabb, params);
  const preliminaryConnections = planConnections(connections, items, preliminaryGeom.inner);
  const combinedAabb = preliminaryConnections.reduce(
    (acc, connection) => unionTwoAabbs(acc, connection.bounds),
    itemCombinedAabb,
  );
  const geom = buildEnclosureGeometry(combinedAabb, params);
  const plannedConnections = planConnections(connections, items, geom.inner);

  const outerBody = params.fillet > 0
    ? roundedBoxFromAabb(M, geom.outer, params.fillet)
    : boxFromAabb(Manifold, geom.outer);
  const interfaceBand = geom.interfaceFillet > 0
    ? roundedBoxFromAabb(M, geom.interfaceOuter, geom.interfaceFillet)
    : boxFromAabb(Manifold, geom.interfaceOuter);
  const outerBox = Manifold.union([outerBody, interfaceBand]);
  const reinforcedOuter: AABB = {
    min: [
      Math.min(geom.outer.min[0], geom.interfaceOuter.min[0]),
      Math.min(geom.outer.min[1], geom.interfaceOuter.min[1]),
      Math.min(geom.outer.min[2], geom.interfaceOuter.min[2]),
    ],
    max: [
      Math.max(geom.outer.max[0], geom.interfaceOuter.max[0]),
      Math.max(geom.outer.max[1], geom.interfaceOuter.max[1]),
      Math.max(geom.outer.max[2], geom.interfaceOuter.max[2]),
    ],
  };
  const clippedCutouts = perItemCutout.map((cutout) => cutout && ({
    face: cutout.face,
    manifold: extendCutoutToOuter(
      M, cutout.manifold, cutout.face, geom.outer, reinforcedOuter,
    ).intersect(
      boxFromAabb(Manifold, flushCutoutSlab(
        cutout.face,
        reinforcedOuter,
        params.wall + outerExtensionForFace(cutout.face, geom.outer, reinforcedOuter),
      )),
    ),
  }));

  const clippedCutoutManifolds = clippedCutouts
    .map((cutout) => (cutout && cutout.manifold.numTri() > 0 ? cutout.manifold : null))
    .filter((cutout): cutout is ManifoldInst => cutout !== null);

  const clippedCutoutBounds = clippedCutouts.map((cutout) =>
    cutout && cutout.manifold.numTri() > 0 ? manifoldAabb(cutout.manifold) : null,
  );

  const cavityBlocks: ManifoldInst[] = [];
  const fitDebugBlocks: ManifoldInst[] = [];
  const accessDebugBlocks: ManifoldInst[] = [];
  const baseAccessBlocks: ManifoldInst[] = [];
  const baseAccessCap = (pocket: AABB) => boxFromAabb(Manifold, {
    min: [pocket.min[0], pocket.min[1], geom.splitZ - 0.25],
    max: [pocket.max[0], pocket.max[1], geom.outer.max[2] + 1],
  });
  const reliefDebugBlocks: ManifoldInst[] = [];
  for (let i = 0; i < items.length; i++) {
    const cavity = perItemCavity[i];
    if (cavity) {
      cavityBlocks.push(cavity);
      fitDebugBlocks.push(cavity);
    }

    if (items[i].kind === "primitive" || items[i].kind === "import") {
      const dropInPocket = computeCavityPocket(
        perItemAabb[i],
        perItemClearance[i],
        geom.splitZ,
        items[i].flushFace,
        geom.inner,
      );
      const primitive = items[i].kind === "primitive" ? items[i].primitive : null;
      if (primitive?.kind === "cylinder" && primitive.axis !== "z" && !items[i].flushFace) {
        dropInPocket.min[2] = (perItemAabb[i].min[2] + perItemAabb[i].max[2]) / 2;
      }
      if (items[i].kind === "primitive") {
        const dropInBox = boxFromAabb(Manifold, dropInPocket);
        cavityBlocks.push(dropInBox);
        accessDebugBlocks.push(dropInBox);
      } else if (items[i].kind === "import" && items[i].parts) {
        const importItem = items[i];
        const topAccessMinZ = perItemAabb[i].max[2] + perItemClearance[i];
        if (geom.splitZ > topAccessMinZ + 1e-6) {
          const topAccessPocket: AABB = {
            min: [dropInPocket.min[0], dropInPocket.min[1], topAccessMinZ],
            max: [dropInPocket.max[0], dropInPocket.max[1], geom.splitZ],
          };
          const topAccessBox = boxFromAabb(Manifold, topAccessPocket);
          cavityBlocks.push(topAccessBox);
          accessDebugBlocks.push(topAccessBox);
        }
        if (!items[i].flushFace) {
          const accessFloor = computeImportUpperAccessFloor(
            importItem.parts ?? [],
            importItem.aabb,
            perItemClearance[i],
          );
          if (accessFloor !== null) {
            const upperPocket: AABB = {
              min: [dropInPocket.min[0], dropInPocket.min[1], accessFloor + items[i].position[2]],
              max: dropInPocket.max,
            };
            const upperBox = boxFromAabb(Manifold, upperPocket);
            cavityBlocks.push(upperBox);
            accessDebugBlocks.push(upperBox);
          }
        }
      }
      baseAccessBlocks.push(baseAccessCap(dropInPocket));
    }

    let supportZ = -Infinity;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (!horizontalOverlap(perItemAabb[i], perItemAabb[j])) continue;
      if (perItemAabb[j].max[2] >= perItemAabb[i].max[2]) continue;
      supportZ = Math.max(supportZ, perItemAabb[j].max[2] + perItemClearance[i]);
    }

    if (supportZ > -Infinity) {
      const accessPocket = computeAccessPocket(
        perItemAabb[i], perItemClearance[i], geom.splitZ, null, geom.inner, supportZ,
      );
      const accessBox = boxFromAabb(Manifold, accessPocket);
      cavityBlocks.push(accessBox);
      accessDebugBlocks.push(accessBox);
      baseAccessBlocks.push(baseAccessCap(accessPocket));
    }

    const flushFace = items[i].flushFace;
    const cutoutBounds = clippedCutoutBounds[i];
    if (!flushFace || !cutoutBounds) continue;

    const flushPocket = computeFlushAccessPocket(
      cutoutBounds, perItemClearance[i], geom.splitZ, geom.inner,
    );
    if (flushPocket) {
      const accessBox = boxFromAabb(Manifold, flushPocket);
      cavityBlocks.push(accessBox);
      accessDebugBlocks.push(accessBox);
      baseAccessBlocks.push(baseAccessCap(flushPocket));
    }

    const reliefBounds = perItemRelief[i];
    if (reliefBounds && shouldAddFrontRelief(flushFace, reliefBounds, cutoutBounds)) {
      const reliefCore = clampAabb(
        {
          min: [reliefBounds.min[0], reliefBounds.min[1], cutoutBounds.min[2] - perItemClearance[i]],
          max: [reliefBounds.max[0], reliefBounds.max[1], geom.splitZ],
        },
        geom.inner,
      );
      if (reliefCore) {
        const reliefBox = boxFromAabb(Manifold, reliefCore);
        cavityBlocks.push(reliefBox);
        reliefDebugBlocks.push(reliefBox);
        const wallPocket = flushWallPocket(reliefCore, flushFace, reinforcedOuter, geom.inner);
        if (wallPocket) {
          const wallBox = boxFromAabb(Manifold, wallPocket);
          cavityBlocks.push(wallBox);
          reliefDebugBlocks.push(wallBox);
        }
      }
    }
  }

  const connectionBlocks = connectionManifolds(M, plannedConnections);
  cavityBlocks.push(...connectionBlocks.cavity);
  for (const planned of plannedConnections) {
    const headspaces = connectionHeadspaceManifolds(M, planned.connection, planned.route, geom.splitZ);
    const baseHeadspaces = connectionHeadspaceManifolds(M, planned.connection, planned.route, geom.outer.max[2] + 1);
    for (const headspace of headspaces) {
      cavityBlocks.push(headspace);
      accessDebugBlocks.push(headspace);
    }
    baseAccessBlocks.push(...baseHeadspaces);
  }

  let cavity: ManifoldInst | null = null;
  if (cavityBlocks.length > 0) {
    cavity = cavityBlocks.length === 1 ? cavityBlocks[0] : Manifold.union(cavityBlocks);
    cavity = cavity.intersect(boxFromAabb(Manifold, geom.inner));
  }
  const fullInnerCavity = boxFromAabb(Manifold, geom.inner);

  let shell: ManifoldInst = cavity
    ? outerBox.subtract(cavity)
    : outerBox.subtract(fullInnerCavity);

  // Poke holes where bare item silhouettes cross the outer wall.
  let cutoutHull: ManifoldInst | null = null;
  if (clippedCutoutManifolds.length > 0) {
    cutoutHull = clippedCutoutManifolds.length === 1
      ? clippedCutoutManifolds[0]
      : Manifold.union(clippedCutoutManifolds);
    shell = shell.subtract(cutoutHull);
  }
  const manualCutouts: ManifoldInst[] = [];
  for (const c of cutouts) {
    const cutout = manualCutoutManifold(M, c, geom.outer, params.wall);
    if (cutout) {
      manualCutouts.push(extendCutoutToOuter(M, cutout, c.face, geom.outer, reinforcedOuter));
    }
  }
  const manualCutoutHull = unionAll(Manifold, manualCutouts);

  // Manual face-local cutouts (subtract from full shell).
  if (manualCutoutHull) {
    shell = shell.subtract(manualCutoutHull);
  }

  // Split at splitZ.
  const bigSize = Math.max(
    reinforcedOuter.max[0] - reinforcedOuter.min[0],
    reinforcedOuter.max[1] - reinforcedOuter.min[1],
    reinforcedOuter.max[2] - reinforcedOuter.min[2],
  ) * 4;
  const halfBelow = boxFromAabb(Manifold, {
    min: [reinforcedOuter.min[0] - bigSize, reinforcedOuter.min[1] - bigSize, reinforcedOuter.min[2] - bigSize],
    max: [reinforcedOuter.max[0] + bigSize, reinforcedOuter.max[1] + bigSize, geom.splitZ],
  });
  const halfAbove = boxFromAabb(Manifold, {
    min: [reinforcedOuter.min[0] - bigSize, reinforcedOuter.min[1] - bigSize, geom.splitZ],
    max: [reinforcedOuter.max[0] + bigSize, reinforcedOuter.max[1] + bigSize, reinforcedOuter.max[2] + bigSize],
  });

  let base: ManifoldInst = shell.intersect(halfBelow);
  let lid: ManifoldInst = shell.intersect(halfAbove);

  if (isPositive(geom.tongueOuter) && isPositive(geom.tongueInner)) {
    const to = boxFromAabb(Manifold, geom.tongueOuter);
    const ti = boxFromAabb(Manifold, geom.tongueInner);
    let ring = to.subtract(ti);
    if (geom.snapTabs && geom.snapTabs.length > 0) {
      ring = Manifold.union([ring, ...geom.snapTabs.filter(isPositive).map((tab) => boxFromAabb(Manifold, tab))]);
    }
    ring = ring.subtract(fullInnerCavity);
    if (cavity) ring = ring.subtract(cavity);
    if (cutoutHull) ring = ring.subtract(cutoutHull);
    if (manualCutoutHull) ring = ring.subtract(manualCutoutHull);
    base = Manifold.union([base, ring]);
  }

  const baseAccessHull = unionAll(Manifold, baseAccessBlocks);
  if (baseAccessHull) base = base.subtract(baseAccessHull);

  if (isPositive(geom.grooveOuter) && isPositive(geom.grooveInner)) {
    const go = boxFromAabb(Manifold, geom.grooveOuter);
    const gi = boxFromAabb(Manifold, geom.grooveInner);
    let groove = go.subtract(gi);
    if (geom.snapPockets && geom.snapPockets.length > 0) {
      groove = Manifold.union([groove, ...geom.snapPockets.filter(isPositive).map((tab) => boxFromAabb(Manifold, tab))]);
    }
    lid = lid.subtract(groove);
  }
  if (cutoutHull) {
    lid = lid.subtract(cutoutHull);
  }

  const debug: DebugMesh[] = [];
  const fitDebug = unionAll(Manifold, fitDebugBlocks);
  if (fitDebug && fitDebug.numTri() > 0) {
    debug.push({ key: "fit", mesh: toMeshData(fitDebug) });
  }
  const accessDebug = unionAll(Manifold, accessDebugBlocks);
  if (accessDebug && accessDebug.numTri() > 0) {
    debug.push({ key: "access", mesh: toMeshData(accessDebug) });
  }
  const reliefDebug = unionAll(Manifold, reliefDebugBlocks);
  if (reliefDebug && reliefDebug.numTri() > 0) {
    debug.push({ key: "relief", mesh: toMeshData(reliefDebug) });
  }
  if (cutoutHull && cutoutHull.numTri() > 0) {
    debug.push({ key: "cutout", mesh: toMeshData(cutoutHull) });
  }
  const connectionDebug = unionAll(Manifold, connectionBlocks.debug);
  if (connectionDebug && connectionDebug.numTri() > 0) {
    debug.push({ key: "connection", mesh: toMeshData(connectionDebug) });
  }

  const result: GenerateResult = {
    base: toMeshData(base),
    lid: toMeshData(lid),
    outer: reinforcedOuter,
    bodyOuter: geom.outer,
    debug,
  };
  const buffers: Transferable[] = [
    result.base.positions.buffer,
    result.base.indices.buffer,
    result.lid.positions.buffer,
    result.lid.indices.buffer,
  ];
  for (const helper of result.debug ?? []) {
    buffers.push(helper.mesh.positions.buffer, helper.mesh.indices.buffer);
  }
  return Comlink.transfer(result, buffers);
}

export const api = { generate };
export type WorkerApi = typeof api;

if (typeof self !== "undefined") {
  Comlink.expose(api);
}
