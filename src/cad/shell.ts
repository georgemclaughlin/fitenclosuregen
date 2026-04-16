import type { AABB, Cutout, EnclosureParams, FaceAxis } from "./types";

/**
 * Pure geometric description of the enclosure, independent of any CSG engine.
 * Given a component AABB and params, produce the AABBs and lip boxes needed
 * for the worker to build the mesh. Unit-testable without WASM.
 */

export interface EnclosureGeometry {
  /** Inner cavity AABB (air gap around component). */
  inner: AABB;
  /** Outer shell AABB. */
  outer: AABB;
  /** Horizontal plane Z where the shell is cut into base/lid. */
  splitZ: number;
  /** Tongue ring (on base): outer and inner AABBs defining the ring footprint. */
  tongueOuter: AABB;
  tongueInner: AABB;
  tongueZMin: number;
  tongueZMax: number;
  /** Groove slot (in lid): slightly larger than tongue, with vertical tolerance. */
  grooveOuter: AABB;
  grooveInner: AABB;
  grooveZMin: number;
  grooveZMax: number;
  /** Snap bead ring on the tongue, present only when snapFit is enabled. */
  snapBeadOuter?: AABB;
  snapBeadInner?: AABB;
  /** Matching recess carved from the groove to receive the bead. */
  snapRecessOuter?: AABB;
  snapRecessInner?: AABB;
}

