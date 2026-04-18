export type Vec3 = [number, number, number];

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export type SnapPlacement = "both-y" | "both-x" | "+x" | "-x" | "+y" | "-y";

export interface EnclosureParams {
  /** Wall thickness on sides and lid (mm). */
  wall: number;
  /** Floor thickness below the component (mm). */
  floor: number;
  /** Air gap between component AABB and inner cavity walls (mm). */
  clearance: number;
  /** Outer corner fillet radius (mm). 0 disables. */
  fillet: number;
  /** Fraction of outer height that is lid (0..1). 0.25 = lid is top 25%. */
  lidFrac: number;
  /** Depth of the tongue/groove lip (mm). */
  lipDepth: number;
  /** Print-fit clearance between tongue and groove (mm, per side). */
  lipTol: number;
  /** When true, add discrete snap tabs on the tongue and matching relief
   *  pockets in the groove so the lid clicks into place. */
  snapFit: boolean;
  /** Outward protrusion of each snap tab (mm). */
  snapSize: number;
  /** Which wall or wall pair receives the snap tabs. */
  snapPlacement: SnapPlacement;
}

export const defaultParams: EnclosureParams = {
  wall: 2.0,
  floor: 1.6,
  clearance: 0.5,
  fillet: 1.0,
  lidFrac: 0.25,
  lipDepth: 3.0,
  lipTol: 0.2,
  snapFit: false,
  snapSize: 0.3,
  snapPlacement: "both-y",
};

export type FaceAxis = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

export interface Cutout {
  id: string;
  face: FaceAxis;
  /** Center position in face-local UV (mm, origin at face AABB min). */
  u: number;
  v: number;
  /** Width along U (mm). */
  w: number;
  /** Height along V (mm). */
  h: number;
  shape: "rect" | "circle";
}

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Raw imported mesh — positions/indices plus its connected sub-solids. */
export interface ImportedMesh {
  /** Positions flat Float32Array (x,y,z,x,y,z,...) in mm, model local frame. */
  positions: Float32Array;
  /** Triangle indices. */
  indices: Uint32Array;
  /** Local-frame AABB (before pose translation). */
  aabb: AABB;
  /** Connected sub-solids for per-part manifoldization (USB plug, etc.). */
  parts: MeshData[];
}

export type CylinderAxis = "x" | "y" | "z";

export type Primitive =
  | { kind: "box"; size: Vec3 }
  | { kind: "cylinder"; axis: CylinderAxis; radius: number; height: number };

interface ItemBase {
  id: string;
  name: string;
  /** Translation applied after rotation (mm). */
  position: Vec3;
  /** Euler rotation in degrees, applied in XYZ order about local origin. */
  rotation: Vec3;
  /** When set, the item is pushed to this face of the outer shell so parts
   *  extending past the main body punch through the wall (USB ports, etc.).
   *  The flushed axis is excluded from enclosure sizing so the box doesn't
   *  grow to accommodate the overshoot. */
  flushFace?: FaceAxis | null;
}

export function faceAxisNum(face: FaceAxis): 0 | 1 | 2 {
  if (face === "+x" || face === "-x") return 0;
  if (face === "+y" || face === "-y") return 1;
  return 2;
}

export function faceSignNum(face: FaceAxis): 1 | -1 {
  return face.startsWith("+") ? 1 : -1;
}

export interface ImportItem extends ItemBase {
  kind: "import";
  mesh: ImportedMesh;
  /** Bumps whenever the imported mesh geometry changes. */
  meshVersion: number;
}

export interface PrimitiveItem extends ItemBase {
  kind: "primitive";
  primitive: Primitive;
}

export type Item = ImportItem | PrimitiveItem;

/** Serialisable per-item payload handed to the worker. */
export interface ItemRequest {
  id: string;
  position: Vec3;
  rotation: Vec3;
  kind: "import" | "primitive";
  /** Local-frame AABB before rotation/position is applied. */
  aabb: AABB;
  parts?: MeshData[];
  primitive?: Primitive;
  meshVersion?: number;
  flushFace?: FaceAxis | null;
}

export interface GenerateRequest {
  items: ItemRequest[];
  params: EnclosureParams;
  cutouts: Cutout[];
}

export interface GenerateResult {
  base: MeshData;
  lid: MeshData;
  /** AABB of the outer shell, convenient for UI. */
  outer: AABB;
}
