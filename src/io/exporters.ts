import * as THREE from "three";
import { STLExporter } from "three-stdlib";
import type { MeshData } from "../cad/types";

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  return g;
}

function meshXExtent(m: MeshData): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < min) min = p[i];
    if (p[i] > max) max = p[i];
  }
  return { min, max };
}

/** Concatenate meshes into one, each translated by an independent offset. */
function mergeMeshes(parts: Array<{ mesh: MeshData; dx: number }>): MeshData {
  let vTotal = 0, iTotal = 0;
  for (const { mesh } of parts) {
    vTotal += mesh.positions.length / 3;
    iTotal += mesh.indices.length;
  }
  const positions = new Float32Array(vTotal * 3);
  const indices = new Uint32Array(iTotal);
  let vOff = 0, iOff = 0;
  for (const { mesh, dx } of parts) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      positions[(vOff + i / 3) * 3] = p[i] + dx;
      positions[(vOff + i / 3) * 3 + 1] = p[i + 1];
      positions[(vOff + i / 3) * 3 + 2] = p[i + 2];
    }
    const idx = mesh.indices;
    for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vOff;
    vOff += p.length / 3;
    iOff += idx.length;
  }
  return { positions, indices };
}

/** Combine base and lid into one mesh, placed side-by-side along X with a gap. */
export function combineForPrint(base: MeshData, lid: MeshData, gap = 5): MeshData {
  const bx = meshXExtent(base);
  const lx = meshXExtent(lid);
  // Shift base so its min sits at 0, and lid so its min sits at base.width + gap.
  const baseDx = -bx.min;
  const lidDx = (bx.max - bx.min) + gap - lx.min;
  return mergeMeshes([
    { mesh: base, dx: baseDx },
    { mesh: lid, dx: lidDx },
  ]);
}

export function downloadStl(mesh: MeshData, filename: string): void {
  const geom = toGeometry(mesh);
  const obj = new THREE.Mesh(geom);
  const exporter = new STLExporter();
  const ab = exporter.parse(obj, { binary: true }) as unknown as DataView;
  const blob = new Blob([new Uint8Array(ab.buffer as ArrayBuffer)], { type: "model/stl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
