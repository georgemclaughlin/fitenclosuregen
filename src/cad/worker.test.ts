import { describe, expect, it } from "vitest";
import { computeAabb, transformedAabb } from "./bbox";
import { computeCombinedAabbWithFlush } from "./flush";
import { countTrianglesOverlappingAabb, meshContainsPoint } from "./mesh-inspect";
import { primitiveAabb } from "./presets";
import { buildEnclosureGeometry } from "./shell";
import { connectedComponents } from "./parts";
import { defaultParams, type AABB, type Connection, type EnclosureParams, type ItemRequest, type MeshData, type Primitive, type Vec3 } from "./types";
import { computeHeightfieldColumns, debugPlanConnectionRoutes, generate } from "./worker";

const params: EnclosureParams = {
  wall: 2,
  floor: 1.6,
  clearance: 0.5,
  fillet: 0,
  lidFrac: 0.25,
  lipDepth: 3,
  lipTol: 0.2,
  snapFit: false,
  snapSize: 0.3,
  snapPlacement: "both-y",
};

function makePrimitiveRequest(
  id: string,
  primitive: Primitive,
  position: Vec3,
  flushFace: ItemRequest["flushFace"] = null,
): ItemRequest {
  return {
    id,
    kind: "primitive",
    primitive,
    aabb: primitiveAabb(primitive),
    position,
    rotation: [0, 0, 0],
    flushFace,
  };
}

function boxPoints(aabb: AABB): number[] {
  const out: number[] = [];
  for (const x of [aabb.min[0], aabb.max[0]]) {
    for (const y of [aabb.min[1], aabb.max[1]]) {
      for (const z of [aabb.min[2], aabb.max[2]]) {
        out.push(x, y, z);
      }
    }
  }
  return out;
}

function boxTriangles(aabb: AABB): { positions: number[]; indices: number[] } {
  const positions = boxPoints(aabb);
  return {
    positions,
    indices: [
      0, 4, 6, 0, 6, 2,
      1, 3, 7, 1, 7, 5,
      0, 1, 5, 0, 5, 4,
      2, 6, 7, 2, 7, 3,
      0, 2, 3, 0, 3, 1,
      4, 5, 7, 4, 7, 6,
    ],
  };
}

function mergeBoxes(aabbs: AABB[]): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertOffset = 0;
  for (const aabb of aabbs) {
    const mesh = boxTriangles(aabb);
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(index + vertOffset);
    vertOffset += mesh.positions.length / 3;
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

function makeImportRequest(
  id: string,
  mesh: MeshData,
  aabb: AABB,
  position: Vec3,
  flushFace: ItemRequest["flushFace"] = null,
): ItemRequest {
  return {
    id,
    kind: "import",
    aabb,
    parts: [mesh],
    meshVersion: 0,
    position,
    rotation: [0, 0, 0],
    flushFace,
  };
}

function flushPosition(
  item: ItemRequest,
  face: "+x" | "-x" | "+y" | "-y",
  enclosureParams: EnclosureParams = params,
): Vec3 {
  const preWorld = transformedAabb(item.aabb, item.rotation, item.position);
  const combined = computeCombinedAabbWithFlush([{ aabb: item.aabb, rotation: item.rotation, flushFace: face }], [preWorld]);
  const geom = buildEnclosureGeometry(combined, enclosureParams);
  const next: Vec3 = [...item.position];
  if (face === "+x") next[0] += geom.interfaceOuter.max[0] - preWorld.max[0];
  else if (face === "-x") next[0] += geom.interfaceOuter.min[0] - preWorld.min[0];
  else if (face === "+y") next[1] += geom.interfaceOuter.max[1] - preWorld.max[1];
  else next[1] += geom.interfaceOuter.min[1] - preWorld.min[1];
  return next;
}

function sampleBox(min: Vec3, max: Vec3): AABB {
  return { min, max };
}

function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const lenSq = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const rawT = lenSq <= 1e-9 ? 0 : (
    ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / lenSq
  );
  const t = Math.max(0, Math.min(1, rawT));
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t), p[2] - (a[2] + ab[2] * t));
}

function hasSharedSegment(route: Vec3[], prior: Vec3[], minLength = 5): boolean {
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const midpoint: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (length < minLength) continue;
    for (let j = 0; j < prior.length - 1; j++) {
      if (pointSegmentDistance(midpoint, prior[j], prior[j + 1]) < 0.05) return true;
    }
  }
  return false;
}

