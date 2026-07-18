import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { defaultParams } from "../cad/types";
import type {
  AABB,
  Connection,
  Cutout,
  EnclosureParams,
  FaceAxis,
  ImportItem,
  Item,
  Primitive,
  Vec3,
} from "../cad/types";
import { PROJECT_FORMAT, PROJECT_VERSION, type ProjectSnapshot } from "./types";

const MANIFEST_PATH = "project.json";
export const MAX_PROJECT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const MAX_PROJECT_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const FACES = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;

interface MeshManifest {
  positions: string;
  indices: string;
}

interface ImportMeshManifest extends MeshManifest {
  aabb: AABB;
  parts: MeshManifest[];
}

type ItemManifest =
  | Omit<Extract<Item, { kind: "primitive" }>, "primitive"> & { primitive: Primitive }
  | Omit<ImportItem, "mesh"> & { mesh: ImportMeshManifest };

interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  savedAt: string;
  name: string;
  params: EnclosureParams;
  cutouts: Cutout[];
  connections: Connection[];
  items: ItemManifest[];
}

function ownBytes(array: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice();
}

function safeName(name: string): string {
  const trimmed = name.trim();
  return trimmed.slice(0, 120) || "Untitled enclosure";
}

export function projectFilename(name: string): string {
  const stem = safeName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "dropfit-project";
  return `${stem}.dropfit`;
}

export function encodeProject(snapshot: ProjectSnapshot): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const items: ItemManifest[] = snapshot.items.map((item, itemIndex) => {
    if (item.kind === "primitive") return { ...item, primitive: item.primitive };

    const root = `meshes/${itemIndex}`;
    const positions = `${root}/positions.f32`;
    const indices = `${root}/indices.u32`;
    files[positions] = ownBytes(item.mesh.positions);
    files[indices] = ownBytes(item.mesh.indices);
    const parts = item.mesh.parts.map((part, partIndex) => {
      const partPositions = `${root}/parts/${partIndex}.positions.f32`;
      const partIndices = `${root}/parts/${partIndex}.indices.u32`;
      files[partPositions] = ownBytes(part.positions);
      files[partIndices] = ownBytes(part.indices);
      return { positions: partPositions, indices: partIndices };
    });
    const { mesh: _mesh, ...base } = item;
    return {
      ...base,
      mesh: { positions, indices, aabb: item.mesh.aabb, parts },
    };
  });

  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    name: safeName(snapshot.name),
    params: snapshot.params,
    cutouts: snapshot.cutouts,
    connections: snapshot.connections,
    items,
  };
  files[MANIFEST_PATH] = strToU8(JSON.stringify(manifest));
  return zipSync(files, { level: 6 });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid project: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid project: ${label} must be a finite number`);
  }
  return value;
}

function vec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`Invalid project: ${label} must contain three numbers`);
  }
  return [finite(value[0], label), finite(value[1], label), finite(value[2], label)];
}

function aabb(value: unknown, label: string): AABB {
  const record = object(value, label);
  const min = vec3(record.min, `${label}.min`);
  const max = vec3(record.max, `${label}.max`);
  if (min.some((entry, axis) => entry > max[axis])) {
    throw new Error(`Invalid project: ${label} has inverted bounds`);
  }
  return { min, max };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid project: ${label} must be text`);
  return value;
}

function bytes(files: Record<string, Uint8Array>, pathValue: unknown, label: string): Uint8Array {
  const path = text(pathValue, label);
  const data = files[path];
  if (!data) throw new Error(`Invalid project: missing ${path}`);
  if (data.byteLength > MAX_BUFFER_BYTES) throw new Error(`Invalid project: ${path} is too large`);
  return data;
}

function typedArray<T extends Float32Array | Uint32Array>(
  data: Uint8Array,
  stride: number,
  make: (buffer: ArrayBuffer) => T,
  label: string,
): T {
  if (data.byteLength % stride !== 0) throw new Error(`Invalid project: ${label} is misaligned`);
  const copy = data.slice().buffer;
  return make(copy);
}

