import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { defaultParams, type ImportedMesh, type Item } from "../cad/types";
import { decodeProject, encodeProject, projectFilename } from "./format";
import type { ProjectSnapshot } from "./types";

const importedMesh: ImportedMesh = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 8, 0]),
  indices: new Uint32Array([0, 1, 2]),
  aabb: { min: [0, 0, 0], max: [10, 8, 0] },
  parts: [{
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 8, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }],
};

function fixture(): ProjectSnapshot {
  const items: Item[] = [
    {
      id: "import-1",
      kind: "import",
      name: "Board",
      position: [1, 2, 3],
      rotation: [0, 0, 90],
      meshVersion: 2,
      flushFace: "+x",
      fitClearance: 0.4,
      mesh: importedMesh,
    },
    {
      id: "box-1",
      kind: "primitive",
      name: "Battery",
      position: [12, 0, 0],
      rotation: [0, 0, 0],
      primitive: { kind: "box", size: [10, 20, 5] },
    },
  ];
  return {
    name: "Portable fixture",
    items,
    params: { ...defaultParams, wall: 2.4 },
    cutouts: [{ id: "cutout-1", face: "+x", u: 4, v: 3, w: 8, h: 4, shape: "rect" }],
    connections: [{
      id: "connection-1",
      name: "Cable",
      a: { itemId: "import-1", face: "+x", u: 2, v: 1, depth: 2 },
      b: { itemId: "box-1", face: "-x", u: 2, v: 1, depth: 2 },
      shape: "round",
      width: 2,
      height: 2,
      clearance: 0.5,
    }],
  };
}

function rewriteManifest(
  encoded: Uint8Array,
  rewrite: (manifest: Record<string, unknown>) => void,
): Uint8Array {
  const files = unzipSync(encoded);
  const manifest = JSON.parse(strFromU8(files["project.json"])) as Record<string, unknown>;
  rewrite(manifest);
  files["project.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}

describe("portable project format", () => {
  it("round-trips project state and imported mesh buffers", () => {
    const encoded = encodeProject(fixture());
    const decoded = decodeProject(encoded);

    expect(decoded.name).toBe("Portable fixture");
    expect(decoded.params.wall).toBe(2.4);
    expect(decoded.cutouts).toEqual(fixture().cutouts);
    expect(decoded.connections).toEqual(fixture().connections);
    expect(decoded.items[1]).toEqual(fixture().items[1]);
    const imported = decoded.items[0];
    if (imported.kind !== "import") throw new Error("expected imported item");
    expect(Array.from(imported.mesh.positions)).toEqual(Array.from(importedMesh.positions));
    expect(Array.from(imported.mesh.indices)).toEqual(Array.from(importedMesh.indices));
    expect(Array.from(imported.mesh.parts[0].positions)).toEqual(Array.from(importedMesh.parts[0].positions));
  });

  it("rejects data that is not a project archive", () => {
    expect(() => decodeProject(new Uint8Array([1, 2, 3]))).toThrow(/readable \.dropfit/);
  });

  it("rejects routes that reference missing items", () => {
    const encoded = rewriteManifest(encodeProject(fixture()), (manifest) => {
      const connections = manifest.connections as Array<{ a: { itemId: string } }>;
      connections[0].a.itemId = "missing-item";
    });
    expect(() => decodeProject(encoded)).toThrow(/references a missing item/);
  });

  it("creates filesystem-safe project names", () => {
    expect(projectFilename(" My USB / Sensor Case ")).toBe("my-usb-sensor-case.dropfit");
  });
});