describe("generate flushed cutouts", () => {
  it("keeps a flushed base valid with the default rounded snap-fit seam", async () => {
    const box: Primitive = { kind: "box", size: [20, 20, 10] };
    const boxReq = makePrimitiveRequest("box", box, [0, 0, 0], "+x");
    const flushedBox = { ...boxReq, position: flushPosition(boxReq, "+x", defaultParams) };
    const result = await generate({ items: [flushedBox], params: defaultParams, cutouts: [] });

    expect(result.base.indices.length / 3).toBeGreaterThan(12);
    expect(result.lid.indices.length / 3).toBeGreaterThan(12);
  });

  it("keeps the tongue and groove clear inside a flushed side-port aperture", async () => {
    const port: Primitive = { kind: "cylinder", axis: "x", radius: 4, height: 12 };
    const portReq = makePrimitiveRequest("port", port, [0, 0, 0], "+x");
    const flushedPort = { ...portReq, position: flushPosition(portReq, "+x") };

    const world = transformedAabb(flushedPort.aabb, flushedPort.rotation, flushedPort.position);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: flushedPort.aabb, rotation: flushedPort.rotation, flushFace: flushedPort.flushFace }],
      [world],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({ items: [flushedPort], params, cutouts: [] });

    const baseAperture = sampleBox(
      [geom.tongueInner.max[0] + 0.05, -1.5, geom.tongueOuter.min[2] + 0.6],
      [geom.tongueOuter.max[0] - 0.05, 1.5, geom.tongueOuter.min[2] + 1.4],
    );
    const baseWall = sampleBox(
      [geom.tongueOuter.max[0] - 0.08, 5.3, geom.tongueOuter.min[2] + 0.6],
      [geom.tongueOuter.max[0] + 0.08, 5.7, geom.tongueOuter.min[2] + 1.4],
    );
    const baseEdgeMaterial = sampleBox(
      [geom.tongueOuter.max[0] - 0.08, 4.12, geom.tongueOuter.min[2] + 0.6],
      [geom.tongueOuter.max[0] + 0.08, 4.28, geom.tongueOuter.min[2] + 1.4],
    );
    const lidAperture = sampleBox(
      [geom.grooveInner.max[0] + 0.05, -1.5, geom.splitZ + 0.3],
      [geom.grooveOuter.max[0] - 0.05, 1.5, geom.splitZ + 1.1],
    );
    const lidWall = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, 5.3, geom.splitZ + 0.3],
      [geom.interfaceOuter.max[0] + 0.08, 5.7, geom.splitZ + 1.1],
    );
    const lidExteriorMaterial = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, -1.5, geom.splitZ + 0.3],
      [geom.interfaceOuter.max[0] + 0.08, 1.5, geom.splitZ + 1.1],
    );

    expect(countTrianglesOverlappingAabb(result.base, baseAperture)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.lid, lidAperture)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, baseWall)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.base, baseEdgeMaterial)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.lid, lidWall)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.lid, lidExteriorMaterial)).toBeGreaterThan(0);
  });

  it("supports the same empty/solid samples when the port sits below the split plane", async () => {
    const port: Primitive = { kind: "cylinder", axis: "x", radius: 4, height: 12 };
    const tower: Primitive = { kind: "box", size: [8, 8, 18] };
    const portReq = makePrimitiveRequest("port", port, [0, 0, 0], "+x");
    const towerReq = makePrimitiveRequest("tower", tower, [0, 0, 12]);
    const flushedPort = { ...portReq, position: flushPosition(portReq, "+x") };

    const portWorld = transformedAabb(flushedPort.aabb, flushedPort.rotation, flushedPort.position);
    const towerWorld = transformedAabb(towerReq.aabb, towerReq.rotation, towerReq.position);
    const combined = computeCombinedAabbWithFlush(
      [
        { aabb: flushedPort.aabb, rotation: flushedPort.rotation, flushFace: flushedPort.flushFace },
        { aabb: towerReq.aabb, rotation: towerReq.rotation, flushFace: towerReq.flushFace },
      ],
      [portWorld, towerWorld],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({ items: [flushedPort, towerReq], params, cutouts: [] });

    const emptyWall = sampleBox(
      [geom.inner.max[0] - 0.9, -1.5, -1],
      [geom.interfaceOuter.max[0] - 0.1, 1.5, 1],
    );
    const solidWall = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, 5.3, -1],
      [geom.interfaceOuter.max[0] + 0.08, 5.7, 1],
    );

    expect(countTrianglesOverlappingAabb(result.base, emptyWall)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, solidWall)).toBeGreaterThan(0);
  });

  it("opens a wider front relief when a flushed board edge is broader than the connector cutout", async () => {
    const board: AABB = { min: [-8, -4, -0.2], max: [8, 4, 0.8] };
    const port: AABB = { min: [-2, -6, 0.4], max: [2, -4, 2.6] };
    const mesh = mergeBoxes([board, port]);
    const importAabb: AABB = { min: [-8, -6, -0.2], max: [8, 4, 2.6] };
    const item = makeImportRequest("flush-front-board", mesh, importAabb, [0, 0, 0], "-y");
    const flushed = { ...item, position: flushPosition(item, "-y") };

    const world = transformedAabb(flushed.aabb, flushed.rotation, flushed.position);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: flushed.aabb, rotation: flushed.rotation, flushFace: flushed.flushFace }],
      [world],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({ items: [flushed], params, cutouts: [] });

    const leftBoardFront = sampleBox(
      [-6.0, geom.outer.min[1] - 0.08, 0.2],
      [-4.0, geom.inner.min[1] + 0.08, 2.8],
    );
    const rightBoardFront = sampleBox(
      [4.0, geom.outer.min[1] - 0.08, 0.2],
      [6.0, geom.inner.min[1] + 0.08, 2.8],
    );

    expect(countTrianglesOverlappingAabb(result.base, leftBoardFront)).toBeGreaterThanOrEqual(0);
    expect(countTrianglesOverlappingAabb(result.base, rightBoardFront)).toBeGreaterThanOrEqual(0);
  });

  it("keeps the region above a lower battery open for an upper board while leaving side regions solid", async () => {
    const battery = makePrimitiveRequest("battery", { kind: "box", size: [12, 10, 6] }, [0, 0, 0]);
    const board = makePrimitiveRequest("board", { kind: "box", size: [20, 16, 2] }, [0, 0, 10]);
    const batteryWorld = transformedAabb(battery.aabb, battery.rotation, battery.position);
    const boardWorld = transformedAabb(board.aabb, board.rotation, board.position);
    const combined = computeCombinedAabbWithFlush(
      [
        { aabb: battery.aabb, rotation: battery.rotation, flushFace: battery.flushFace },
        { aabb: board.aabb, rotation: board.rotation, flushFace: board.flushFace },
      ],
      [batteryWorld, boardWorld],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({ items: [battery, board], params, cutouts: [] });

    const openBetweenBatteryAndBoard = sampleBox(
      [-1.0, -1.0, 4.5],
      [1.0, 1.0, 7.5],
    );
    const solidOutsideBoardFootprint = sampleBox(
      [10.42, -0.5, 4.5],
      [10.58, 0.5, 7.5],
    );
    const solidBelowBatterySide = sampleBox(
      [6.42, -0.5, -0.5],
      [6.58, 0.5, 1.5],
    );

    expect(countTrianglesOverlappingAabb(result.base, openBetweenBatteryAndBoard)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, solidOutsideBoardFootprint)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.base, solidBelowBatterySide)).toBeGreaterThan(0);
    expect(geom.splitZ).toBeGreaterThan(7.5);
  });

  it("clips imported cutouts to the wall slab so deeper tabs do not widen the face opening", async () => {
    const frontShell: AABB = { min: [4, -4, -2], max: [7, 4, 2] };
    const deepTab: AABB = { min: [2, -1, -4.8], max: [4.1, 1, -3.2] };
    const mesh = mergeBoxes([frontShell, deepTab]);
    const importAabb: AABB = {
      min: [2, -4, -4.8],
      max: [7, 4, 2],
    };
    const importReq = makeImportRequest("import-port", mesh, importAabb, [0, 0, 0], "+x");
    const flushedImport = { ...importReq, position: flushPosition(importReq, "+x") };

    const world = transformedAabb(flushedImport.aabb, flushedImport.rotation, flushedImport.position);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: flushedImport.aabb, rotation: flushedImport.rotation, flushFace: flushedImport.flushFace }],
      [world],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({ items: [flushedImport], params, cutouts: [] });

    const frontCenterOpen = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, -0.8, -0.8],
      [geom.interfaceOuter.max[0] + 0.08, 0.8, 0.8],
    );
    const frontLowerOpen = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, -0.8, -1.8],
      [geom.interfaceOuter.max[0] + 0.08, 0.8, -1.2],
    );
    const frontBelowPortClosed = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, -0.8, -4.4],
      [geom.interfaceOuter.max[0] + 0.08, 0.8, -3.4],
    );
    const frontSideWallClosed = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, 4.6, -0.8],
      [geom.interfaceOuter.max[0] + 0.08, 5.2, 0.8],
    );
    const frontTopWallClosed = sampleBox(
      [geom.interfaceOuter.max[0] - 0.08, -0.8, 2.6],
      [geom.interfaceOuter.max[0] + 0.08, 0.8, 3.2],
    );

    expect(countTrianglesOverlappingAabb(result.base, frontCenterOpen)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, frontLowerOpen)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, frontBelowPortClosed)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.base, frontSideWallClosed)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.lid, frontTopWallClosed)).toBeGreaterThan(0);
  });

  it("fills between sparse header pins while keeping the pin slots clear", async () => {
    const board: AABB = { min: [-8, -4, 6], max: [8, 4, 8] };
    const pin1: AABB = { min: [-5.6, -0.4, 0], max: [-4.4, 0.4, 6] };
    const pin2: AABB = { min: [-1.6, -0.4, 0], max: [-0.4, 0.4, 6] };
    const pin3: AABB = { min: [2.4, -0.4, 0], max: [3.6, 0.4, 6] };
    const mesh = mergeBoxes([board, pin1, pin2, pin3]);
    const importAabb: AABB = { min: [-8, -4, 0], max: [8, 4, 8] };
    const header = makeImportRequest("header", mesh, importAabb, [0, 0, 0], null);
    const columns = computeHeightfieldColumns(mesh, importAabb, params.clearance);
    const pinColumn = columns.find((col) =>
      col.min[0] <= -5.0 && col.max[0] >= -5.0 && col.min[1] <= 0 && col.max[1] >= 0,
    );
    const gapColumn = columns.find((col) =>
      col.min[0] <= -3.0 && col.max[0] >= -3.0 && col.min[1] <= 0 && col.max[1] >= 0,
    );

    expect(pinColumn).toBeDefined();
    expect(gapColumn).toBeDefined();
    expect(pinColumn!.min[2]).toBeCloseTo(-0.5, 5);
    expect(gapColumn!.min[2]).toBeCloseTo(5.5, 5);
    expect(pinColumn!.min[0]).toBeLessThan(-5.5);
    expect(pinColumn!.max[0]).toBeGreaterThan(-4.5);

    const result = await generate({ items: [header], params, cutouts: [] });
    const pinSlot = sampleBox(
      [-5.5, -0.35, 0.2],
      [-4.5, 0.35, 2.5],
    );
    const solidBetweenPins = sampleBox(
      [-3.3, -0.35, 5.4],
      [-2.7, 0.35, 5.7],
    );
    expect(countTrianglesOverlappingAabb(result.base, pinSlot)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, solidBetweenPins)).toBeGreaterThan(0);
  });

  it("keeps clearance around the outer edge of imported board geometry", async () => {
    const board: AABB = { min: [-10, -5, 0], max: [10, 5, 1.6] };
    const mesh = mergeBoxes([board]);
    const item = makeImportRequest("import-board", mesh, board, [0, 0, 0], null);
    const result = await generate({ items: [item], params, cutouts: [] });

    const plusXEdgeClearance = sampleBox(
      [10.05, -1.0, 0.2],
      [10.35, 1.0, 1.2],
    );
    const plusYEdgeClearance = sampleBox(
      [-1.0, 5.05, 0.2],
      [1.0, 5.35, 1.2],
    );
    const outsideClearanceStillSolid = sampleBox(
      [10.48, -1.0, 0.2],
      [10.58, 1.0, 1.2],
    );

    expect(countTrianglesOverlappingAabb(result.base, plusXEdgeClearance)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.lid, plusXEdgeClearance)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, plusYEdgeClearance)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.lid, plusYEdgeClearance)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, outsideClearanceStillSolid)).toBeGreaterThan(0);
  });

  it("fills between low legs on a flushed import while keeping the wall-entry corridor open", async () => {
    const board: AABB = { min: [-8, -4, 6], max: [8, 4, 8] };
    const leftLeg: AABB = { min: [-4.6, -3.6, 0], max: [-3.4, -2.4, 6] };
    const rightLeg: AABB = { min: [-4.6, 2.4, 0], max: [-3.4, 3.6, 6] };
    const port: AABB = { min: [6, -1.2, 2], max: [10, 1.2, 5] };
    const mesh = mergeBoxes([board, leftLeg, rightLeg, port]);
    const importAabb: AABB = { min: [-8, -4, 0], max: [10, 4, 8] };
    const item = makeImportRequest("flushed-header", mesh, importAabb, [0, 0, 0], "+x");
    const flushed = { ...item, position: flushPosition(item, "+x") };

    const world = transformedAabb(flushed.aabb, flushed.rotation, flushed.position);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: flushed.aabb, rotation: flushed.rotation, flushFace: flushed.flushFace }],
      [world],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({ items: [flushed], params, cutouts: [] });

    const leftLegSlot = sampleBox(
      [flushed.position[0] - 4.5, -3.3, 0.2],
      [flushed.position[0] - 3.5, -2.7, 2.5],
    );
    const rightLegSlot = sampleBox(
      [flushed.position[0] - 4.5, 2.7, 0.2],
      [flushed.position[0] - 3.5, 3.3, 2.5],
    );
    const portCorridor = sampleBox(
      [geom.inner.max[0] - 0.9, -1.1, 2.2],
      [geom.outer.max[0] - 0.1, 1.1, 4.8],
    );

    expect(countTrianglesOverlappingAabb(result.base, leftLegSlot)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, rightLegSlot)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, portCorridor)).toBeLessThanOrEqual(2);
  });

  it("subtracts circular manual cutouts without clearing the whole bounding box", async () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const item = makePrimitiveRequest("box", primitive, [0, 0, 0]);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: item.aabb, rotation: item.rotation, flushFace: item.flushFace }],
      [transformedAabb(item.aabb, item.rotation, item.position)],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({
      items: [item],
      params,
      cutouts: [{
        id: "circle",
        face: "+x",
        u: -geom.outer.min[1],
        v: -geom.outer.min[2],
        w: 8,
        h: 8,
        shape: "circle",
      }],
    });

    const centerHole = sampleBox(
      [geom.outer.max[0] - 0.08, -0.4, -0.4],
      [geom.outer.max[0] + 0.08, 0.4, 0.4],
    );
    const boundingBoxCornerStillSolid = sampleBox(
      [geom.outer.max[0] - 0.08, 3.35, 2.1],
      [geom.outer.max[0] + 0.08, 3.55, 2.25],
    );

    expect(countTrianglesOverlappingAabb(result.base, centerHole)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, boundingBoxCornerStillSolid)).toBeGreaterThan(0);
  });

  it("extends a seam-crossing manual cutout through the maximum reinforcement", async () => {
    const extremeParams: EnclosureParams = {
      ...params,
      wall: 0.8,
      lipTol: 0.6,
      snapFit: true,
      snapSize: 0.8,
    };
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const item = makePrimitiveRequest("box", primitive, [0, 0, 0]);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: item.aabb, rotation: item.rotation, flushFace: item.flushFace }],
      [transformedAabb(item.aabb, item.rotation, item.position)],
    );
    const geom = buildEnclosureGeometry(combined, extremeParams);
    const result = await generate({
      items: [item],
      params: extremeParams,
      cutouts: [{
        id: "seam-cutout",
        face: "+x",
        u: -geom.outer.min[1],
        v: geom.splitZ - geom.outer.min[2],
        w: 6,
        h: 2,
        shape: "rect",
      }],
    });
    const exteriorHolePoint: Vec3 = [
      geom.interfaceOuter.max[0] - 0.2,
      0,
      geom.splitZ + 0.35,
    ];

    expect(geom.interfaceOuter.max[0] - geom.outer.max[0]).toBeCloseTo(3.75);
    expect(meshContainsPoint(result.lid, exteriorHolePoint)).toBe(false);
    expect(meshContainsPoint(result.lid, [
      geom.interfaceOuter.max[0] - 0.2,
      4,
      geom.splitZ + 0.35,
    ])).toBe(true);
  });

  it("keeps material around groove corners when the body fillet is large", async () => {
    const highFilletParams: EnclosureParams = {
      ...params,
      fillet: 5,
      snapFit: false,
    };
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const item = makePrimitiveRequest("box", primitive, [0, 0, 0]);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: item.aabb, rotation: item.rotation, flushFace: item.flushFace }],
      [transformedAabb(item.aabb, item.rotation, item.position)],
    );
    const geom = buildEnclosureGeometry(combined, highFilletParams);
    const result = await generate({ items: [item], params: highFilletParams, cutouts: [] });
    const cornerSkinPoint: Vec3 = [
      geom.grooveOuter.max[0] + 0.4,
      geom.grooveOuter.max[1] + 0.4,
      geom.splitZ + 1,
    ];

    expect(result.base.indices.length / 3).toBeGreaterThan(12);
    expect(result.lid.indices.length / 3).toBeGreaterThan(12);
    expect(meshContainsPoint(result.lid, cornerSkinPoint)).toBe(true);
  });

  it("reports reinforced mesh bounds separately from nominal body bounds", async () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const item = makePrimitiveRequest("box", primitive, [0, 0, 0]);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: item.aabb, rotation: item.rotation, flushFace: item.flushFace }],
      [transformedAabb(item.aabb, item.rotation, item.position)],
    );
    const geom = buildEnclosureGeometry(combined, defaultParams);
    const result = await generate({ items: [item], params: defaultParams, cutouts: [] });

    expect(result.bodyOuter).toEqual(geom.outer);
    expect(result.outer.min[0]).toBeCloseTo(geom.interfaceOuter.min[0]);
    expect(result.outer.max[0]).toBeCloseTo(geom.interfaceOuter.max[0]);
  });

  it("carries the reinforced side plane through the base and lid", async () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const item = makePrimitiveRequest("box", primitive, [0, 0, 0]);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: item.aabb, rotation: item.rotation, flushFace: item.flushFace }],
      [transformedAabb(item.aabb, item.rotation, item.position)],
    );
    const geom = buildEnclosureGeometry(combined, defaultParams);
    const result = await generate({ items: [item], params: defaultParams, cutouts: [] });
    const sideX = geom.interfaceOuter.max[0] - 0.2;

    expect(meshContainsPoint(result.base, [sideX, 0, geom.outer.min[2] + 0.5])).toBe(true);
    expect(meshContainsPoint(result.lid, [sideX, 0, geom.outer.max[2] - 0.5])).toBe(true);
  });

  it("per-item fit clearance can grow the enclosure beyond the global clearance", async () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const regular = makePrimitiveRequest("regular", primitive, [0, 0, 0]);
    const loose = { ...makePrimitiveRequest("loose", primitive, [0, 0, 0]), fitClearance: 2 };

    const regularResult = await generate({ items: [regular], params, cutouts: [] });
    const looseResult = await generate({ items: [loose], params, cutouts: [] });
    const regularOuter = regularResult.bodyOuter ?? regularResult.outer;
    const looseOuter = looseResult.bodyOuter ?? looseResult.outer;
    const regularWidth = regularOuter.max[0] - regularOuter.min[0];
    const looseWidth = looseOuter.max[0] - looseOuter.min[0];

    expect(regularWidth).toBeCloseTo(25);
    expect(looseWidth).toBeCloseTo(28);
  });

  it("keeps horizontal primitive cavities drop-in open from above in the base", async () => {
    const primitive: Primitive = { kind: "cylinder", axis: "x", radius: 5, height: 20 };
    const item = makePrimitiveRequest("battery", primitive, [0, 0, 0]);
    const combined = computeCombinedAabbWithFlush(
      [{ aabb: item.aabb, rotation: item.rotation, flushFace: item.flushFace }],
      [transformedAabb(item.aabb, item.rotation, item.position)],
    );
    const geom = buildEnclosureGeometry(combined, params);
    const result = await generate({ items: [item], params, cutouts: [] });

    const sideOverhang = sampleBox([-1, 4.4, 2.5], [1, 4.8, 3.5]);
    const lowerCradleSupport = sampleBox([-1, 4.0, -4.0], [1, 4.3, -3.7]);
    const splitCap = sampleBox([-6, -3, geom.splitZ - 0.05], [6, 3, geom.splitZ + 0.05]);
    expect(countTrianglesOverlappingAabb(result.base, sideOverhang)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, lowerCradleSupport)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.base, splitCap)).toBe(0);
  });

  it("does not add a base roof over a simple drop-in component footprint", async () => {
    const primitive: Primitive = { kind: "box", size: [20, 16, 4] };
    const item = makePrimitiveRequest("board", primitive, [0, 0, 0]);
    const result = await generate({ items: [item], params, cutouts: [] });

    const roofOverFootprint = sampleBox([-6, -4, 2.2], [6, 4, 6.2]);
    expect(countTrianglesOverlappingAabb(result.base, roofOverFootprint)).toBe(0);
  });

  it("keeps non-flushed imported boards drop-in open from above in the base", async () => {
    const board: AABB = { min: [-12, -10, 0], max: [12, 10, 1.6] };
    const module: AABB = { min: [-5, -4, 1.6], max: [5, 4, 5] };
    const connector: AABB = { min: [8, -2, 1.6], max: [12, 2, 3.5] };
    const mesh = mergeBoxes([board, module, connector]);
    const importAabb: AABB = { min: [-12, -10, 0], max: [12, 10, 5] };
    const item = makeImportRequest("sam-m10q-like", mesh, importAabb, [0, 0, 0], null);
    const result = await generate({ items: [item], params, cutouts: [] });

    const roofOverFootprint = sampleBox([-6, -5, 5.2], [6, 5, 8]);
    expect(countTrianglesOverlappingAabb(result.base, roofOverFootprint)).toBe(0);
  });

  it("keeps an imported board top open when a taller battery raises the base split", async () => {
    const board: AABB = { min: [-15, -9, 0], max: [15, 9, 1.4] };
    const header: AABB = { min: [-11, -6, -5], max: [11, -4.8, 0] };
    const connector: AABB = { min: [12, -3, 1.4], max: [15, 3, 3.6] };
    const mesh = mergeBoxes([board, header, connector]);
    const importAabb: AABB = { min: [-15, -9, -5], max: [15, 9, 3.6] };
    const importedBoard = makeImportRequest("lilygo-like", mesh, importAabb, [-8, 0, 1], null);
    const battery = makePrimitiveRequest(
      "battery",
      { kind: "cylinder", axis: "y", radius: 9.3, height: 65.2 },
      [20, 0, 0],
    );

    const result = await generate({ items: [importedBoard, battery], params, cutouts: [] });
    const boardTop = transformedAabb(importedBoard.aabb, importedBoard.rotation, importedBoard.position).max[2];

    const roofOverBoard = sampleBox(
      [-18, -5, boardTop + params.clearance + 0.2],
      [-2, 5, result.outer.max[2] - params.wall - 0.2],
    );

    expect(result.outer.max[2]).toBeGreaterThan(boardTop + 5);
    expect(countTrianglesOverlappingAabb(result.base, roofOverBoard)).toBe(0);
  });

  it("keeps a flushed imported board top open when a taller battery raises the base split", async () => {
    const board: AABB = { min: [-0.3, -1.4, -1], max: [25.7, 51.5, 1.4] };
    const header: AABB = { min: [4, 10, -8.9], max: [18, 12, -1] };
    const connector: AABB = { min: [22, 34, 1.4], max: [25.7, 43, 4.3] };
    const mesh = mergeBoxes([board, header, connector]);
    const importAabb: AABB = { min: [-0.3, -1.4, -8.9], max: [25.7, 51.5, 4.3] };
    const importReq = makeImportRequest("ttgo-like", mesh, importAabb, [-25.4, -2.8, 4.6], "-y");
    const flushedBoard = { ...importReq, position: flushPosition(importReq, "-y") };
    const battery = makePrimitiveRequest(
      "battery",
      { kind: "cylinder", axis: "x", radius: 9.3, height: 65.2 },
      [-12.7, 61.6, 2.3],
    );

    const result = await generate({ items: [flushedBoard, battery], params, cutouts: [] });
    const boardWorld = transformedAabb(flushedBoard.aabb, flushedBoard.rotation, flushedBoard.position);

    const roofOverBoard = sampleBox(
      [boardWorld.min[0] + 4, boardWorld.min[1] + 8, boardWorld.max[2] + params.clearance + 0.2],
      [boardWorld.max[0] - 4, boardWorld.max[1] - 8, result.outer.max[2] - params.wall - 0.2],
    );

    expect(result.outer.max[2]).toBeGreaterThan(boardWorld.max[2] + 5);
    expect(countTrianglesOverlappingAabb(result.base, roofOverBoard)).toBe(0);
  });

  it("connections carve endpoint pads and a straight buffered corridor between items", async () => {
    const primitive: Primitive = { kind: "box", size: [10, 10, 6] };
    const left = makePrimitiveRequest("left", primitive, [-12, 0, 0]);
    const right = makePrimitiveRequest("right", primitive, [12, 0, 0]);
    const connection: Connection = {
      id: "wire",
      name: "Wire",
      a: { itemId: left.id, face: "+x", u: 5, v: 3, depth: 1.5 },
      b: { itemId: right.id, face: "-x", u: 5, v: 3, depth: 1.5 },
      shape: "rect",
      width: 3,
      height: 2,
      clearance: 1,
    };

    const withConnection = await generate({ items: [left, right], params, cutouts: [], connections: [connection] });
    const corridorCenter = sampleBox([-1, -1, -1], [1, 1, 1]);

    expect(countTrianglesOverlappingAabb(withConnection.base, corridorCenter)).toBe(0);
    expect(withConnection.debug?.some((entry) => entry.key === "connection")).toBe(true);
  });

  it("connection headspace follows dogleg segments instead of clearing the whole route bounds", async () => {
    const primitive: Primitive = { kind: "box", size: [10, 10, 6] };
    const left = makePrimitiveRequest("left", primitive, [-14, -10, 0]);
    const right = makePrimitiveRequest("right", primitive, [14, 10, 0]);
    const connection: Connection = {
      id: "dogleg-wire",
      name: "Dogleg wire",
      a: { itemId: left.id, face: "-y", u: 5, v: 3, depth: 1.5 },
      b: { itemId: right.id, face: "-y", u: 5, v: 3, depth: 1.5 },
      shape: "rect",
      width: 3,
      height: 2,
      clearance: 1,
    };

    const result = await generate({ items: [left, right], params, cutouts: [], connections: [connection] });
    const oldBoundingSlabCorner = sampleBox([5, -7, 1], [8, -4, 4]);
    const routedLeg = sampleBox([-4, -14, 1], [-2, -12, 4]);

    expect(countTrianglesOverlappingAabb(result.base, oldBoundingSlabCorner)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.base, routedLeg)).toBe(0);
  });

  it("connections dogleg around intervening item bounds instead of routing through them", async () => {
    const primitive: Primitive = { kind: "box", size: [8, 8, 6] };
    const left = makePrimitiveRequest("left", primitive, [-16, 0, 0]);
    const right = makePrimitiveRequest("right", primitive, [16, 0, 0]);
    const blocker = makePrimitiveRequest("blocker", { kind: "box", size: [10, 10, 8] }, [0, 0, 0]);
    const connection: Connection = {
      id: "wire",
      name: "Wire",
      a: { itemId: left.id, face: "+x", u: 4, v: 3, depth: 1.5 },
      b: { itemId: right.id, face: "-x", u: 4, v: 3, depth: 1.5 },
      shape: "rect",
      width: 3,
      height: 2,
      clearance: 1,
    };

    const result = await generate({ items: [left, blocker, right], params, cutouts: [], connections: [connection] });
    const connectionDebug = result.debug?.find((entry) => entry.key === "connection")?.mesh;

    expect(connectionDebug).toBeDefined();
    const debugBounds = computeAabb(connectionDebug!.positions);
    expect(countTrianglesOverlappingAabb(connectionDebug!, sampleBox([-3, -3, -2], [3, 3, 2]))).toBe(0);
    expect(
      debugBounds.min[1] < -8 || debugBounds.max[1] > 8 || debugBounds.min[2] < -7 || debugBounds.max[2] > 7,
    ).toBe(true);
  });

  it("connections prefer side routes over under-component routes that deepen the base", async () => {
    const primitive: Primitive = { kind: "box", size: [8, 8, 6] };
    const left = makePrimitiveRequest("left", primitive, [-16, 0, 0]);
    const right = makePrimitiveRequest("right", primitive, [16, 0, 0]);
    const blocker = makePrimitiveRequest("blocker", { kind: "box", size: [10, 10, 8] }, [0, 0, 0]);
    const connection: Connection = {
      id: "wire",
      name: "Wire",
      a: { itemId: left.id, face: "+x", u: 4, v: 3, depth: 1.5 },
      b: { itemId: right.id, face: "-x", u: 4, v: 3, depth: 1.5 },
      shape: "rect",
      width: 3,
      height: 2,
      clearance: 1,
    };

    const result = await generate({ items: [left, blocker, right], params, cutouts: [], connections: [connection] });
    const connectionDebug = result.debug?.find((entry) => entry.key === "connection")?.mesh;

    expect(connectionDebug).toBeDefined();
    const debugBounds = computeAabb(connectionDebug!.positions);
    expect(debugBounds.min[2]).toBeGreaterThanOrEqual(-4);
  });

  it("connections do not fall back to a direct route through an endpoint owner body", async () => {
    const battery = makePrimitiveRequest(
      "battery",
      { kind: "cylinder", axis: "x", radius: 5, height: 28 },
      [0, 0, 0],
    );
    const board = makePrimitiveRequest("board", { kind: "box", size: [14, 12, 2] }, [18, 0, 1]);
    const connection: Connection = {
      id: "wire",
      name: "Wire",
      a: { itemId: battery.id, face: "-x", u: 5, v: 5, depth: 1.5 },
      b: { itemId: board.id, face: "+z", u: 7, v: 6, depth: 1.5 },
      shape: "rect",
      width: 3,
      height: 2,
      clearance: 1,
    };

    const result = await generate({ items: [battery, board], params, cutouts: [], connections: [connection] });
    const connectionDebug = result.debug?.find((entry) => entry.key === "connection")?.mesh;

    expect(connectionDebug).toBeDefined();
    expect(countTrianglesOverlappingAabb(connectionDebug!, sampleBox([-8, -2, -2], [8, 2, 2]))).toBe(0);
  });

  it("nearby connections reuse an existing trunk instead of carving parallel middle runs", async () => {
    const primitive: Primitive = { kind: "box", size: [10, 10, 6] };
    const left = makePrimitiveRequest("left", primitive, [-16, 0, 0]);
    const right = makePrimitiveRequest("right", primitive, [16, 0, 0]);
    const common = {
      shape: "rect" as const,
      width: 2,
      height: 2,
      clearance: 0.5,
    };
    const low: Connection = {
      id: "low-wire",
      name: "Low wire",
      a: { itemId: left.id, face: "+x", u: 3, v: 3, depth: 1.5 },
      b: { itemId: right.id, face: "-x", u: 3, v: 3, depth: 1.5 },
      ...common,
    };
    const high: Connection = {
      id: "high-wire",
      name: "High wire",
      a: { itemId: left.id, face: "+x", u: 7, v: 3, depth: 1.5 },
      b: { itemId: right.id, face: "-x", u: 7, v: 3, depth: 1.5 },
      ...common,
    };

    const result = await generate({ items: [left, right], params, cutouts: [], connections: [low, high] });
    const connectionDebug = result.debug?.find((entry) => entry.key === "connection")?.mesh;

    expect(connectionDebug).toBeDefined();
    expect(countTrianglesOverlappingAabb(connectionDebug!, sampleBox([-4, 1.4, 1], [4, 2.6, 5]))).toBe(0);
  });

  it("crossed adjacent-face connections merge onto a shared trunk", () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const topLeft = makePrimitiveRequest("top-left", primitive, [-25, -27.5, 0]);
    const bottomRight = makePrimitiveRequest("bottom-right", primitive, [20.8, 0, 0]);
    const common = {
      shape: "rect" as const,
      width: 4,
      height: 3,
      clearance: 1.5,
    };
    const first: Connection = {
      id: "first",
      name: "Connection",
      a: { itemId: bottomRight.id, face: "-x", u: 15.624505386213817, v: 4.8595275758383565, depth: 2 },
      b: { itemId: topLeft.id, face: "+y", u: 3.0159363358849944, v: 5.5731266484677775, depth: 2 },
      ...common,
    };
    const second: Connection = {
      id: "second",
      name: "Connection",
      a: { itemId: topLeft.id, face: "+y", u: 10.265129875901504, v: 4.988839276131202, depth: 2 },
      b: { itemId: bottomRight.id, face: "-x", u: 10.515568089037949, v: 5.427153206667938, depth: 2 },
      ...common,
    };

    const routes = debugPlanConnectionRoutes([first, second], [topLeft, bottomRight], null);

    expect(routes).toHaveLength(2);
    expect(hasSharedSegment(routes[1], routes[0], 10)).toBe(true);
  });

  it("same-direction crossed adjacent-face connections merge onto a shared trunk", () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const topLeft = makePrimitiveRequest("top-left", primitive, [-17.5, -32.5, 0]);
    const bottomRight = makePrimitiveRequest("bottom-right", primitive, [20.8, 0, 0]);
    const common = {
      shape: "rect" as const,
      width: 4,
      height: 3,
      clearance: 1.5,
    };
    const first: Connection = {
      id: "first",
      name: "Connection",
      a: { itemId: topLeft.id, face: "+y", u: 2.781951971011715, v: 4.413114737396029, depth: 2 },
      b: { itemId: bottomRight.id, face: "-x", u: 17.764576348363065, v: 5.19532406751059, depth: 2 },
      ...common,
    };
    const second: Connection = {
      id: "second",
      name: "Connection",
      a: { itemId: topLeft.id, face: "+y", u: 8.170523735786222, v: 4.551144680023285, depth: 2 },
      b: { itemId: bottomRight.id, face: "-x", u: 13.568200916550602, v: 5.388880918830878, depth: 2 },
      ...common,
    };

    const routes = debugPlanConnectionRoutes([first, second], [topLeft, bottomRight], null);

    expect(routes).toHaveLength(2);
    expect(hasSharedSegment(routes[1], routes[0], 10)).toBe(true);
  });

  it("bottom-to-top stress route intentionally expands below the component", async () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    const left = makePrimitiveRequest("left", primitive, [-19, -23, 0]);
    const right = makePrimitiveRequest("right", primitive, [20.8, 0, 0]);
    const connection: Connection = {
      id: "stress",
      name: "Connection",
      a: { itemId: left.id, face: "-z", u: 8.478235898372692, v: 10.043588242866797, depth: 2 },
      b: { itemId: right.id, face: "+z", u: 10.178544437561357, v: 10.100645114877754, depth: 2 },
      shape: "rect",
      width: 4,
      height: 3,
      clearance: 1.5,
    };

    const [route] = debugPlanConnectionRoutes([connection], [left, right], null);
    const result = await generate({ items: [left, right], params, cutouts: [], connections: [connection] });
    const minZ = Math.min(...route.map((p) => p[2]));

    expect(route).toBeDefined();
    expect(minZ).toBe(-5);
    expect(result.outer.min[2]).toBeLessThan(-9);
  });

  it("exports the base as a single connected solid with and without snap-fit", async () => {
    const primitive: Primitive = { kind: "box", size: [20, 20, 10] };
    for (const snapFit of [false, true]) {
      const result = await generate({
        items: [{
          id: `box-${snapFit ? "snap" : "plain"}`,
          kind: "primitive",
          primitive,
          aabb: primitiveAabb(primitive),
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          flushFace: null,
        }],
        params: { ...params, snapFit },
        cutouts: [],
      });

      expect(connectedComponents(result.base.positions, result.base.indices).length).toBe(1);
      expect(connectedComponents(result.lid.positions, result.lid.indices).length).toBe(1);
    }
  });
});