function meshData(files: Record<string, Uint8Array>, value: unknown, label: string) {
  const record = object(value, label);
  const positions = typedArray(
    bytes(files, record.positions, `${label}.positions`),
    Float32Array.BYTES_PER_ELEMENT,
    (buffer) => new Float32Array(buffer),
    `${label}.positions`,
  );
  const indices = typedArray(
    bytes(files, record.indices, `${label}.indices`),
    Uint32Array.BYTES_PER_ELEMENT,
    (buffer) => new Uint32Array(buffer),
    `${label}.indices`,
  );
  if (positions.length === 0 || positions.length % 3 !== 0 || indices.length % 3 !== 0) {
    throw new Error(`Invalid project: ${label} is not a triangle mesh`);
  }
  for (const position of positions) {
    if (!Number.isFinite(position)) {
      throw new Error(`Invalid project: ${label} contains a non-finite position`);
    }
  }
  const vertexCount = positions.length / 3;
  for (const index of indices) {
    if (index >= vertexCount) throw new Error(`Invalid project: ${label} contains an invalid index`);
  }
  return { positions, indices };
}

function primitive(value: unknown, label: string): Primitive {
  const record = object(value, label);
  if (record.kind === "box") return { kind: "box", size: vec3(record.size, `${label}.size`) };
  if (record.kind === "cylinder") {
    if (record.axis !== "x" && record.axis !== "y" && record.axis !== "z") {
      throw new Error(`Invalid project: ${label}.axis is unsupported`);
    }
    return {
      kind: "cylinder",
      axis: record.axis,
      radius: finite(record.radius, `${label}.radius`),
      height: finite(record.height, `${label}.height`),
    };
  }
  throw new Error(`Invalid project: ${label}.kind is unsupported`);
}

function itemBase(record: Record<string, unknown>, label: string) {
  const flushFace = record.flushFace;
  if (flushFace != null && !FACES.includes(flushFace as FaceAxis)) {
    throw new Error(`Invalid project: ${label}.flushFace is unsupported`);
  }
  const base: {
    id: string;
    name: string;
    position: Vec3;
    rotation: Vec3;
    flushFace?: Item["flushFace"];
    fitClearance?: number | null;
  } = {
    id: text(record.id, `${label}.id`),
    name: text(record.name, `${label}.name`).slice(0, 240),
    position: vec3(record.position, `${label}.position`),
    rotation: vec3(record.rotation, `${label}.rotation`),
  };
  if (flushFace !== undefined) base.flushFace = flushFace as Item["flushFace"];
  if (record.fitClearance !== undefined) {
    base.fitClearance = record.fitClearance === null
      ? null
      : finite(record.fitClearance, `${label}.fitClearance`);
  }
  return base;
}

function face(value: unknown, label: string): FaceAxis {
  if (!FACES.includes(value as FaceAxis)) {
    throw new Error(`Invalid project: ${label} is unsupported`);
  }
  return value as FaceAxis;
}

function cutout(value: unknown, label: string): Cutout {
  const record = object(value, label);
  if (record.shape !== "rect" && record.shape !== "circle") {
    throw new Error(`Invalid project: ${label}.shape is unsupported`);
  }
  return {
    id: text(record.id, `${label}.id`),
    face: face(record.face, `${label}.face`),
    u: finite(record.u, `${label}.u`),
    v: finite(record.v, `${label}.v`),
    w: finite(record.w, `${label}.w`),
    h: finite(record.h, `${label}.h`),
    shape: record.shape,
  };
}

function connectionEndpoint(value: unknown, label: string): Connection["a"] {
  const record = object(value, label);
  return {
    itemId: text(record.itemId, `${label}.itemId`),
    face: face(record.face, `${label}.face`),
    u: finite(record.u, `${label}.u`),
    v: finite(record.v, `${label}.v`),
    depth: finite(record.depth, `${label}.depth`),
  };
}

function connection(value: unknown, label: string, itemIds: Set<string>): Connection {
  const record = object(value, label);
  if (record.shape !== "rect" && record.shape !== "round") {
    throw new Error(`Invalid project: ${label}.shape is unsupported`);
  }
  const a = connectionEndpoint(record.a, `${label}.a`);
  const b = connectionEndpoint(record.b, `${label}.b`);
  if (!itemIds.has(a.itemId) || !itemIds.has(b.itemId)) {
    throw new Error(`Invalid project: ${label} references a missing item`);
  }
  return {
    id: text(record.id, `${label}.id`),
    name: text(record.name, `${label}.name`).slice(0, 240),
    a,
    b,
    shape: record.shape,
    width: finite(record.width, `${label}.width`),
    height: finite(record.height, `${label}.height`),
    clearance: finite(record.clearance, `${label}.clearance`),
  };
}

