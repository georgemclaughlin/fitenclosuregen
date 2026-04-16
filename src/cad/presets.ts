import type { AABB, Primitive, Vec3 } from "./types";

export interface PresetSpec {
  label: string;
  primitive: Primitive;
}

/**
 * Dimensions are nominal — real cells vary by a few tenths of a millimeter.
 * Feed them through the usual `clearance` param to get a fit.
 */
export const BATTERY_PRESETS: PresetSpec[] = [
  { label: "18650 (cylindrical)", primitive: { kind: "cylinder", axis: "x", radius: 9.3, height: 65.2 } },
  { label: "21700 (cylindrical)", primitive: { kind: "cylinder", axis: "x", radius: 10.6, height: 70.2 } },
  { label: "AA / 14500", primitive: { kind: "cylinder", axis: "x", radius: 7.25, height: 50.5 } },
  { label: "AAA / 10440", primitive: { kind: "cylinder", axis: "x", radius: 5.25, height: 44.5 } },
  { label: "CR2032 coin", primitive: { kind: "cylinder", axis: "z", radius: 10.0, height: 3.2 } },
  { label: "CR2025 coin", primitive: { kind: "cylinder", axis: "z", radius: 10.0, height: 2.5 } },
  { label: "9V PP3", primitive: { kind: "box", size: [26.5, 17.5, 48.5] } },
  { label: "LiPo 503450 (500 mAh)", primitive: { kind: "box", size: [50.0, 34.0, 5.0] } },
  { label: "LiPo 603443 (800 mAh)", primitive: { kind: "box", size: [43.0, 34.0, 6.0] } },
  { label: "LiPo 502030 (250 mAh)", primitive: { kind: "box", size: [30.0, 20.0, 5.0] } },
  { label: "LiPo 103450 (1800 mAh)", primitive: { kind: "box", size: [50.0, 34.0, 10.0] } },
];

export const PRIMITIVE_DEFAULTS: Record<Primitive["kind"], Primitive> = {
  box: { kind: "box", size: [20, 20, 10] },
  cylinder: { kind: "cylinder", axis: "z", radius: 10, height: 20 },
};

/** Local-frame AABB of a primitive. Origin is always the centroid. */
export function primitiveAabb(p: Primitive): AABB {
  if (p.kind === "box") {
    const [sx, sy, sz] = p.size;
    return { min: [-sx / 2, -sy / 2, -sz / 2], max: [sx / 2, sy / 2, sz / 2] };
  }
  const r = p.radius;
  const h = p.height;
  const he = h / 2;
  switch (p.axis) {
    case "x": return { min: [-he, -r, -r], max: [he, r, r] };
    case "y": return { min: [-r, -he, -r], max: [r, he, r] };
    case "z": return { min: [-r, -r, -he], max: [r, r, he] };
  }
}

export function primitiveSize(p: Primitive): Vec3 {
  const a = primitiveAabb(p);
  return [a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]];
}
