import { create } from "zustand";
import {
  Cutout,
  DebugMeshKey,
  EnclosureParams,
  FaceAxis,
  GenerateResult,
  ImportItem,
  ImportedMesh,
  Item,
  MeshData,
  Connection,
  Primitive,
  PrimitiveItem,
  Vec3,
  defaultParams,
  faceAxisNum,
  faceSignNum,
} from "../cad/types";
import { computeAabb, transformedAabb } from "../cad/bbox";
import { itemWorldAabb, placeAlongside } from "../cad/layout";
import { primitiveAabb, PRIMITIVE_DEFAULTS } from "../cad/presets";
import { buildEnclosureGeometry } from "../cad/shell";
import type { AABB } from "../cad/types";

type FlipAxis = 0 | 1 | 2;

export interface ConnectionPickPoint {
  endpoint: import("../cad/types").ConnectionEndpoint;
  point: Vec3;
  itemName: string;
}

interface ConnectionPickState {
  active: boolean;
  first: ConnectionPickPoint | null;
}

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

function aabbCenter(aabb: AABB): Vec3 {
  return [
    (aabb.min[0] + aabb.max[0]) / 2,
    (aabb.min[1] + aabb.max[1]) / 2,
    (aabb.min[2] + aabb.max[2]) / 2,
  ];
}

interface AppState {
  items: Item[];
  /** Primary (first) item controls the enclosure reference frame for UI. */
  params: EnclosureParams;
  cutouts: Cutout[];
  connections: Connection[];
  connectionPick: ConnectionPickState;
  result: GenerateResult | null;
  importing: boolean;
  importLabel: string | null;
  generating: boolean;
  error: string | null;
  showBase: boolean;
  showLid: boolean;
  showComponent: boolean;
  showDebug: boolean;
  showConnections: boolean;
  showGrid: boolean;
  showShellEdges: boolean;
  debugVisibility: Record<DebugMeshKey, boolean>;
  shellOpacity: number;

  addImport: (name: string, mesh: ImportedMesh) => void;
  addPrimitive: (name: string, primitive: Primitive) => void;
  removeItem: (id: string) => void;
  setItemPosition: (id: string, position: Vec3) => void;
  setItemRotation: (id: string, rotation: Vec3) => void;
  renameItem: (id: string, name: string) => void;
  setPrimitive: (id: string, primitive: Primitive) => void;
  setItemFitClearance: (id: string, fitClearance: number | null) => void;
  flipImportItem: (id: string, axis: FlipAxis) => void;
  flushItem: (id: string, face: FaceAxis) => void;
  unflushItem: (id: string) => void;
  clearItems: () => void;

  setParam: <K extends keyof EnclosureParams>(k: K, v: EnclosureParams[K]) => void;
  setParams: (p: EnclosureParams) => void;
  addCutout: (c: Cutout) => void;
  updateCutout: (id: string, patch: Partial<Cutout>) => void;
  removeCutout: (id: string) => void;
  addConnection: (c: Connection) => void;
  updateConnection: (id: string, patch: Partial<Connection>) => void;
  removeConnection: (id: string) => void;
  beginConnectionPick: () => void;
  setConnectionPickFirst: (p: ConnectionPickPoint) => void;
  cancelConnectionPick: () => void;
  setResult: (r: GenerateResult | null) => void;
  setImporting: (label: string | null) => void;
  setGenerating: (b: boolean) => void;
  setError: (e: string | null) => void;
  setVisibility: (k: "showBase" | "showLid" | "showComponent" | "showDebug" | "showConnections" | "showGrid" | "showShellEdges", v: boolean) => void;
  setDebugVisibility: (k: DebugMeshKey, v: boolean) => void;
  setShellOpacity: (v: number) => void;
}

function makeImportItem(name: string, mesh: ImportedMesh, position: Vec3): ImportItem {
  return {
    id: crypto.randomUUID(),
    kind: "import",
    name,
    mesh,
    meshVersion: 0,
    position,
    rotation: [0, 0, 0],
  };
}

function makePrimitiveItem(name: string, primitive: Primitive, position: Vec3): PrimitiveItem {
  return { id: crypto.randomUUID(), kind: "primitive", name, primitive, position, rotation: [0, 0, 0] };
}

