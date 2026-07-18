import * as THREE from "three";
import { computeAabb } from "../cad/bbox";
import { connectedComponents } from "../cad/parts";
import { orientZUp } from "../cad/orient";
import type { ImportedMesh } from "../cad/types";

export interface LoadedImport {
  name: string;
  mesh: ImportedMesh;
}

export type SupportedFormat = "stl" | "obj" | "3mf" | "step";

export function detectFormat(filename: string): SupportedFormat | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "stl") return "stl";
  if (ext === "obj") return "obj";
  if (ext === "3mf") return "3mf";
  if (ext === "step" || ext === "stp") return "step";
  return null;
}

/** Merge a THREE.Object3D into a single non-indexed position-only Float32Array + index. */
function geometryFromObject(obj: THREE.Object3D): THREE.BufferGeometry {
  const geoms: THREE.BufferGeometry[] = [];
  obj.updateMatrixWorld(true);
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      // strip non-position attributes to keep merge cheap
      const pos = g.getAttribute("position");
      const nu = new THREE.BufferGeometry();
      nu.setAttribute("position", pos);
      if (g.index) nu.setIndex(g.index);
      geoms.push(nu);
    }
  });
  if (geoms.length === 0) return new THREE.BufferGeometry();
  return mergeGeometries(geoms);
}

function mergeGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0, totalIndices = 0;
  for (const g of geoms) {
    totalVerts += g.getAttribute("position").count;
    totalIndices += g.index ? g.index.count : g.getAttribute("position").count;
  }
  const positions = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  let vOff = 0, iOff = 0;
  for (const g of geoms) {
    const p = g.getAttribute("position").array as ArrayLike<number>;
    for (let i = 0; i < p.length; i++) positions[vOff * 3 + i] = p[i];
    const count = g.getAttribute("position").count;
    if (g.index) {
      const idx = g.index.array as ArrayLike<number>;
      for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vOff;
      iOff += idx.length;
    } else {
      for (let i = 0; i < count; i++) indices[iOff + i] = vOff + i;
      iOff += count;
    }
    vOff += count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

export async function loadComponent(file: File): Promise<LoadedImport> {
  const fmt = detectFormat(file.name);
  if (!fmt) throw new Error(`Unsupported file: ${file.name}`);
  const buf = await file.arrayBuffer();
  let geom: THREE.BufferGeometry;
  switch (fmt) {
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      geom = new STLLoader().parse(buf);
      break;
    }
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      const text = new TextDecoder().decode(buf);
      const obj = new OBJLoader().parse(text);
      geom = geometryFromObject(obj);
      break;
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      const obj = new ThreeMFLoader().parse(buf);
      geom = geometryFromObject(obj);
      break;
    }
    case "step": {
      const { loadStepAsGeometry } = await import("./stepLoader");
      geom = await loadStepAsGeometry(buf);
      break;
    }
  }

  // Flatten to non-indexed? No — keep index to save memory; worker/viewer handle either.
  const posAttr = geom.getAttribute("position");
  const positions = new Float32Array(posAttr.array as ArrayLike<number>);
  let indices: Uint32Array;
  if (geom.index) {
    indices = new Uint32Array(geom.index.array as ArrayLike<number>);
  } else {
    indices = new Uint32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) indices[i] = i;
  }

  const rawAabb = computeAabb(positions);
  const oriented = orientZUp(positions, rawAabb);
  if (oriented.rotation !== "none") {
    // eslint-disable-next-line no-console
    console.log(`[loader] auto-rotated model to Z-up (${oriented.rotation})`);
  }
  const parts = connectedComponents(oriented.positions, indices);
  return {
    name: file.name,
    mesh: {
      positions: oriented.positions,
      indices,
      aabb: oriented.aabb,
      parts,
    },
  };
}
