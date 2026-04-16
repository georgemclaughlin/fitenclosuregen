import * as THREE from "three";

interface OcctMesh {
  attributes: { position: { array: number[] } };
  index: { array: number[] };
}
interface OcctResult {
  success: boolean;
  meshes: OcctMesh[];
}
interface OcctModule {
  ReadStepFile(buffer: Uint8Array, opts: unknown): OcctResult;
}

declare global {
  interface Window { occtimportjs?: () => Promise<OcctModule> }
}

const SCRIPT_URL = "/occt/occt-import-js.js";

let scriptPromise: Promise<void> | null = null;
let modulePromise: Promise<OcctModule> | null = null;

function loadScript(url: string): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

async function getOcct(): Promise<OcctModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      await loadScript(SCRIPT_URL);
      const init = window.occtimportjs;
      if (typeof init !== "function") {
        throw new Error("occt-import-js: global `occtimportjs` not present after script load");
      }
      return init();
    })();
  }
  return modulePromise;
}

export async function loadStepAsGeometry(buf: ArrayBuffer): Promise<THREE.BufferGeometry> {
  const occt = await getOcct();
  const result = occt.ReadStepFile(new Uint8Array(buf), null);
  if (!result.success) throw new Error("STEP import failed");
  const geoms: THREE.BufferGeometry[] = [];
  for (const mesh of result.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.attributes.position.array), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.index.array), 1));
    geoms.push(g);
  }
  if (geoms.length === 1) return geoms[0];
  let totalV = 0, totalI = 0;
  for (const g of geoms) {
    totalV += g.getAttribute("position").count;
    totalI += g.index!.count;
  }
  const positions = new Float32Array(totalV * 3);
  const indices = new Uint32Array(totalI);
  let vOff = 0, iOff = 0;
  for (const g of geoms) {
    const p = g.getAttribute("position").array as ArrayLike<number>;
    for (let i = 0; i < p.length; i++) positions[vOff * 3 + i] = p[i];
    const idx = g.index!.array as ArrayLike<number>;
    for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vOff;
    vOff += g.getAttribute("position").count;
    iOff += idx.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}
