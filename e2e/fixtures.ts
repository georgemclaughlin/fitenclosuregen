import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

type FixtureKind = "step" | "stl" | "obj" | "3mf";

const generatedDir = path.resolve("test-results/generated-fixtures");

const vertices = [
  [0, 0, 0], [10, 0, 0], [10, 8, 0], [0, 8, 0],
  [0, 0, 4], [10, 0, 4], [10, 8, 4], [0, 8, 4],
];
const triangles = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];

function objFixture(): string {
  return [
    "# Hermetic 10 x 8 x 4 mm box fixture",
    ...vertices.map((v) => `v ${v.join(" ")}`),
    ...triangles.map((t) => `f ${t.map((i) => i + 1).join(" ")}`),
    "",
  ].join("\n");
}

function stlFixture(): string {
  const facets = triangles.map((triangle) => {
    const points = triangle.map((index) => vertices[index]);
    return [
      "  facet normal 0 0 0",
      "    outer loop",
      ...points.map((point) => `      vertex ${point.join(" ")}`),
      "    endloop",
      "  endfacet",
    ].join("\n");
  });
  return ["solid fixture-box", ...facets, "endsolid fixture-box", ""].join("\n");
}

function threeMfFixture(): Uint8Array {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model" name="fixture-box">
      <mesh>
        <vertices>${vertices.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("")}</vertices>
        <triangles>${triangles.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join("")}</triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(relationships),
    "3D/3dmodel.model": strToU8(model),
  });
}

function ensureGeneratedFixtures(): Record<Exclude<FixtureKind, "step">, string> {
  mkdirSync(generatedDir, { recursive: true });
  const paths = {
    stl: path.join(generatedDir, "box.stl"),
    obj: path.join(generatedDir, "box.obj"),
    "3mf": path.join(generatedDir, "box.3mf"),
  };
  writeFileSync(paths.stl, stlFixture());
  writeFileSync(paths.obj, objFixture());
  writeFileSync(paths["3mf"], threeMfFixture());
  return paths;
}

const generated = ensureGeneratedFixtures();
const stepFixture = path.resolve("node_modules/occt-import-js/test/testfiles/cube-fcstd/cube.step");

/** Every supported importer gets a deterministic fixture after `npm ci`. */
export function findFixture(kind: FixtureKind): string | null {
  if (kind === "step") return existsSync(stepFixture) ? stepFixture : null;
  return generated[kind];
}
