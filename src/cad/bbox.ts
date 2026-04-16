import { AABB, Vec3 } from "./types";

export function computeAabb(positions: Float32Array): AABB {
  if (positions.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function aabbSize(a: AABB): Vec3 {
  return [a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]];
}

export function aabbCenter(a: AABB): Vec3 {
  return [
    (a.min[0] + a.max[0]) / 2,
    (a.min[1] + a.max[1]) / 2,
    (a.min[2] + a.max[2]) / 2,
  ];
}

/** Expand by (dx,dy,dz) on each side (total growth = 2*d). */
export function expandAabb(a: AABB, d: Vec3): AABB {
  return {
    min: [a.min[0] - d[0], a.min[1] - d[1], a.min[2] - d[2]],
    max: [a.max[0] + d[0], a.max[1] + d[1], a.max[2] + d[2]],
  };
}

/** Translate AABB so its min is at the given point. */
export function translateAabbTo(a: AABB, newMin: Vec3): AABB {
  const sz = aabbSize(a);
  return { min: newMin, max: [newMin[0] + sz[0], newMin[1] + sz[1], newMin[2] + sz[2]] };
}

/** Translate AABB by a delta. */
export function translateAabb(a: AABB, t: Vec3): AABB {
  return {
    min: [a.min[0] + t[0], a.min[1] + t[1], a.min[2] + t[2]],
    max: [a.max[0] + t[0], a.max[1] + t[1], a.max[2] + t[2]],
  };
}

/** 3x3 rotation matrix from Euler angles in degrees, applied XYZ. */
function eulerMatrix(rot: Vec3): number[] {
  const [rx, ry, rz] = rot.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz * Ry * Rx
  return [
    cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
    cy * sz, cx * cz + sx * sy * sz, -cz * sx + cx * sy * sz,
    -sy,     cy * sx,                cx * cy,
  ];
}

/** AABB of a local AABB after rotating its 8 corners and translating. Conservative. */
export function transformedAabb(local: AABB, rotation: Vec3, position: Vec3): AABB {
  const m = eulerMatrix(rotation);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) ? local.max[0] : local.min[0];
    const y = (i & 2) ? local.max[1] : local.min[1];
    const z = (i & 4) ? local.max[2] : local.min[2];
    const rx = m[0] * x + m[1] * y + m[2] * z + position[0];
    const ry = m[3] * x + m[4] * y + m[5] * z + position[1];
    const rz = m[6] * x + m[7] * y + m[8] * z + position[2];
    if (rx < min[0]) min[0] = rx; if (rx > max[0]) max[0] = rx;
    if (ry < min[1]) min[1] = ry; if (ry > max[1]) max[1] = ry;
    if (rz < min[2]) min[2] = rz; if (rz > max[2]) max[2] = rz;
  }
  return { min, max };
}

/** Union of AABBs. Returns an empty (collapsed) box if list is empty. */
export function unionAabbs(boxes: AABB[]): AABB {
  if (boxes.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < min[i]) min[i] = b.min[i];
      if (b.max[i] > max[i]) max[i] = b.max[i];
    }
  }
  return { min, max };
}
