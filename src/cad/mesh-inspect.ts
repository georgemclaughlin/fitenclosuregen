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
