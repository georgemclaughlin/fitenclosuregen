import type { AABB, MeshData, Vec3 } from "./types";

function triVertex(mesh: MeshData, triIndex: number, corner: 0 | 1 | 2): Vec3 {
  const vertIndex = mesh.indices[triIndex * 3 + corner] * 3;
  return [
    mesh.positions[vertIndex],
    mesh.positions[vertIndex + 1],
    mesh.positions[vertIndex + 2],
  ];
}

function boxesOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
  );
}

function triBounds(mesh: MeshData, triIndex: number): AABB {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const corner of [0, 1, 2] as const) {
    const v = triVertex(mesh, triIndex, corner);
    for (let axis = 0; axis < 3; axis++) {
      if (v[axis] < min[axis]) min[axis] = v[axis];
      if (v[axis] > max[axis]) max[axis] = v[axis];
    }
  }
  return { min, max };
}

/** Conservative overlap: counts triangles whose AABB overlaps the sample box. */
export function countTrianglesOverlappingAabb(mesh: MeshData, sample: AABB): number {
  let hits = 0;
  const triCount = mesh.indices.length / 3;
  for (let tri = 0; tri < triCount; tri++) {
    if (boxesOverlap(triBounds(mesh, tri), sample)) hits++;
  }
  return hits;
}

/** True when a point is inside a consistently wound closed triangle mesh. */
export function meshContainsPoint(mesh: MeshData, point: Vec3): boolean {
  let solidAngle = 0;
  const triCount = mesh.indices.length / 3;
  for (let tri = 0; tri < triCount; tri++) {
    const vectors = ([0, 1, 2] as const).map((corner) => {
      const v = triVertex(mesh, tri, corner);
      return [v[0] - point[0], v[1] - point[1], v[2] - point[2]] as Vec3;
    });
    const [a, b, c] = vectors;
    const la = Math.hypot(...a);
    const lb = Math.hypot(...b);
    const lc = Math.hypot(...c);
    const crossBC: Vec3 = [
      b[1] * c[2] - b[2] * c[1],
      b[2] * c[0] - b[0] * c[2],
      b[0] * c[1] - b[1] * c[0],
    ];
    const numerator = a[0] * crossBC[0] + a[1] * crossBC[1] + a[2] * crossBC[2];
    const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const bc = b[0] * c[0] + b[1] * c[1] + b[2] * c[2];
    const ca = c[0] * a[0] + c[1] * a[1] + c[2] * a[2];
    const denominator = la * lb * lc + ab * lc + bc * la + ca * lb;
    solidAngle += 2 * Math.atan2(numerator, denominator);
  }
  return Math.abs(solidAngle) > Math.PI * 2;
}
