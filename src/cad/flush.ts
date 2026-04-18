import type { AABB, FaceAxis, ItemRequest, Vec3 } from "./types";
import { faceAxisNum, faceSignNum } from "./types";
import { transformedAabb } from "./bbox";

/**
 * Compute the combined AABB for enclosure sizing, handling flushed items.
 *
 * On the flushed axis:
 *  - FLUSHED SIDE (e.g. max for "+x"): use the local rotated AABB so the
 *    outer wall stays put and the item can reach it (breaks circular growth).
 *  - OPPOSITE SIDE (e.g. min for "+x"): use the world AABB so the enclosure
 *    stays tight around the shifted item (no extra space on the far side).
 * Other axes always use the world AABB.
 */
export function computeCombinedAabbWithFlush(
  items: Pick<ItemRequest, "aabb" | "rotation" | "flushFace">[],
  perItemAabb: AABB[],
): AABB {
  const combined: AABB = {
    min: [Infinity, Infinity, Infinity] as Vec3,
    max: [-Infinity, -Infinity, -Infinity] as Vec3,
  };
  for (let i = 0; i < items.length; i++) {
    const box = perItemAabb[i];
    const flush = items[i].flushFace;
    if (flush) {
      const fAxis = faceAxisNum(flush);
      const fSign = faceSignNum(flush);
      const localRotated = transformedAabb(items[i].aabb, items[i].rotation, [0, 0, 0] as Vec3);
      for (let a = 0; a < 3; a++) {
        if (a === fAxis) {
          if (fSign > 0) {
            combined.min[a] = Math.min(combined.min[a], box.min[a]);
            combined.max[a] = Math.max(combined.max[a], localRotated.max[a]);
          } else {
            combined.min[a] = Math.min(combined.min[a], localRotated.min[a]);
            combined.max[a] = Math.max(combined.max[a], box.max[a]);
          }
        } else {
          combined.min[a] = Math.min(combined.min[a], box.min[a]);
          combined.max[a] = Math.max(combined.max[a], box.max[a]);
        }
      }
    } else {
      for (let a = 0; a < 3; a++) {
        combined.min[a] = Math.min(combined.min[a], box.min[a]);
        combined.max[a] = Math.max(combined.max[a], box.max[a]);
      }
    }
  }
  for (let a = 0; a < 3; a++) {
    if (!isFinite(combined.min[a]) || !isFinite(combined.max[a]) || combined.min[a] >= combined.max[a]) {
      combined.min[a] = -1;
      combined.max[a] = 1;
    }
  }
  return combined;
}

/**
 * Compute the cavity pocket AABB for a single item.
 *
 * The pocket is the item's world AABB expanded by clearance, extruded upward
 * to at least splitZ. For flushed items, the pocket spans the full inner box
 * on the flushed axis so no extra material appears on the opposite side.
 */
export function computeCavityPocket(
  itemAabb: AABB,
  clearance: number,
  splitZ: number,
  flushFace: FaceAxis | null | undefined,
  inner: AABB,
): AABB {
  const c = clearance;
  const cavTop = Math.max(splitZ, itemAabb.max[2] + c);
  const min: Vec3 = [itemAabb.min[0] - c, itemAabb.min[1] - c, itemAabb.min[2] - c];
  const max: Vec3 = [itemAabb.max[0] + c, itemAabb.max[1] + c, cavTop];
  if (flushFace) {
    const fAxis = faceAxisNum(flushFace);
    min[fAxis] = inner.min[fAxis];
    max[fAxis] = inner.max[fAxis];
  }
  return { min, max };
}

export function horizontalOverlap(a: AABB, b: AABB): boolean {
  return (
    Math.min(a.max[0], b.max[0]) > Math.max(a.min[0], b.min[0]) &&
    Math.min(a.max[1], b.max[1]) > Math.max(a.min[1], b.min[1])
  );
}

/**
 * Compute an access pocket that keeps the region above a lower supporting item
 * open up to the split plane for stacked assemblies.
 */
export function computeAccessPocket(
  itemAabb: AABB,
  clearance: number,
  splitZ: number,
  flushFace: FaceAxis | null | undefined,
  inner: AABB,
  zMin: number,
): AABB {
  const c = clearance;
  const min: Vec3 = [itemAabb.min[0] - c, itemAabb.min[1] - c, zMin];
  const max: Vec3 = [itemAabb.max[0] + c, itemAabb.max[1] + c, splitZ];
  if (flushFace) {
    const fAxis = faceAxisNum(flushFace);
    min[fAxis] = inner.min[fAxis];
    max[fAxis] = inner.max[fAxis];
  }
  return { min, max };
}

/**
 * Compute a narrow access pocket for a flushed wall opening so the split-plane
 * band stays open only around the actual cutout, not the item's full footprint.
 */
export function computeFlushAccessPocket(
  cutoutAabb: AABB,
  clearance: number,
  splitZ: number,
  inner: AABB,
): AABB | null {
  const min: Vec3 = [...cutoutAabb.min];
  const max: Vec3 = [...cutoutAabb.max];
  for (let a = 0; a < 3; a++) {
    min[a] = Math.max(inner.min[a], cutoutAabb.min[a] - clearance);
    max[a] = Math.min(inner.max[a], cutoutAabb.max[a] + clearance);
  }
  max[2] = Math.min(max[2], splitZ);
  if (max[2] <= min[2]) return null;
  return { min, max };
}
