import { describe, expect, it } from "vitest";
import type { MeshData } from "../cad/types";
import { combineForPrint, placeMeshOnBed } from "./exporters";

function makeBoxMesh(min: [number, number, number], max: [number, number, number]): MeshData {
  const positions = new Float32Array([
    min[0], min[1], min[2],
    min[0], min[1], max[2],
    min[0], max[1], min[2],
    min[0], max[1], max[2],
    max[0], min[1], min[2],
    max[0], min[1], max[2],
    max[0], max[1], min[2],
    max[0], max[1], max[2],
  ]);
  const indices = new Uint32Array([
    0, 4, 6, 0, 6, 2,
    1, 3, 7, 1, 7, 5,
    0, 1, 5, 0, 5, 4,
    2, 6, 7, 2, 7, 3,
    0, 2, 3, 0, 3, 1,
    4, 5, 7, 4, 7, 6,
  ]);
  return { positions, indices };
}

function zExtent(mesh: MeshData): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) {
    if (mesh.positions[i] < min) min = mesh.positions[i];
    if (mesh.positions[i] > max) max = mesh.positions[i];
  }
  return { min, max };
}

describe("placeMeshOnBed", () => {
  it("translates a mesh so its lowest Z sits on the print bed", () => {
    const mesh = makeBoxMesh([-1, -1, 3.2], [1, 1, 5.6]);
    const placed = placeMeshOnBed(mesh);
    expect(zExtent(placed)).toEqual({ min: 0, max: 2.3999998569488525 });
  });
});

describe("combineForPrint", () => {
  it("places both parts side-by-side with each part resting on the bed", () => {
    const base = makeBoxMesh([-2, -2, -1.6], [2, 2, 3.4]);
    const lid = makeBoxMesh([-2, -2, 3.2], [2, 2, 6.4]);
    const combined = combineForPrint(base, lid, 5);
    const extent = zExtent(combined);
    expect(extent.min).toBe(0);
    expect(extent.max).toBeCloseTo(5, 5);
  });
});
