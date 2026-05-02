import { beforeEach, describe, expect, it } from "vitest";
import { defaultParams, type ImportedMesh } from "../cad/types";
import { useStore } from "./store";

function center(mesh: ImportedMesh, position: [number, number, number]): [number, number, number] {
  return [
    (mesh.aabb.min[0] + mesh.aabb.max[0]) / 2 + position[0],
    (mesh.aabb.min[1] + mesh.aabb.max[1]) / 2 + position[1],
    (mesh.aabb.min[2] + mesh.aabb.max[2]) / 2 + position[2],
  ];
}

beforeEach(() => {
  useStore.setState({
    items: [],
    params: defaultParams,
    cutouts: [],
    result: null,
    generating: false,
    error: null,
    showBase: true,
    showLid: true,
    showComponent: true,
    shellOpacity: 0.35,
  });
});

describe("useStore flipImportItem", () => {
  it("increments meshVersion when imported geometry changes", () => {
    const mesh: ImportedMesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 5, 0, 0, 0, 2]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      aabb: { min: [0, 0, 0], max: [10, 5, 2] },
      parts: [{
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 5, 0, 0, 0, 2]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      }],
    };

    useStore.getState().addImport("fixture", mesh);
    const initial = useStore.getState().items[0];
    if (initial.kind !== "import") throw new Error("expected import item");

    useStore.getState().flipImportItem(initial.id, 0);
    const flipped = useStore.getState().items[0];
    if (flipped.kind !== "import") throw new Error("expected import item");

    expect(flipped.meshVersion).toBe(1);
    expect(Array.from(flipped.mesh.positions)).not.toEqual(Array.from(initial.mesh.positions));
    expect(center(flipped.mesh, flipped.position)).toEqual(center(initial.mesh, initial.position));
  });
});