export function buildEnclosureGeometry(
  comp: AABB,
  p: EnclosureParams,
): EnclosureGeometry {
  const { wall, floor, clearance, lidFrac, lipDepth, lipTol, snapFit, snapSize } = p;

  const inner: AABB = {
    min: [comp.min[0] - clearance, comp.min[1] - clearance, comp.min[2] - clearance],
    max: [comp.max[0] + clearance, comp.max[1] + clearance, comp.max[2] + clearance],
  };
  const outer: AABB = {
    min: [comp.min[0] - clearance - wall, comp.min[1] - clearance - wall, comp.min[2] - clearance - floor],
    max: [comp.max[0] + clearance + wall, comp.max[1] + clearance + wall, comp.max[2] + clearance + wall],
  };

  const outerHeight = outer.max[2] - outer.min[2];
  // User-requested lid height from lidFrac, but grow it if needed so the lip
  // gets its full depth (lipDepth of tongue + lipTol vertical play + wall on
  // top). Without this, thin components produce a sub-millimeter lip that
  // barely grips.
  const desiredLidHeight = lidFrac * outerHeight;
  const minLidHeight = wall + lipDepth + lipTol;
  const lidHeight = Math.max(desiredLidHeight, Math.min(minLidHeight, outerHeight - wall));
  const splitZ = outer.max[2] - lidHeight;

  // Tongue: thin ring centered in the wall, thickness = wall/2.
  // Distance from inner face to ring center = wall/2 (midline of wall).
  // Half-thickness of the ring = wall/4. Shrink by lipTol on each side for fit.
  //
  // Height of the lip is shared by tongue and groove: the groove must be deep
  // enough to swallow the tongue plus vertical play, while still leaving at
  // least `wall` of solid material above the groove so thin lids don't get
  // slots punched through the ceiling. We shorten the tongue to match when a
  // thin lid forces the groove to be capped.
  const effectiveLipDepth = Math.max(
    0,
    Math.min(lipDepth, lidHeight - wall - lipTol),
  );
  // When snap-fit is on, shift the tongue/groove ring inboard (toward cavity)
  // to create outboard room for the bead and recess. Without this, on typical
  // 2 mm walls the recess would punch through the outer wall.
  const ringShift = snapFit && snapSize > 0 ? Math.min(snapSize + lipTol, wall / 4) : 0;
  // Distance from inner cavity face to ring centerline.
  const ringCenterOff = wall / 2 - ringShift;

  const tHalf = wall / 4 - lipTol;
  const tongueOuter: AABB = {
    min: [inner.min[0] - (ringCenterOff + tHalf), inner.min[1] - (ringCenterOff + tHalf), splitZ],
    max: [inner.max[0] + (ringCenterOff + tHalf), inner.max[1] + (ringCenterOff + tHalf), splitZ + effectiveLipDepth],
  };
  const tongueInner: AABB = {
    min: [inner.min[0] - (ringCenterOff - tHalf), inner.min[1] - (ringCenterOff - tHalf), splitZ],
    max: [inner.max[0] + (ringCenterOff - tHalf), inner.max[1] + (ringCenterOff - tHalf), splitZ + effectiveLipDepth],
  };

  // Groove: mirror of tongue but with lipTol added on all sides, and extra depth.
  const gHalf = wall / 4 + lipTol;
  const grooveZMax = splitZ + effectiveLipDepth + lipTol;
  const grooveOuter: AABB = {
    min: [
      inner.min[0] - (ringCenterOff + gHalf),
      inner.min[1] - (ringCenterOff + gHalf),
      splitZ - lipTol,
    ],
    max: [
      inner.max[0] + (ringCenterOff + gHalf),
      inner.max[1] + (ringCenterOff + gHalf),
      grooveZMax,
    ],
  };
  const grooveInner: AABB = {
    min: [
      inner.min[0] - (ringCenterOff - gHalf),
      inner.min[1] - (ringCenterOff - gHalf),
      splitZ - lipTol,
    ],
    max: [
      inner.max[0] + (ringCenterOff - gHalf),
      inner.max[1] + (ringCenterOff - gHalf),
      grooveZMax,
    ],
  };

  // Snap bead: a thin outward-facing ring at the top of the tongue, plus a
  // matching recess in the groove. The lid's top plate flexes slightly during
  // insertion; when the bead clears the narrow groove entry it clicks into the
  // wider recess and retains the lid.
  let snapBeadOuter: AABB | undefined;
  let snapBeadInner: AABB | undefined;
  let snapRecessOuter: AABB | undefined;
  let snapRecessInner: AABB | undefined;
  if (snapFit && snapSize > 0 && effectiveLipDepth > 0) {
    // Available wall room outboard of the groove's outer face before we break
    // through the outer wall. Leave a minimum skin so the lid doesn't split.
    const minSkin = 0.4;
    const grooveOuterToWall = wall - (ringCenterOff + gHalf); // outboard room past groove
    const maxRecessPad = Math.max(0, grooveOuterToWall - minSkin);
    const recessPad = Math.min(snapSize + lipTol, maxRecessPad);
    const effSnapSize = Math.max(0, recessPad - lipTol);
    const beadH = Math.min(Math.max(0.6, effectiveLipDepth * 0.35), effectiveLipDepth - 0.1);
    if (beadH > 0 && effSnapSize > 0) {
      const tongueZMax = splitZ + effectiveLipDepth;
      const beadZMin = tongueZMax - beadH;
      const beadZMax = tongueZMax;
      snapBeadInner = {
        min: [tongueOuter.min[0], tongueOuter.min[1], beadZMin],
        max: [tongueOuter.max[0], tongueOuter.max[1], beadZMax],
      };
      snapBeadOuter = {
        min: [tongueOuter.min[0] - effSnapSize, tongueOuter.min[1] - effSnapSize, beadZMin],
        max: [tongueOuter.max[0] + effSnapSize, tongueOuter.max[1] + effSnapSize, beadZMax],
      };
      snapRecessInner = {
        min: [grooveOuter.min[0], grooveOuter.min[1], beadZMin],
        max: [grooveOuter.max[0], grooveOuter.max[1], beadZMax + lipTol],
      };
      snapRecessOuter = {
        min: [grooveOuter.min[0] - recessPad, grooveOuter.min[1] - recessPad, beadZMin],
        max: [grooveOuter.max[0] + recessPad, grooveOuter.max[1] + recessPad, beadZMax + lipTol],
      };
    }
  }

  return {
    inner,
    outer,
    splitZ,
    tongueOuter,
    tongueInner,
    tongueZMin: splitZ,
    tongueZMax: splitZ + effectiveLipDepth,
    grooveOuter,
    grooveInner,
    grooveZMin: splitZ - lipTol,
    grooveZMax,
    snapBeadOuter,
    snapBeadInner,
    snapRecessOuter,
    snapRecessInner,
  };
}

