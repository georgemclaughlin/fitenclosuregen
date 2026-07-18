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
  useStore.getState().loadProject({
    name: "Test project",
    items: [],
    params: defaultParams,
    cutouts: [],
    connections: [],
  }, { recordHistory: false });
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

describe("project history", () => {
  it("undoes and redoes discrete edits", () => {
    useStore.getState().addPrimitive("Box", { kind: "box", size: [10, 10, 5] });
    expect(useStore.getState().items).toHaveLength(1);
    expect(useStore.getState().canUndo).toBe(true);

    useStore.getState().undo();
    expect(useStore.getState().items).toHaveLength(0);
    expect(useStore.getState().canRedo).toBe(true);

    useStore.getState().redo();
    expect(useStore.getState().items).toHaveLength(1);
  });

  it("coalesces repeated edits to the same field", () => {
    useStore.getState().addPrimitive("Box", { kind: "box", size: [10, 10, 5] });
    const item = useStore.getState().items[0];
    useStore.getState().setItemPosition(item.id, [1, 0, 0]);
    useStore.getState().setItemPosition(item.id, [2, 0, 0]);
    useStore.getState().setItemPosition(item.id, [3, 0, 0]);

    useStore.getState().undo();
    expect(useStore.getState().items[0].position).toEqual([0, 0, 0]);
    useStore.getState().undo();
    expect(useStore.getState().items).toHaveLength(0);
  });

  it("can undo starting a new project", () => {
    useStore.getState().addPrimitive("Box", { kind: "box", size: [10, 10, 5] });
    useStore.getState().setProjectName("Saved design");
    useStore.getState().newProject();
    expect(useStore.getState().items).toHaveLength(0);
    expect(useStore.getState().projectName).toBe("Untitled enclosure");

    useStore.getState().undo();
    expect(useStore.getState().items).toHaveLength(1);
    expect(useStore.getState().projectName).toBe("Saved design");
  });
});
