import { describe, expect, it } from "vitest";
import { placeAlongside, stackItemRelativePosition } from "./layout";
import type { ImportedMesh, Item } from "./types";

function primitiveBox(
  size: [number, number, number],
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): Item {
  return {
    id: crypto.randomUUID(),
    kind: "primitive",
    name: "box",
    primitive: { kind: "box", size },
    position,
    rotation,
  };
}

function importItem(
  mesh: ImportedMesh,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): Item {
  return {
    id: crypto.randomUUID(),
    kind: "import",
    name: "import",
    mesh,
    meshVersion: 0,
    position,
    rotation,
  };
}

describe("placeAlongside", () => {
  it("keeps non-centered local AABBs tight when auto-placing", () => {
    const existing = [primitiveBox([20, 20, 10], [0, 0, 0])];
    const localAabb = {
      min: [0, -5, -2] as [number, number, number],
      max: [10, 5, 2] as [number, number, number],
    };

    const pos = placeAlongside(existing, localAabb, 0.5);
    expect(pos[0]).toBeCloseTo(10.5);
    expect(pos[1]).toBeCloseTo(0);
    expect(pos[2]).toBeCloseTo(0);
  });
});

describe("stackItemRelativePosition", () => {
  it("uses the rotated world AABB on the stack axis", () => {
    const fixed = primitiveBox([20, 20, 10], [0, 0, 0]);
    const rotated = primitiveBox([20, 20, 10], [0, 0, 0], [0, 90, 0]);

    const pos = stackItemRelativePosition(rotated, [fixed], 0.5, 0, 1);
    expect(pos[0]).toBeCloseTo(15.5);
  });

  it("recenters off-origin imports using world centers on the other axes", () => {
    const fixed = primitiveBox([20, 20, 20], [0, 0, 0]);
    const mesh: ImportedMesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 10]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      aabb: { min: [0, 0, 0], max: [10, 20, 10] },
      parts: [{
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 10]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      }],
    };
    const shiftedImport = importItem(mesh, [0, 0, 0]);

    const pos = stackItemRelativePosition(shiftedImport, [fixed], 0.5, 0, 1);
    expect(pos[0]).toBeCloseTo(10.5);
    expect(pos[1]).toBeCloseTo(-10);
    expect(pos[2]).toBeCloseTo(-5);
  });
});