function params(value: unknown): EnclosureParams {
  const record = object(value, "params");
  const snapPlacement = record.snapPlacement;
  const validPlacements = ["both-y", "both-x", "+x", "-x", "+y", "-y"];
  if (typeof snapPlacement !== "string" || !validPlacements.includes(snapPlacement)) {
    throw new Error("Invalid project: params.snapPlacement is unsupported");
  }
  if (typeof record.snapFit !== "boolean") throw new Error("Invalid project: params.snapFit must be boolean");
  return {
    wall: finite(record.wall, "params.wall"),
    floor: finite(record.floor, "params.floor"),
    clearance: finite(record.clearance, "params.clearance"),
    fillet: finite(record.fillet, "params.fillet"),
    lidFrac: finite(record.lidFrac, "params.lidFrac"),
    lipDepth: finite(record.lipDepth, "params.lipDepth"),
    lipTol: finite(record.lipTol, "params.lipTol"),
    snapFit: record.snapFit,
    snapSize: finite(record.snapSize, "params.snapSize"),
    snapPlacement: snapPlacement as EnclosureParams["snapPlacement"],
  };
}

export function decodeProject(data: Uint8Array): ProjectSnapshot {
  if (data.byteLength > MAX_PROJECT_FILE_BYTES) throw new Error("Project file is larger than 256 MB");
  let files: Record<string, Uint8Array>;
  let uncompressedBytes = 0;
  let archiveTooLarge = false;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        uncompressedBytes += file.originalSize;
        archiveTooLarge ||= file.originalSize > MAX_BUFFER_BYTES
          || uncompressedBytes > MAX_PROJECT_UNCOMPRESSED_BYTES;
        return !archiveTooLarge;
      },
    });
  } catch {
    if (archiveTooLarge) throw new Error("Project archive expands beyond the supported size");
    throw new Error("This is not a readable .dropfit project");
  }
  if (archiveTooLarge) throw new Error("Project archive expands beyond the supported size");
  const rawManifest = files[MANIFEST_PATH];
  if (!rawManifest) throw new Error("Invalid project: project.json is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(rawManifest));
  } catch {
    throw new Error("Invalid project: project.json is malformed");
  }
  const manifest = object(parsed, "project.json");
  if (manifest.format !== PROJECT_FORMAT) throw new Error("Unsupported project format");
  if (manifest.version !== PROJECT_VERSION) {
    throw new Error(`Unsupported project version: ${String(manifest.version)}`);
  }
  if (!Array.isArray(manifest.items)) throw new Error("Invalid project: items must be an array");
  if (!Array.isArray(manifest.cutouts) || !Array.isArray(manifest.connections)) {
    throw new Error("Invalid project: cutouts and connections must be arrays");
  }

  const items: Item[] = manifest.items.map((rawItem, index) => {
    const label = `items[${index}]`;
    const record = object(rawItem, label);
    const base = itemBase(record, label);
    if (record.kind === "primitive") {
      return { ...base, kind: "primitive", primitive: primitive(record.primitive, `${label}.primitive`) };
    }
    if (record.kind === "import") {
      const meshRecord = object(record.mesh, `${label}.mesh`);
      const mesh = meshData(files, meshRecord, `${label}.mesh`);
      if (!Array.isArray(meshRecord.parts)) throw new Error(`Invalid project: ${label}.mesh.parts must be an array`);
      return {
        ...base,
        kind: "import",
        meshVersion: finite(record.meshVersion, `${label}.meshVersion`),
        mesh: {
          ...mesh,
          aabb: aabb(meshRecord.aabb, `${label}.mesh.aabb`),
          parts: meshRecord.parts.map((part, partIndex) =>
            meshData(files, part, `${label}.mesh.parts[${partIndex}]`)),
        },
      };
    }
    throw new Error(`Invalid project: ${label}.kind is unsupported`);
  });

  const itemIds = new Set(items.map((item) => item.id));
  if (itemIds.size !== items.length) throw new Error("Invalid project: item IDs must be unique");
  return {
    name: safeName(text(manifest.name, "name")),
    items,
    params: params(manifest.params ?? defaultParams),
    cutouts: manifest.cutouts.map((entry, index) => cutout(entry, `cutouts[${index}]`)),
    connections: manifest.connections.map((entry, index) =>
      connection(entry, `connections[${index}]`, itemIds)),
  };
}

export async function readProjectFile(file: File): Promise<ProjectSnapshot> {
  if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error("Project file is larger than 256 MB");
  return decodeProject(new Uint8Array(await file.arrayBuffer()));
}
