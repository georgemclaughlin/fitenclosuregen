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
  /** Discrete snap tabs on the tongue, present only when snapFit is enabled. */
  snapTabs?: AABB[];
  /** Matching relief pockets carved from the groove to receive the tabs. */
  snapPockets?: AABB[];
}

export function buildEnclosureGeometry(
  comp: AABB,
  p: EnclosureParams,
): EnclosureGeometry {
  const { wall, floor, clearance, lidFrac, lipDepth, lipTol, snapFit, snapSize, snapPlacement } = p;

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
  const snapMinSkin = snapFit && snapSize > 0 ? Math.max(0.8, wall * 0.4) : 0;
  // When snap-fit is on, shift the tongue/groove ring inboard (toward cavity)
  // to create outboard room for the bead and recess. Without this, on typical
  // 2 mm walls the recess would punch through the outer wall.
  const maxRingShift = Math.max(0, wall / 4 + lipTol - 0.05);
  const ringShift = snapFit && snapSize > 0
    ? Math.min(snapSize + lipTol + 0.15, maxRingShift)
    : 0;
  // Distance from inner cavity face to ring centerline.
  const ringCenterOff = wall / 2 - ringShift;
  // Sink the tongue slightly below the split plane so the exported base is a
  // single watertight solid instead of two coplanar shells touching at z=splitZ.
  const tongueFuseDepth = Math.min(0.05, Math.max(0, effectiveLipDepth * 0.1));

  const tHalf = wall / 4 - lipTol;
  const tongueOuter: AABB = {
    min: [inner.min[0] - (ringCenterOff + tHalf), inner.min[1] - (ringCenterOff + tHalf), splitZ - tongueFuseDepth],
    max: [inner.max[0] + (ringCenterOff + tHalf), inner.max[1] + (ringCenterOff + tHalf), splitZ + effectiveLipDepth],
  };
  const tongueInner: AABB = {
    min: [inner.min[0] - (ringCenterOff - tHalf), inner.min[1] - (ringCenterOff - tHalf), splitZ - tongueFuseDepth],
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
  const snapGrooveOpenInset = snapFit && snapSize > 0 ? 0 : ringCenterOff - gHalf;
  const grooveInner: AABB = {
    min: [
      inner.min[0] - snapGrooveOpenInset,
      inner.min[1] - snapGrooveOpenInset,
      splitZ - lipTol,
    ],
    max: [
      inner.max[0] + snapGrooveOpenInset,
      inner.max[1] + snapGrooveOpenInset,
      grooveZMax,
    ],
  };

  // Discrete snap tabs on selected side walls are more slicer-friendly than a
  // continuous annular bead. They avoid leaving a paper-thin inner annulus in
  // the lid and fit the existing box-based CSG pipeline well.
  let snapTabs: AABB[] | undefined;
  let snapPockets: AABB[] | undefined;
  if (snapFit && snapSize > 0 && effectiveLipDepth > 0) {
    const tabAxis = snapPlacement.endsWith("x") ? 0 : 1;
    const crossAxis = tabAxis === 0 ? 1 : 0;
    const placements = snapPlacement.startsWith("both")
      ? ([1, -1] as Array<1 | -1>)
      : ([snapPlacement.startsWith("+") ? 1 : -1] as Array<1 | -1>);
    const positiveTabRoom = outer.max[tabAxis] - tongueOuter.max[tabAxis];
    const negativeTabRoom = tongueOuter.min[tabAxis] - outer.min[tabAxis];
    const positivePocketRoom = outer.max[tabAxis] - grooveOuter.max[tabAxis];
    const negativePocketRoom = grooveOuter.min[tabAxis] - outer.min[tabAxis];
    const availableTabRoom = Math.min(...placements.map((sign) => sign > 0 ? positiveTabRoom : negativeTabRoom));
    const availablePocketRoom = Math.min(...placements.map((sign) => sign > 0 ? positivePocketRoom : negativePocketRoom));
    const tabOutset = Math.min(Math.max(0.3, snapSize), Math.max(0, availableTabRoom - 0.2));
    const pocketOutset = Math.min(tabOutset + lipTol + 0.15, Math.max(0, availablePocketRoom - snapMinSkin));
    const tabHeight = Math.min(Math.max(0.9, effectiveLipDepth * 0.45), effectiveLipDepth - 0.1);
    const tabFuse = Math.min(0.08, tabOutset * 0.4);
    const tongueZMax = splitZ + effectiveLipDepth;
    const tabZMin = tongueZMax - tabHeight;
    const spanCross = tongueOuter.max[crossAxis] - tongueOuter.min[crossAxis];
    const minTabWidth = 5;
    const tabWidth = Math.min(Math.max(minTabWidth, spanCross * 0.18), Math.max(minTabWidth, spanCross / 2 - 2.5));
    const pocketMarginX = Math.max(lipTol + 0.2, 0.35);
    const crossMid = (tongueOuter.min[crossAxis] + tongueOuter.max[crossAxis]) / 2;
    const canFitTwo = spanCross >= minTabWidth * 2 + 4;
    const centerOffset = canFitTwo
      ? Math.max(
          tabWidth / 2 + 1.2,
          Math.min(spanCross * 0.22, spanCross / 2 - tabWidth / 2 - 1.2),
        )
      : 0;
    const tabCenters = canFitTwo ? [crossMid - centerOffset, crossMid + centerOffset] : [crossMid];
    if (tabOutset > 0.05 && pocketOutset > 0.05 && tabHeight > 0.1) {
      snapTabs = [];
      snapPockets = [];
      for (const sign of placements) {
        for (const center of tabCenters) {
          const tabCrossMin = center - tabWidth / 2;
          const tabCrossMax = center + tabWidth / 2;
          const pocketCrossMin = Math.max(grooveInner.min[crossAxis] + 0.6, tabCrossMin - pocketMarginX);
          const pocketCrossMax = Math.min(grooveInner.max[crossAxis] - 0.6, tabCrossMax + pocketMarginX);
          if (pocketCrossMax <= pocketCrossMin + 4) continue;

          const tabMin = [...tongueOuter.min] as [number, number, number];
          const tabMax = [...tongueOuter.max] as [number, number, number];
          tabMin[crossAxis] = tabCrossMin;
          tabMax[crossAxis] = tabCrossMax;
          tabMin[2] = tabZMin;
          tabMax[2] = tongueZMax;
          if (sign > 0) {
            tabMin[tabAxis] = tongueOuter.max[tabAxis] - tabFuse;
            tabMax[tabAxis] = tongueOuter.max[tabAxis] + tabOutset;
          } else {
            tabMin[tabAxis] = tongueOuter.min[tabAxis] - tabOutset;
            tabMax[tabAxis] = tongueOuter.min[tabAxis] + tabFuse;
          }
          snapTabs.push({ min: tabMin, max: tabMax });

          const pocketMin = [...grooveOuter.min] as [number, number, number];
          const pocketMax = [...grooveOuter.max] as [number, number, number];
          pocketMin[crossAxis] = pocketCrossMin;
          pocketMax[crossAxis] = pocketCrossMax;
          pocketMin[2] = tabZMin - lipTol;
          pocketMax[2] = tongueZMax + lipTol;
          if (sign > 0) {
            pocketMin[tabAxis] = grooveOuter.max[tabAxis] - tabFuse;
            pocketMax[tabAxis] = grooveOuter.max[tabAxis] + pocketOutset;
          } else {
            pocketMin[tabAxis] = grooveOuter.min[tabAxis] - pocketOutset;
            pocketMax[tabAxis] = grooveOuter.min[tabAxis] + tabFuse;
          }
          snapPockets.push({ min: pocketMin, max: pocketMax });
        }
      }
    }
  }

  return {
    inner,
    outer,
    splitZ,
    tongueOuter,
    tongueInner,
    tongueZMin: splitZ - tongueFuseDepth,
    tongueZMax: splitZ + effectiveLipDepth,
    grooveOuter,
    grooveInner,
    grooveZMin: splitZ - lipTol,
    grooveZMax,
    snapTabs,
    snapPockets,
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
