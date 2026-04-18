import { transformedAabb } from "./bbox";
import { primitiveAabb } from "./presets";
import type { AABB, Item, Vec3 } from "./types";

type Axis = 0 | 1 | 2;
type Sign = 1 | -1;

export function itemLocalAabb(it: Item): AABB {
  return it.kind === "import" ? it.mesh.aabb : primitiveAabb(it.primitive);
}

export function itemWorldAabb(it: Item): AABB {
  return transformedAabb(itemLocalAabb(it), it.rotation, it.position);
}

/** Place a new item alongside the current stack so it starts non-overlapping. */
export function placeAlongside(
  existing: Item[],
  localAabb: AABB,
  clearance: number,
): Vec3 {
  if (existing.length === 0) return [0, 0, 0];
  const boxes = existing.map(itemWorldAabb);
  const combined = {
    min: [Infinity, Infinity, Infinity] as Vec3,
    max: [-Infinity, -Infinity, -Infinity] as Vec3,
  };
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < combined.min[i]) combined.min[i] = b.min[i];
      if (b.max[i] > combined.max[i]) combined.max[i] = b.max[i];
    }
  }
  const extents: Vec3 = [
    combined.max[0] - combined.min[0],
    combined.max[1] - combined.min[1],
    combined.max[2] - combined.min[2],
  ];
  const axis: Axis = extents[0] >= extents[1] && extents[0] >= extents[2]
    ? 0
    : extents[1] >= extents[2] ? 1 : 2;
  const halfNew = (localAabb.max[axis] - localAabb.min[axis]) / 2;
  const centerNew = (localAabb.min[axis] + localAabb.max[axis]) / 2;
  const pos: Vec3 = [0, 0, 0];
  pos[axis] = combined.max[axis] + clearance + halfNew - centerNew;
  for (const a of [0, 1, 2] as const) {
    if (a === axis) continue;
    const c = (combined.min[a] + combined.max[a]) / 2;
    const localC = (localAabb.min[a] + localAabb.max[a]) / 2;
    pos[a] = c - localC;
  }
  return pos;
}

/** Move an item so one face sits clearance away from the other items. */
export function stackItemRelativePosition(
  item: Item,
  others: Item[],
  clearance: number,
  axis: Axis,
  sign: Sign,
): Vec3 {
  const pos: Vec3 = [item.position[0], item.position[1], item.position[2]];
  if (others.length === 0) {
    pos[axis] = 0;
    return pos;
  }

  const myWorld = itemWorldAabb(item);
  if (sign === 1) {
    let extent = -Infinity;
    for (const other of others) extent = Math.max(extent, itemWorldAabb(other).max[axis]);
    pos[axis] += extent + clearance - myWorld.min[axis];
  } else {
    let extent = Infinity;
    for (const other of others) extent = Math.min(extent, itemWorldAabb(other).min[axis]);
    pos[axis] += extent - clearance - myWorld.max[axis];
  }

  for (const a of [0, 1, 2] as const) {
    if (a === axis) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const other of others) {
      const ab = itemWorldAabb(other);
      lo = Math.min(lo, ab.min[a]);
      hi = Math.max(hi, ab.max[a]);
    }
    const targetCenter = (lo + hi) / 2;
    const myCenter = (myWorld.min[a] + myWorld.max[a]) / 2;
    pos[a] += targetCenter - myCenter;
  }
  return pos;
}
