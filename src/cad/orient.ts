import type { AABB } from "./types";
import { computeAabb } from "./bbox";

export type OrientRotation = "none" | "xRot90" | "yNegRot90";

/**
 * Rotate a vertex cloud so the model's *thinnest* axis lies along Z.
 * Electronics boards are inherently flat — making the thin dimension "up" lets
 * the default base/lid split cut perpendicular to the board, which is what
 * users almost always want.
 *
 * Returns a new Float32Array if rotation is needed; the original is returned
 * when the model is already Z-thin.
 */
export function orientZUp(
  positions: Float32Array,
  aabb: AABB,
): { positions: Float32Array; aabb: AABB; rotation: OrientRotation } {
  const sx = aabb.max[0] - aabb.min[0];
  const sy = aabb.max[1] - aabb.min[1];
  const sz = aabb.max[2] - aabb.min[2];

  if (sz <= sx && sz <= sy) {
    return { positions, aabb, rotation: "none" };
  }

  const out = new Float32Array(positions.length);
  let rotation: OrientRotation;

  if (sy <= sx) {
    // Y is thinnest: rotate +90° about X axis so (x,y,z) -> (x, -z, y).
    for (let i = 0; i < positions.length; i += 3) {
      out[i] = positions[i];
      out[i + 1] = -positions[i + 2];
      out[i + 2] = positions[i + 1];
    }
    rotation = "xRot90";
  } else {
    // X is thinnest: rotate -90° about Y axis so (x,y,z) -> (-z, y, x).
    for (let i = 0; i < positions.length; i += 3) {
      out[i] = -positions[i + 2];
      out[i + 1] = positions[i + 1];
      out[i + 2] = positions[i];
    }
    rotation = "yNegRot90";
  }

  return { positions: out, aabb: computeAabb(out), rotation };
}
