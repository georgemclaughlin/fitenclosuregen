import { describe, expect, it } from "vitest";
import { transformedAabb } from "./bbox";
import { computeCombinedAabbWithFlush } from "./flush";
import { countTrianglesOverlappingAabb } from "./mesh-inspect";
import { primitiveAabb } from "./presets";
import { buildEnclosureGeometry } from "./shell";
import { connectedComponents } from "./parts";
import type { AABB, EnclosureParams, ItemRequest, MeshData, Primitive, Vec3 } from "./types";
import { computeHeightfieldColumns, generate } from "./worker";

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

function flushPosition(item: ItemRequest, face: "+x" | "-x" | "+y" | "-y"): Vec3 {
  const preWorld = transformedAabb(item.aabb, item.rotation, item.position);
  const combined = computeCombinedAabbWithFlush([{ aabb: item.aabb, rotation: item.rotation, flushFace: face }], [preWorld]);
  const geom = buildEnclosureGeometry(combined, params);
  const next: Vec3 = [...item.position];
  if (face === "+x") next[0] += geom.outer.max[0] - preWorld.max[0];
  else if (face === "-x") next[0] += geom.outer.min[0] - preWorld.min[0];
  else if (face === "+y") next[1] += geom.outer.max[1] - preWorld.max[1];
  else next[1] += geom.outer.min[1] - preWorld.min[1];
  return next;
}

function sampleBox(min: Vec3, max: Vec3): AABB {
  return { min, max };
}

describe("generate flushed cutouts", () => {
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
      [geom.outer.max[0] - 0.08, 5.3, geom.splitZ + 0.3],
      [geom.outer.max[0] + 0.08, 5.7, geom.splitZ + 1.1],
    );

    expect(countTrianglesOverlappingAabb(result.base, baseAperture)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.lid, lidAperture)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, baseWall)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.base, baseEdgeMaterial)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.lid, lidWall)).toBeGreaterThan(0);
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
      [geom.outer.max[0] - 0.1, 1.5, 1],
    );
    const solidWall = sampleBox(
      [geom.outer.max[0] - 0.08, 5.3, -1],
      [geom.outer.max[0] + 0.08, 5.7, 1],
    );

    expect(countTrianglesOverlappingAabb(result.base, emptyWall)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, solidWall)).toBeGreaterThan(0);
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
      [geom.outer.max[0] - 0.08, -0.8, -0.8],
      [geom.outer.max[0] + 0.08, 0.8, 0.8],
    );
    const frontLowerOpen = sampleBox(
      [geom.outer.max[0] - 0.08, -0.8, -1.8],
      [geom.outer.max[0] + 0.08, 0.8, -1.2],
    );
    const frontBelowPortClosed = sampleBox(
      [geom.outer.max[0] - 0.08, -0.8, -4.4],
      [geom.outer.max[0] + 0.08, 0.8, -3.4],
    );
    const frontSideWallClosed = sampleBox(
      [geom.outer.max[0] - 0.08, 4.6, -0.8],
      [geom.outer.max[0] + 0.08, 5.2, 0.8],
    );
    const frontTopWallClosed = sampleBox(
      [geom.outer.max[0] - 0.08, -0.8, 2.6],
      [geom.outer.max[0] + 0.08, 0.8, 3.2],
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

    const result = await generate({ items: [header], params, cutouts: [] });
    const pinSlot = sampleBox(
      [-5.5, -0.35, 0.2],
      [-4.5, 0.35, 2.5],
    );
    expect(countTrianglesOverlappingAabb(result.base, pinSlot)).toBe(0);
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

    const gapFillSurface = sampleBox(
      [flushed.position[0] - 4.5, -1.0, geom.splitZ - 0.08],
      [flushed.position[0] - 3.5, 1.0, geom.splitZ + 0.08],
    );
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

    expect(countTrianglesOverlappingAabb(result.base, gapFillSurface)).toBeGreaterThan(0);
    expect(countTrianglesOverlappingAabb(result.base, leftLegSlot)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, rightLegSlot)).toBe(0);
    expect(countTrianglesOverlappingAabb(result.base, portCorridor)).toBe(0);
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
