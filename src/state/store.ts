import { create } from "zustand";
import {
  Cutout,
  EnclosureParams,
  GenerateResult,
  ImportItem,
  ImportedMesh,
  Item,
  MeshData,
  Primitive,
  PrimitiveItem,
  Vec3,
  defaultParams,
} from "../cad/types";
import { computeAabb, transformedAabb } from "../cad/bbox";
import { primitiveAabb, PRIMITIVE_DEFAULTS } from "../cad/presets";

type FlipAxis = 0 | 1 | 2;

function flipPositions(pos: Float32Array, axis: FlipAxis): Float32Array {
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

function flipImportedMesh(m: ImportedMesh, axis: FlipAxis): ImportedMesh {
  const positions = flipPositions(m.positions, axis);
  const parts: MeshData[] = m.parts.map((p) => ({
    positions: flipPositions(p.positions, axis),
    indices: p.indices,
  }));
  return { positions, indices: m.indices, aabb: computeAabb(positions), parts };
}

interface AppState {
  items: Item[];
  /** Primary (first) item controls the enclosure reference frame for UI. */
  params: EnclosureParams;
  cutouts: Cutout[];
  result: GenerateResult | null;
  generating: boolean;
  error: string | null;
  showBase: boolean;
  showLid: boolean;
  showComponent: boolean;
  shellOpacity: number;

  addImport: (name: string, mesh: ImportedMesh) => void;
  addPrimitive: (name: string, primitive: Primitive) => void;
  removeItem: (id: string) => void;
  setItemPosition: (id: string, position: Vec3) => void;
  setItemRotation: (id: string, rotation: Vec3) => void;
  renameItem: (id: string, name: string) => void;
  setPrimitive: (id: string, primitive: Primitive) => void;
  flipImportItem: (id: string, axis: FlipAxis) => void;
  clearItems: () => void;

  setParam: <K extends keyof EnclosureParams>(k: K, v: EnclosureParams[K]) => void;
  setParams: (p: EnclosureParams) => void;
  addCutout: (c: Cutout) => void;
  updateCutout: (id: string, patch: Partial<Cutout>) => void;
  removeCutout: (id: string) => void;
  setResult: (r: GenerateResult | null) => void;
  setGenerating: (b: boolean) => void;
  setError: (e: string | null) => void;
  setVisibility: (k: "showBase" | "showLid" | "showComponent", v: boolean) => void;
  setShellOpacity: (v: number) => void;
}

function makeImportItem(name: string, mesh: ImportedMesh, position: Vec3): ImportItem {
  return { id: crypto.randomUUID(), kind: "import", name, mesh, position, rotation: [0, 0, 0] };
}

function makePrimitiveItem(name: string, primitive: Primitive, position: Vec3): PrimitiveItem {
  return { id: crypto.randomUUID(), kind: "primitive", name, primitive, position, rotation: [0, 0, 0] };
}

/** Place a new item alongside the existing stack so it doesn't overlap.
 *  Picks the axis with the most headroom (largest current extent) and lays
 *  the new item flush against the +side of the existing bounding box. */
function placeAlongside(
  existing: Item[],
  localAabb: { min: Vec3; max: Vec3 },
  clearance: number,
): Vec3 {
  if (existing.length === 0) return [0, 0, 0];
  const boxes = existing.map(itemWorldAabb);
  const combined = {
    min: [Infinity, Infinity, Infinity] as Vec3,
    max: [-Infinity, -Infinity, -Infinity] as Vec3,
  };
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < combined.min[i]) combined.min[i] = b.min[i];
      if (b.max[i] > combined.max[i]) combined.max[i] = b.max[i];
    }
  }
  // Longest axis of existing stack → place along that axis to keep the enclosure proportionate.
  const extents: Vec3 = [
    combined.max[0] - combined.min[0],
    combined.max[1] - combined.min[1],
    combined.max[2] - combined.min[2],
  ];
  const axis: 0 | 1 | 2 = extents[0] >= extents[1] && extents[0] >= extents[2]
    ? 0
    : extents[1] >= extents[2] ? 1 : 2;
  const halfNew = (localAabb.max[axis] - localAabb.min[axis]) / 2;
  const centerNew = (localAabb.min[axis] + localAabb.max[axis]) / 2;
  const pos: Vec3 = [0, 0, 0];
  pos[axis] = combined.max[axis] + clearance + halfNew - centerNew;
  // Center the other two axes on the existing stack's centroid.
  for (const a of [0, 1, 2] as const) {
    if (a === axis) continue;
    const c = (combined.min[a] + combined.max[a]) / 2;
    const localC = (localAabb.min[a] + localAabb.max[a]) / 2;
    pos[a] = c - localC;
  }
  return pos;
}

export const useStore = create<AppState>((set) => ({
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

  addImport: (name, mesh) => set((s) => ({
    items: [...s.items, makeImportItem(name, mesh, placeAlongside(s.items, mesh.aabb, s.params.clearance))],
  })),
  addPrimitive: (name, primitive) => set((s) => ({
    items: [...s.items, makePrimitiveItem(name, primitive, placeAlongside(s.items, primitiveAabb(primitive), s.params.clearance))],
  })),
  removeItem: (id) => set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  setItemPosition: (id, position) =>
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, position } : it)) })),
  setItemRotation: (id, rotation) =>
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, rotation } : it)) })),
  renameItem: (id, name) =>
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, name } : it)) })),
  setPrimitive: (id, primitive) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id && it.kind === "primitive" ? { ...it, primitive } : it,
      ),
    })),
  flipImportItem: (id, axis) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id && it.kind === "import" ? { ...it, mesh: flipImportedMesh(it.mesh, axis) } : it,
      ),
    })),
  clearItems: () => set({ items: [], cutouts: [] }),

  setParam: (k, v) => set((s) => ({ params: { ...s.params, [k]: v } })),
  setParams: (p) => set({ params: p }),
  addCutout: (c) => set((s) => ({ cutouts: [...s.cutouts, c] })),
  updateCutout: (id, patch) =>
    set((s) => ({ cutouts: s.cutouts.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  removeCutout: (id) => set((s) => ({ cutouts: s.cutouts.filter((c) => c.id !== id) })),
  setResult: (r) => set({ result: r }),
  setGenerating: (b) => set({ generating: b }),
  setError: (e) => set({ error: e }),
  setVisibility: (k, v) => set({ [k]: v } as Partial<AppState>),
  setShellOpacity: (v) => set({ shellOpacity: v }),
}));

/** Item IDs that overlap any other item (AABB intersection with a small
 *  epsilon to ignore shared face touches). */
export function overlappingItemIds(items: Item[], epsilon = 0.05): Set<string> {
  const boxes = items.map((it) => ({ id: it.id, box: itemWorldAabb(it) }));
  const hit = new Set<string>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].box, b = boxes[j].box;
      const overlap = (
        a.min[0] < b.max[0] - epsilon && a.max[0] > b.min[0] + epsilon &&
        a.min[1] < b.max[1] - epsilon && a.max[1] > b.min[1] + epsilon &&
        a.min[2] < b.max[2] - epsilon && a.max[2] > b.min[2] + epsilon
      );
      if (overlap) {
        hit.add(boxes[i].id);
        hit.add(boxes[j].id);
      }
    }
  }
  return hit;
}

/** World-space AABB of an item after rotation + position are applied. */
export function itemWorldAabb(it: Item) {
  const local = it.kind === "import" ? it.mesh.aabb : primitiveAabb(it.primitive);
  return transformedAabb(local, it.rotation, it.position);
}

export { PRIMITIVE_DEFAULTS };
