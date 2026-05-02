import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import occtInit from "occt-import-js";
import { computeAabb, transformedAabb } from "../src/cad/bbox";
import { computeCombinedAabbWithFlush } from "../src/cad/flush";
import { countTrianglesOverlappingAabb } from "../src/cad/mesh-inspect";
import { orientZUp } from "../src/cad/orient";
import { connectedComponents } from "../src/cad/parts";
import { buildEnclosureGeometry } from "../src/cad/shell";
import { defaultParams, faceAxisNum, faceSignNum, type AABB, type FaceAxis, type ItemRequest, type MeshData, type Vec3 } from "../src/cad/types";
import { generate } from "../src/cad/worker";

type View = "xy" | "yz";

const DEBUG_COLORS = {
  fit: "#ff4f8b",
  access: "#ffd24a",
  relief: "#ff8c42",
  cutout: "#54d6ff",
} as const;

function usage(): never {
  console.error("usage: vite-node --script scripts/debug-flush-relief.ts <file.step> [--flip y] [--flush -y] [--out debug/name]");
  process.exit(1);
}

function mergeOcctMeshes(meshes: Array<{ attributes: { position: { array: ArrayLike<number> } }; index: { array: ArrayLike<number> } }>): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const mesh of meshes) {
    const pos = mesh.attributes.position.array;
    const idx = mesh.index.array;
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
    for (let i = 0; i < idx.length; i++) indices.push(Number(idx[i]) + vertexOffset);
    vertexOffset += pos.length / 3;
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

function flipPositions(pos: Float32Array, axis: 0 | 1 | 2): Float32Array {
  const out = new Float32Array(pos.length);
  const a = axis;
  const b = (axis + 1) % 3;
  const c = (axis + 2) % 3;
  for (let i = 0; i < pos.length; i += 3) {
    out[i + a] = pos[i + a];
    out[i + b] = -pos[i + b];
    out[i + c] = -pos[i + c];
  }
  return out;
}

function flipMesh(mesh: MeshData, axis: 0 | 1 | 2): MeshData {
  return { positions: flipPositions(mesh.positions, axis), indices: mesh.indices };
}

function worldMesh(mesh: MeshData, position: Vec3): MeshData {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i] + position[0];
    positions[i + 1] = mesh.positions[i + 1] + position[1];
    positions[i + 2] = mesh.positions[i + 2] + position[2];
  }
  return { positions, indices: mesh.indices };
}

function meshAabb(mesh: MeshData): AABB {
  return computeAabb(mesh.positions);
}

function flushPosition(item: ItemRequest, face: FaceAxis): Vec3 {
  const preWorld = transformedAabb(item.aabb, item.rotation, item.position);
  const combined = computeCombinedAabbWithFlush(
    [{ aabb: item.aabb, rotation: item.rotation, flushFace: face }],
    [preWorld],
  );
  const geom = buildEnclosureGeometry(combined, defaultParams);
  const next: Vec3 = [...item.position];
  const axis = faceAxisNum(face);
  const sign = faceSignNum(face);
  if (sign > 0) next[axis] += geom.outer.max[axis] - preWorld.max[axis];
  else next[axis] += geom.outer.min[axis] - preWorld.min[axis];
  return next;
}

function projectPoint(view: View, x: number, y: number, z: number): [number, number] {
  return view === "xy" ? [x, y] : [y, z];
}

function svgPathForMesh(mesh: MeshData, view: View, mapPoint: (u: number, v: number) => [number, number]): string {
  const { positions, indices } = mesh;
  const parts: string[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    const a = mapPoint(...projectPoint(view, positions[ia], positions[ia + 1], positions[ia + 2]));
    const b = mapPoint(...projectPoint(view, positions[ib], positions[ib + 1], positions[ib + 2]));
    const c = mapPoint(...projectPoint(view, positions[ic], positions[ic + 1], positions[ic + 2]));
    parts.push(`M${a[0].toFixed(2)},${a[1].toFixed(2)}L${b[0].toFixed(2)},${b[1].toFixed(2)}L${c[0].toFixed(2)},${c[1].toFixed(2)}Z`);
  }
  return parts.join("");
}

