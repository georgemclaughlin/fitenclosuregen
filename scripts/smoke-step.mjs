// Smoke-test the STEP → mesh pipeline in Node, using the same occt-import-js
// package the browser uses. Prints mesh count + total vert/tri counts and AABB.
import { readFile } from "node:fs/promises";
import occtInit from "occt-import-js";

const path = process.argv[2];
if (!path) { console.error("usage: node scripts/smoke-step.mjs <file.step>"); process.exit(1); }

const buf = await readFile(path);
const occt = await occtInit();
const result = occt.ReadStepFile(new Uint8Array(buf), null);
if (!result.success) { console.error("STEP import failed"); process.exit(2); }

let totalV = 0, totalT = 0;
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (const m of result.meshes) {
  const p = m.attributes.position.array;
  totalV += p.length / 3;
  totalT += m.index.array.length / 3;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
    if (p[i+1] < minY) minY = p[i+1]; if (p[i+1] > maxY) maxY = p[i+1];
    if (p[i+2] < minZ) minZ = p[i+2]; if (p[i+2] > maxZ) maxZ = p[i+2];
  }
}
console.log(`meshes: ${result.meshes.length}  verts: ${totalV}  tris: ${totalT}`);
console.log(`AABB: [${minX.toFixed(2)}, ${minY.toFixed(2)}, ${minZ.toFixed(2)}] -> [${maxX.toFixed(2)}, ${maxY.toFixed(2)}, ${maxZ.toFixed(2)}]`);
console.log(`size: ${(maxX-minX).toFixed(2)} x ${(maxY-minY).toFixed(2)} x ${(maxZ-minZ).toFixed(2)} mm`);