/**
 * Resolve a cutout into a world-space AABB that will be subtracted from the shell.
 * The cutout is specified in face-local UV; we project it onto the correct outer face,
 * then extrude inward through the full wall plus a margin so it punches cleanly.
 */
export function cutoutBox(
  cutout: Cutout,
  outer: AABB,
  wallMargin: number,
): AABB {
  const margin = wallMargin + 1.0; // 1 mm over-extrude to guarantee a through hole
  const halfW = cutout.w / 2;
  const halfH = cutout.h / 2;

  // For each face: (normal axis, U axis, V axis, face plane coord)
  const face = faceFrame(cutout.face, outer);
  const uCenter = face.uMin + cutout.u;
  const vCenter = face.vMin + cutout.v;

  const box: AABB = { min: [0, 0, 0], max: [0, 0, 0] };

  // Fill along U
  (box.min as number[])[face.uAxis] = uCenter - halfW;
  (box.max as number[])[face.uAxis] = uCenter + halfW;
  // Fill along V
  (box.min as number[])[face.vAxis] = vCenter - halfH;
  (box.max as number[])[face.vAxis] = vCenter + halfH;
  // Fill along normal: from face plane inward by (wall+margin) outward by margin
  if (face.outward > 0) {
    (box.min as number[])[face.nAxis] = face.plane - (wallMargin + margin);
    (box.max as number[])[face.nAxis] = face.plane + margin;
  } else {
    (box.min as number[])[face.nAxis] = face.plane - margin;
    (box.max as number[])[face.nAxis] = face.plane + (wallMargin + margin);
  }
  return box;
}

interface FaceFrame {
  nAxis: 0 | 1 | 2;
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
  plane: number;
  outward: 1 | -1;
  uMin: number;
  vMin: number;
  uSize: number;
  vSize: number;
}

export function faceFrame(face: FaceAxis, outer: AABB): FaceFrame {
  const pick = (axis: 0 | 1 | 2) => ({
    min: outer.min[axis],
    max: outer.max[axis],
    size: outer.max[axis] - outer.min[axis],
  });
  const X = pick(0), Y = pick(1), Z = pick(2);
  switch (face) {
    case "+x":
      return { nAxis: 0, uAxis: 1, vAxis: 2, plane: X.max, outward: 1,
        uMin: Y.min, vMin: Z.min, uSize: Y.size, vSize: Z.size };
    case "-x":
      return { nAxis: 0, uAxis: 1, vAxis: 2, plane: X.min, outward: -1,
        uMin: Y.min, vMin: Z.min, uSize: Y.size, vSize: Z.size };
    case "+y":
      return { nAxis: 1, uAxis: 0, vAxis: 2, plane: Y.max, outward: 1,
        uMin: X.min, vMin: Z.min, uSize: X.size, vSize: Z.size };
    case "-y":
      return { nAxis: 1, uAxis: 0, vAxis: 2, plane: Y.min, outward: -1,
        uMin: X.min, vMin: Z.min, uSize: X.size, vSize: Z.size };
    case "+z":
      return { nAxis: 2, uAxis: 0, vAxis: 1, plane: Z.max, outward: 1,
        uMin: X.min, vMin: Y.min, uSize: X.size, vSize: Y.size };
    case "-z":
      return { nAxis: 2, uAxis: 0, vAxis: 1, plane: Z.min, outward: -1,
        uMin: X.min, vMin: Y.min, uSize: X.size, vSize: Y.size };
  }
}