function renderSvg(
  view: View,
  bounds: AABB,
  layers: Array<{ mesh: MeshData; fill: string; opacity: number; stroke?: string; strokeWidth?: number }>,
): string {
  const width = 1200;
  const height = 900;
  const padding = 40;
  const [u0, v0] = view === "xy"
    ? [bounds.min[0], bounds.min[1]]
    : [bounds.min[1], bounds.min[2]];
  const [u1, v1] = view === "xy"
    ? [bounds.max[0], bounds.max[1]]
    : [bounds.max[1], bounds.max[2]];
  const spanU = Math.max(1e-3, u1 - u0);
  const spanV = Math.max(1e-3, v1 - v0);
  const scale = Math.min((width - padding * 2) / spanU, (height - padding * 2) / spanV);
  const drawW = spanU * scale;
  const drawH = spanV * scale;
  const originX = (width - drawW) / 2;
  const originY = (height - drawH) / 2;
  const mapPoint = (u: number, v: number): [number, number] => [
    originX + (u - u0) * scale,
    height - (originY + (v - v0) * scale),
  ];

  const body = layers
    .map((layer) => {
      const d = svgPathForMesh(layer.mesh, view, mapPoint);
      const stroke = layer.stroke ?? "none";
      const strokeWidth = layer.strokeWidth ?? 0;
      return `<path d="${d}" fill="${layer.fill}" fill-opacity="${layer.opacity}" stroke="${stroke}" stroke-width="${strokeWidth}" />`;
    })
    .join("\n");

  const outlineMin = mapPoint(u0, v0);
  const outlineMax = mapPoint(u1, v1);
  const rectX = Math.min(outlineMin[0], outlineMax[0]);
  const rectY = Math.min(outlineMin[1], outlineMax[1]);
  const rectW = Math.abs(outlineMax[0] - outlineMin[0]);
  const rectH = Math.abs(outlineMax[1] - outlineMin[1]);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#10131a" />
  <rect x="${rectX.toFixed(2)}" y="${rectY.toFixed(2)}" width="${rectW.toFixed(2)}" height="${rectH.toFixed(2)}" fill="none" stroke="#4d5b74" stroke-width="1.5" />
  ${body}
</svg>`;
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const file = args.shift();
  if (!file) usage();
  let flip: 0 | 1 | 2 | null = null;
  let flush: FaceAxis = "-y";
  let out = "debug/ttgo-flipY-flush-negY";
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--flip") {
      const axis = args.shift();
      if (axis === "x") flip = 0;
      else if (axis === "y") flip = 1;
      else if (axis === "z") flip = 2;
      else usage();
    } else if (arg === "--flush") {
      const face = args.shift() as FaceAxis | undefined;
      if (!face) usage();
      flush = face;
    } else if (arg === "--out") {
      out = args.shift() ?? out;
    } else {
      usage();
    }
  }
  return { file, flip, flush, out };
}

const { file, flip, flush, out } = parseArgs(process.argv.slice(2));

const buf = await readFile(file);
const occt = await occtInit();
const step = occt.ReadStepFile(new Uint8Array(buf), null);
if (!step.success) throw new Error("STEP import failed");

const raw = mergeOcctMeshes(step.meshes as Array<{ attributes: { position: { array: ArrayLike<number> } }; index: { array: ArrayLike<number> } }>);
const oriented = orientZUp(raw.positions, computeAabb(raw.positions));
let mesh: MeshData = {
  positions: oriented.positions,
  indices: raw.indices,
};
let parts = connectedComponents(mesh.positions, mesh.indices);

if (flip !== null) {
  mesh = flipMesh(mesh, flip);
  parts = parts.map((part) => flipMesh(part, flip));
}

const importAabb = meshAabb(mesh);
const item: ItemRequest = {
  id: "debug-import",
  kind: "import",
  aabb: importAabb,
  parts,
  meshVersion: 0,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  flushFace: flush,
};
item.position = flushPosition(item, flush);

const result = await generate({ items: [item], params: defaultParams, cutouts: [] });
const worldComponent = worldMesh(mesh, item.position);
const layers = [
  { mesh: result.base, fill: "#b3762b", opacity: 0.08 },
  { mesh: worldComponent, fill: "#2d6cdf", opacity: 0.18, stroke: "#6da0ff", strokeWidth: 0.2 },
  ...((result.debug ?? []).map((debug) => ({
    mesh: debug.mesh,
    fill: DEBUG_COLORS[debug.key],
    opacity: debug.key === "cutout" ? 0.82 : 0.72,
    stroke: DEBUG_COLORS[debug.key],
    strokeWidth: 0.6,
  }))),
];

await mkdir(path.dirname(out), { recursive: true });
await writeFile(`${out}-xy.svg`, renderSvg("xy", result.outer, layers));
await writeFile(`${out}-yz.svg`, renderSvg("yz", result.outer, layers));

const summary: {
  file: string;
  flip: 0 | 1 | 2 | null;
  flush: FaceAxis;
  outer: AABB;
  itemAabb: AABB;
  debug: Array<{ key: string; aabb: AABB; triangles: number }>;
  leftFrontOpenHits?: number;
  rightFrontOpenHits?: number;
} = {
  file,
  flip,
  flush,
  outer: result.outer,
  itemAabb: transformedAabb(item.aabb, item.rotation, item.position),
  debug: (result.debug ?? []).map((debug) => ({
    key: debug.key,
    aabb: meshAabb(debug.mesh),
    triangles: debug.mesh.indices.length / 3,
  })),
};
const relief = summary.debug.find((debug) => debug.key === "relief")?.aabb;
const cutout = summary.debug.find((debug) => debug.key === "cutout")?.aabb;
const frontWallTop = result.outer.min[1] + defaultParams.wall;
if (relief && cutout) {
  const zMin = relief.min[2] + 0.08;
  const zMax = relief.max[2] - 0.08;
  const yMin = result.outer.min[1] + 0.08;
  const yMax = frontWallTop - 0.08;
  if (cutout.min[0] - relief.min[0] > 2.2) {
    summary["leftFrontOpenHits"] = countTrianglesOverlappingAabb(result.base, {
      min: [relief.min[0] + 0.5, yMin, zMin],
      max: [cutout.min[0] - 0.5, yMax, zMax],
    });
  }
  if (relief.max[0] - cutout.max[0] > 2.2) {
    summary["rightFrontOpenHits"] = countTrianglesOverlappingAabb(result.base, {
      min: [cutout.max[0] + 0.5, yMin, zMin],
      max: [relief.max[0] - 0.5, yMax, zMax],
    });
  }
}
const frontBounds: AABB = {
  min: [result.outer.min[0], result.outer.min[1] - 0.5, summary.itemAabb.min[2] - 0.5],
  max: [result.outer.max[0], Math.min(summary.itemAabb.min[1] + 8, result.outer.max[1]), result.outer.max[2]],
};
await writeFile(`${out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(`${out}-front-xy.svg`, renderSvg("xy", frontBounds, layers));
await writeFile(`${out}-front-yz.svg`, renderSvg("yz", frontBounds, layers));
console.log(JSON.stringify(summary, null, 2));