export const useStore = create<AppState>((set) => ({
  items: [],
  params: defaultParams,
  cutouts: [],
  connections: [],
  connectionPick: { active: false, first: null },
  result: null,
  importing: false,
  importLabel: null,
  generating: false,
  error: null,
  showBase: true,
  showLid: true,
  showComponent: true,
  showDebug: false,
  showConnections: true,
  showGrid: true,
  showShellEdges: true,
  debugVisibility: {
    fit: true,
    access: true,
    relief: true,
    cutout: true,
    connection: true,
  },
  shellOpacity: 0.5,

  addImport: (name, mesh) => set((s) => ({
    items: [...s.items, makeImportItem(name, mesh, placeAlongside(s.items, mesh.aabb, s.params.clearance))],
  })),
  addPrimitive: (name, primitive) => set((s) => ({
    items: [...s.items, makePrimitiveItem(name, primitive, placeAlongside(s.items, primitiveAabb(primitive), s.params.clearance))],
  })),
  removeItem: (id) => set((s) => ({
    items: s.items.filter((it) => it.id !== id),
    connections: s.connections.filter((c) => c.a.itemId !== id && c.b.itemId !== id),
    connectionPick: s.connectionPick.first?.endpoint.itemId === id ? { active: false, first: null } : s.connectionPick,
  })),
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
  setItemFitClearance: (id, fitClearance) =>
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, fitClearance } : it)) })),
  flipImportItem: (id, axis) =>
    set((s) => ({
      items: s.items.map((it) => {
        if (it.id !== id || it.kind !== "import") return it;
        const nextMesh = flipImportedMesh(it.mesh, axis);
        const before = aabbCenter(it.mesh.aabb);
        const after = aabbCenter(nextMesh.aabb);
        const nextPosition: Vec3 = [
          it.position[0] + before[0] - after[0],
          it.position[1] + before[1] - after[1],
          it.position[2] + before[2] - after[2],
        ];
        return { ...it, mesh: nextMesh, position: nextPosition, meshVersion: it.meshVersion + 1 };
      }),
    })),
  flushItem: (id, face) =>
    set((s) => {
      const idx = s.items.findIndex((it) => it.id === id);
      if (idx < 0) return s;
      const allAabbs = s.items.map(itemWorldAabb);
      const axis = faceAxisNum(face);
      const sign = faceSignNum(face);
      // Compute combinedAabb matching the worker's flush logic: on the
      // flushed side use local rotated AABB (prevents circular growth), on
      // the opposite side use world AABB (tight fit around shifted item).
      const combined: AABB = {
        min: [Infinity, Infinity, Infinity] as Vec3,
        max: [-Infinity, -Infinity, -Infinity] as Vec3,
      };
      for (let i = 0; i < s.items.length; i++) {
        const box = allAabbs[i];
        const it = s.items[i];
        const itemFlush = i === idx ? face : it.flushFace;
        if (itemFlush) {
          const fAxis = faceAxisNum(itemFlush);
          const fSign = faceSignNum(itemFlush);
          const localAabb = it.kind === "import" ? it.mesh.aabb : primitiveAabb(it.primitive);
          const localRotated = transformedAabb(localAabb, it.rotation, [0, 0, 0] as Vec3);
          for (let a = 0; a < 3; a++) {
            if (a === fAxis) {
              if (fSign > 0) {
                combined.min[a] = Math.min(combined.min[a], box.min[a]);
                combined.max[a] = Math.max(combined.max[a], localRotated.max[a]);
              } else {
                combined.min[a] = Math.min(combined.min[a], localRotated.min[a]);
                combined.max[a] = Math.max(combined.max[a], box.max[a]);
              }
            } else {
              combined.min[a] = Math.min(combined.min[a], box.min[a]);
              combined.max[a] = Math.max(combined.max[a], box.max[a]);
            }
          }
        } else {
          for (let a = 0; a < 3; a++) {
            combined.min[a] = Math.min(combined.min[a], box.min[a]);
            combined.max[a] = Math.max(combined.max[a], box.max[a]);
          }
        }
      }
      for (let a = 0; a < 3; a++) {
        if (!isFinite(combined.min[a]) || !isFinite(combined.max[a]) || combined.min[a] >= combined.max[a]) {
          combined.min[a] = -1; combined.max[a] = 1;
        }
      }
      const geom = buildEnclosureGeometry(combined, s.params);
      const myAabb = allAabbs[idx];
      const pos: Vec3 = [s.items[idx].position[0], s.items[idx].position[1], s.items[idx].position[2]];
      if (sign > 0) {
        pos[axis] += geom.outer.max[axis] - myAabb.max[axis];
      } else {
        pos[axis] += geom.outer.min[axis] - myAabb.min[axis];
      }
      return {
        items: s.items.map((it) => it.id === id ? { ...it, position: pos, flushFace: face } : it),
      };
    }),
  unflushItem: (id) =>
    set((s) => ({
      items: s.items.map((it) => it.id === id ? { ...it, flushFace: null } : it),
    })),
  clearItems: () => set({ items: [], cutouts: [], connections: [], connectionPick: { active: false, first: null } }),

  setParam: (k, v) => set((s) => ({ params: { ...s.params, [k]: v } })),
  setParams: (p) => set({ params: p }),
  addCutout: (c) => set((s) => ({ cutouts: [...s.cutouts, c] })),
  updateCutout: (id, patch) =>
    set((s) => ({ cutouts: s.cutouts.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  removeCutout: (id) => set((s) => ({ cutouts: s.cutouts.filter((c) => c.id !== id) })),
  addConnection: (c) => set((s) => ({ connections: [...s.connections, c] })),
  updateConnection: (id, patch) =>
    set((s) => ({ connections: s.connections.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  removeConnection: (id) => set((s) => ({ connections: s.connections.filter((c) => c.id !== id) })),
  beginConnectionPick: () => set({ connectionPick: { active: true, first: null }, showComponent: true }),
  setConnectionPickFirst: (p) => set({ connectionPick: { active: true, first: p } }),
  cancelConnectionPick: () => set({ connectionPick: { active: false, first: null } }),
  setResult: (r) => set({ result: r }),
  setImporting: (label) => set({ importing: Boolean(label), importLabel: label }),
  setGenerating: (b) => set({ generating: b }),
  setError: (e) => set({ error: e }),
  setVisibility: (k, v) => set({ [k]: v } as Partial<AppState>),
  setDebugVisibility: (k, v) => set((s) => ({ debugVisibility: { ...s.debugVisibility, [k]: v } })),
  setShellOpacity: (v) => set({ shellOpacity: v }),
}));

/** World-space AABBs of an item's constituent parts: one per connected
 *  component for imports (pin headers, PCB, connectors...), one total for
 *  primitives. Using parts avoids false-positive overlap between a sparse
 *  envelope (e.g. pin-header tips) and a neighboring solid body. */
function itemPartAabbs(it: Item): AABB[] {
  if (it.kind === "import" && it.mesh.parts.length > 0) {
    return it.mesh.parts.map((p) =>
      transformedAabb(computeAabb(p.positions), it.rotation, it.position),
    );
  }
  return [itemWorldAabb(it)];
}

const aabbVolume = (b: AABB) =>
  Math.max(0, b.max[0] - b.min[0]) *
  Math.max(0, b.max[1] - b.min[1]) *
  Math.max(0, b.max[2] - b.min[2]);

/** Item IDs that meaningfully overlap. Compares each pair-of-parts; if any
 *  part of A intersects any part of B by >= `ratio` of the smaller part's
 *  volume, both items are flagged. A pin-header envelope is made up of many
 *  tiny pin AABBs, so a neighboring battery box only flags overlap if a pin
 *  truly pokes into it. */
export function overlappingItemIds(items: Item[], ratio = 0.1): Set<string> {
  const pieces = items.map((it) => ({ id: it.id, boxes: itemPartAabbs(it) }));
  const hit = new Set<string>();
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      let collided = false;
      for (const a of pieces[i].boxes) {
        if (collided) break;
        for (const b of pieces[j].boxes) {
          const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
          const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
          const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
          if (dx <= 0 || dy <= 0 || dz <= 0) continue;
          const ov = dx * dy * dz;
          const smaller = Math.min(aabbVolume(a), aabbVolume(b));
          if (smaller > 0 && ov / smaller >= ratio) {
            collided = true;
            break;
          }
        }
      }
      if (collided) {
        hit.add(pieces[i].id);
        hit.add(pieces[j].id);
      }
    }
  }
  return hit;
}

export { PRIMITIVE_DEFAULTS };
