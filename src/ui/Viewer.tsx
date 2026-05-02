import { useMemo, useRef, useState } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, Grid } from "@react-three/drei";
import * as THREE from "three";
import { useStore, type ConnectionPickPoint } from "../state/store";
import { primitiveAabb } from "../cad/presets";
import { faceFrame } from "../cad/shell";
import type { AABB, Connection, ConnectionEndpoint, DebugMeshKey, FaceAxis, Item, MeshData, Primitive, Vec3 } from "../cad/types";

// Match the CAD frame: +Z is up, XY is the floor plane. Must be set before
// any Object3D (including cameras) is created.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

function meshGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  return g;
}

function ShellMesh({ data, color, edgeColor, opacity, edgesVisible, visible }: {
  data: MeshData; color: string; edgeColor: string; opacity: number; edgesVisible: boolean; visible: boolean;
}) {
  const geom = useMemo(() => meshGeometry(data), [data]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geom, 28), [geom]);
  const edgeOpacity = Math.max(0.08, Math.min(0.42, opacity * 0.48));
  if (!visible) return null;
  return (
    <mesh geometry={geom} castShadow receiveShadow>
      <meshStandardMaterial
        color={color}
        transparent
        opacity={opacity}
        roughness={0.82}
        metalness={0.02}
        depthWrite={false}
      />
      {edgesVisible && (
        <lineSegments geometry={edges} renderOrder={2}>
          <lineBasicMaterial color={edgeColor} transparent opacity={edgeOpacity} depthTest={false} />
        </lineSegments>
      )}
    </mesh>
  );
}

const DEBUG_COLORS: Record<DebugMeshKey, string> = {
  fit: "#ff4f8b",
  access: "#ffd24a",
  relief: "#ff8c42",
  cutout: "#54d6ff",
  connection: "#9dff6a",
};

function DebugMeshView({ data, kind, visible }: {
  data: MeshData;
  kind: DebugMeshKey;
  visible: boolean;
}) {
  const geom = useMemo(() => meshGeometry(data), [data]);
  if (!visible) return null;
  return (
    <mesh geometry={geom}>
      <meshStandardMaterial
        color={DEBUG_COLORS[kind]}
        emissive={DEBUG_COLORS[kind]}
        emissiveIntensity={0.15}
        transparent
        opacity={0.26}
        depthWrite={false}
      />
    </mesh>
  );
}

function primitiveMesh(p: Primitive): { geom: THREE.BufferGeometry; rotation: [number, number, number] } {
  if (p.kind === "box") {
    const g = new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
    return { geom: g, rotation: [0, 0, 0] };
  }
  const g = new THREE.CylinderGeometry(p.radius, p.radius, p.height, 48);
  // three's CylinderGeometry is Y-axis by default; rotate onto requested axis.
  const rot: [number, number, number] = p.axis === "x" ? [0, 0, Math.PI / 2]
    : p.axis === "z" ? [Math.PI / 2, 0, 0]
    : [0, 0, 0];
  return { geom: g, rotation: rot };
}

function itemLocalAabb(item: Item): AABB {
  return item.kind === "import" ? item.mesh.aabb : primitiveAabb(item.primitive);
}

function nearestAabbFace(p: Vec3, aabb: AABB): FaceAxis {
  const candidates: Array<{ face: FaceAxis; d: number }> = [
    { face: "-x", d: Math.abs(p[0] - aabb.min[0]) },
    { face: "+x", d: Math.abs(p[0] - aabb.max[0]) },
    { face: "-y", d: Math.abs(p[1] - aabb.min[1]) },
    { face: "+y", d: Math.abs(p[1] - aabb.max[1]) },
    { face: "-z", d: Math.abs(p[2] - aabb.min[2]) },
    { face: "+z", d: Math.abs(p[2] - aabb.max[2]) },
  ];
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0].face;
}

function faceFromNormal(normal: Vec3): FaceAxis {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  if (ax >= ay && ax >= az) return normal[0] >= 0 ? "+x" : "-x";
  if (ay >= ax && ay >= az) return normal[1] >= 0 ? "+y" : "-y";
  return normal[2] >= 0 ? "+z" : "-z";
}

function localPointForItem(item: Item, worldPoint: THREE.Vector3): Vec3 {
  const deg = Math.PI / 180;
  const euler = new THREE.Euler(
    item.rotation[0] * deg,
    item.rotation[1] * deg,
    item.rotation[2] * deg,
    "XYZ",
  );
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...item.position),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(1, 1, 1),
  );
  const local = worldPoint.clone().applyMatrix4(matrix.invert());
  return [local.x, local.y, local.z];
}

function localNormalForItem(item: Item, event: ThreeEvent<PointerEvent | MouseEvent>): Vec3 | null {
  if (!event.face) return null;
  const worldNormal = event.face.normal.clone().transformDirection(event.object.matrixWorld);
  const localNormal = worldNormal.transformDirection(itemWorldMatrix(item).invert()).normalize();
  return [localNormal.x, localNormal.y, localNormal.z];
}

function itemWorldMatrix(item: Item): THREE.Matrix4 {
  const deg = Math.PI / 180;
  const euler = new THREE.Euler(
    item.rotation[0] * deg,
    item.rotation[1] * deg,
    item.rotation[2] * deg,
    "XYZ",
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...item.position),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(1, 1, 1),
  );
}

function endpointWorldPoint(endpoint: ConnectionEndpoint, item: Item): Vec3 {
  const aabb = itemLocalAabb(item);
  const frame = faceFrame(endpoint.face, aabb);
  const local: Vec3 = [0, 0, 0];
  local[frame.nAxis] = frame.plane;
  local[frame.uAxis] = frame.uMin + endpoint.u;
  local[frame.vAxis] = frame.vMin + endpoint.v;
  const world = new THREE.Vector3(...local).applyMatrix4(itemWorldMatrix(item));
  return [world.x, world.y, world.z];
}

function endpointWorldEscape(endpoint: ConnectionEndpoint, connection: Connection, item: Item): Vec3 {
  const aabb = itemLocalAabb(item);
  const frame = faceFrame(endpoint.face, aabb);
  const normal: Vec3 = [0, 0, 0];
  normal[frame.nAxis] = frame.outward;
  const matrix = itemWorldMatrix(item);
  const worldNormal = new THREE.Vector3(...normal).transformDirection(matrix);
  const surface = endpointWorldPoint(endpoint, item);
  if (Math.abs(worldNormal.z) > 0.8) return surface;
  return [
    surface[0] + worldNormal.x * (routeRadius(connection) + 0.75),
    surface[1] + worldNormal.y * (routeRadius(connection) + 0.75),
    surface[2] + worldNormal.z * (routeRadius(connection) + 0.75),
  ];
}

function itemWorldAabb(item: Item): AABB {
  const local = itemLocalAabb(item);
  const matrix = itemWorldMatrix(item);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        const p = new THREE.Vector3(x, y, z).applyMatrix4(matrix);
        min[0] = Math.min(min[0], p.x);
        min[1] = Math.min(min[1], p.y);
        min[2] = Math.min(min[2], p.z);
        max[0] = Math.max(max[0], p.x);
        max[1] = Math.max(max[1], p.y);
        max[2] = Math.max(max[2], p.z);
      }
    }
  }
  return { min, max };
}

function expandAabb(box: AABB, amount: number): AABB {
  return {
    min: [box.min[0] - amount, box.min[1] - amount, box.min[2] - amount],
    max: [box.max[0] + amount, box.max[1] + amount, box.max[2] + amount],
  };
}

function routeRadius(connection: Connection): number {
  const core = connection.shape === "round"
    ? connection.width / 2
    : Math.max(connection.width, connection.height) / 2;
  return Math.max(0, core + connection.clearance);
}

function segmentHitsAabb(a: Vec3, b: Vec3, box: AABB): boolean {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  let tMin = 0;
  let tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-8) {
      if (a[axis] < box.min[axis] || a[axis] > box.max[axis]) return false;
      continue;
    }
    const inv = 1 / d[axis];
    let t0 = (box.min[axis] - a[axis]) * inv;
    let t1 = (box.max[axis] - a[axis]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) return false;
  }
  const nearStart = tMin <= 1e-4 && tMax <= 0.2;
  const nearEnd = tMax >= 1 - 1e-4 && tMin >= 0.8;
  return !nearStart && !nearEnd;
}

function pathClear(points: Vec3[], obstacles: AABB[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (obstacles.some((obstacle) => segmentHitsAabb(points[i], points[i + 1], obstacle))) return false;
  }
  return true;
}

function pointInAabb(p: Vec3, bounds: AABB): boolean {
  return p[0] >= bounds.min[0] && p[0] <= bounds.max[0]
    && p[1] >= bounds.min[1] && p[1] <= bounds.max[1]
    && p[2] >= bounds.min[2] && p[2] <= bounds.max[2];
}

function pathInsideBounds(points: Vec3[], bounds: AABB | null): boolean {
  return !bounds || points.every((p) => pointInAabb(p, bounds));
}

function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): { point: Vec3; t: number; distance: number } {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const lenSq = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const rawT = lenSq <= 1e-9 ? 0 : (
    ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / lenSq
  );
  const t = Math.max(0, Math.min(1, rawT));
  const point: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return { point, t, distance: Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]) };
}

function closestPointOnRoute(p: Vec3, route: Vec3[]): { point: Vec3; segment: number; t: number; distance: number } | null {
  let best: { point: Vec3; segment: number; t: number; distance: number } | null = null;
  for (let i = 0; i < route.length - 1; i++) {
    const hit = closestPointOnSegment(p, route[i], route[i + 1]);
    if (!best || hit.distance < best.distance) best = { ...hit, segment: i };
  }
  return best;
}

function subRoute(route: Vec3[], from: { point: Vec3; segment: number }, to: { point: Vec3; segment: number }): Vec3[] {
  if (from.segment === to.segment) return [from.point, to.point];
  const out: Vec3[] = [from.point];
  for (let i = from.segment + 1; i <= to.segment; i++) out.push(route[i]);
  out.push(to.point);
  return out;
}

function sharedRouteCandidates(a: Vec3, b: Vec3, priorRoutes: Vec3[][], maxJoin: number): Vec3[][] {
  const out: Vec3[][] = [];
  for (const route of priorRoutes) {
    const start = closestPointOnRoute(a, route);
    const end = closestPointOnRoute(b, route);
    if (!start || !end || start.distance > maxJoin || end.distance > maxJoin) continue;
    if (start.segment < end.segment || (start.segment === end.segment && start.t <= end.t)) {
      out.push([a, ...subRoute(route, start, end), b]);
    } else {
      const reversed = [...route].reverse();
      const revStart = closestPointOnRoute(a, reversed);
      const revEnd = closestPointOnRoute(b, reversed);
      if (revStart && revEnd) out.push([a, ...subRoute(reversed, revStart, revEnd), b]);
    }
  }
  return out;
}

function planarizeRoute(a: Vec3, b: Vec3): Vec3[] {
  const routeZ = Math.max(a[2], b[2]);
  const start: Vec3 = [a[0], a[1], routeZ];
  const end: Vec3 = [b[0], b[1], routeZ];
  const out: Vec3[] = [];
  if (Math.abs(a[2] - routeZ) > 1e-6) out.push(a);
  out.push(start);
  if (Math.abs(start[0] - end[0]) > 1e-6 || Math.abs(start[1] - end[1]) > 1e-6) out.push(end);
  if (Math.abs(b[2] - routeZ) > 1e-6) out.push(b);
  return out;
}

function routeLength(points: Vec3[]): number {
  let out = 0;
  for (let i = 0; i < points.length - 1; i++) {
    out += Math.hypot(
      points[i + 1][0] - points[i][0],
      points[i + 1][1] - points[i][1],
      points[i + 1][2] - points[i][2],
    );
  }
  return out;
}

function routeCost(points: Vec3[], floorZ: number): number {
  let cost = routeLength(points);
  let minZ = Infinity;
  let zTravel = 0;
  for (let i = 0; i < points.length; i++) {
    minZ = Math.min(minZ, points[i][2]);
    if (i > 0) zTravel += Math.abs(points[i][2] - points[i - 1][2]);
  }
  if (minZ < floorZ) cost += (floorZ - minZ) * 1000;
  cost += zTravel * 50;
  return cost;
}

function virtualConnectionRoute(
  connection: Connection,
  a: Vec3,
  b: Vec3,
  obstacles: AABB[],
  preferredBounds: AABB | null,
  priorRoutes: Vec3[][] = [],
): Vec3[] {
  const planar = planarizeRoute(a, b);
  const floorZ = Math.min(a[2], b[2]);
  const shared = sharedRouteCandidates(a, b, priorRoutes, Math.max(8, routeRadius(connection) * 4))
    .filter((candidate) => pathClear(candidate, obstacles) && pathInsideBounds(candidate, preferredBounds));
  const directCandidates = [planar, [a, b]]
    .filter((candidate) => pathClear(candidate, obstacles) && pathInsideBounds(candidate, preferredBounds));
  const baseline = directCandidates[0] ?? null;
  const baselineLen = baseline ? routeLength(baseline) : Infinity;
  let bestShared: Vec3[] | null = null;
  let bestSharedLen = Infinity;
  for (const candidate of shared) {
    const len = routeCost(candidate, floorZ);
    if (len < bestSharedLen) {
      bestShared = candidate;
      bestSharedLen = len;
    }
  }
  if (bestShared && bestSharedLen <= baselineLen * 1.35 + 12) return bestShared;
  if (baseline) return baseline;
  const margin = Math.max(1, routeRadius(connection) + 0.75);
  const candidates: Vec3[][] = [];
  for (const axis of [0, 1]) {
    const coords = new Set<number>();
    for (const obstacle of obstacles) {
      coords.add(obstacle.min[axis] - margin);
      coords.add(obstacle.max[axis] + margin);
    }
    for (const coord of coords) {
      const p1: Vec3 = [...a];
      const p2: Vec3 = [...b];
      p1[axis] = coord;
      p2[axis] = coord;
      const candidate = [a, p1, p2, b];
      candidates.push(candidate);
    }
  }
  const internal = preferredBounds
    ? candidates.filter((candidate) => pathInsideBounds(candidate, preferredBounds))
    : candidates;
  let best: Vec3[] | null = null;
  let bestLen = Infinity;
  for (const candidate of internal) {
    if (!pathClear(candidate, obstacles)) continue;
    const len = routeCost(candidate, floorZ);
    if (len < bestLen) {
      best = candidate;
      bestLen = len;
    }
  }
  if (best) return best;
  for (const candidate of candidates) {
      if (!pathClear(candidate, obstacles)) continue;
      const len = routeCost(candidate, floorZ);
      if (len < bestLen) {
        best = candidate;
        bestLen = len;
      }
  }
  if (best) return best;

  const zCandidates: Vec3[][] = [];
  for (const obstacle of obstacles) {
    for (const coord of [obstacle.min[2] - margin, obstacle.max[2] + margin]) {
      const p1: Vec3 = [...a];
      const p2: Vec3 = [...b];
      p1[2] = coord;
      p2[2] = coord;
      zCandidates.push([a, p1, p2, b]);
    }
  }
  for (const candidate of zCandidates) {
    if (!pathClear(candidate, obstacles)) continue;
    const len = routeCost(candidate, floorZ);
    if (len < bestLen) {
      best = candidate;
      bestLen = len;
    }
  }
  return best ?? [a, b];
}

function endpointFromHit(item: Item, event: ThreeEvent<PointerEvent | MouseEvent>): ConnectionPickPoint {
  const worldPoint = event.point;
  const local = localPointForItem(item, worldPoint);
  const aabb = itemLocalAabb(item);
  const normal = localNormalForItem(item, event);
  const face = normal ? faceFromNormal(normal) : nearestAabbFace(local, aabb);
  const frame = faceFrame(face, aabb);
  const endpoint: ConnectionEndpoint = {
    itemId: item.id,
    face,
    u: local[frame.uAxis] - frame.uMin,
    v: local[frame.vAxis] - frame.vMin,
    depth: 2,
  };
  return {
    endpoint,
    point: [worldPoint.x, worldPoint.y, worldPoint.z],
    itemName: item.name,
  };
}

function ItemMesh({ item, onPickHover }: {
  item: Item;
  onPickHover: (hit: ConnectionPickPoint | null) => void;
}) {
  const visible = useStore((s) => s.showComponent);
  const connectionPick = useStore((s) => s.connectionPick);
  const addConnection = useStore((s) => s.addConnection);
  const setConnectionPickFirst = useStore((s) => s.setConnectionPickFirst);
  const cancelConnectionPick = useStore((s) => s.cancelConnectionPick);
  const geomData = useMemo(() => {
    if (item.kind === "import") {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(item.mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(item.mesh.indices, 1));
      g.computeVertexNormals();
      return { geom: g, rotation: [0, 0, 0] as [number, number, number] };
    }
    return primitiveMesh(item.primitive);
  }, [item]);
  if (!visible) return null;
  const color = item.kind === "import" ? "#4a8fe0" : "#c77";
  const deg = Math.PI / 180;
  const itemRot: [number, number, number] = [
    item.rotation[0] * deg,
    item.rotation[1] * deg,
    item.rotation[2] * deg,
  ];
  const pickHit = (event: ThreeEvent<PointerEvent | MouseEvent>) => endpointFromHit(item, event);
  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!connectionPick.active) return;
    onPickHover(pickHit(event));
  };
  const handlePointerOut = () => {
    if (connectionPick.active) onPickHover(null);
  };
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!connectionPick.active) return;
    if (event.nativeEvent.button !== 0) return;
    event.stopPropagation();
    const hit = pickHit(event);
    if (!connectionPick.first) {
      setConnectionPickFirst(hit);
      return;
    }
    addConnection({
      id: crypto.randomUUID(),
      name: "Connection",
      a: connectionPick.first.endpoint,
      b: hit.endpoint,
      shape: "rect",
      width: 4,
      height: 3,
      clearance: 1.5,
    });
    cancelConnectionPick();
    onPickHover(null);
  };
  return (
    <group position={item.position} rotation={itemRot}>
      <mesh
        geometry={geomData.geom}
        rotation={geomData.rotation}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      >
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
    </group>
  );
}

function Items({ onPickHover }: { onPickHover: (hit: ConnectionPickPoint | null) => void }) {
  const items = useStore((s) => s.items);
  return <>{items.map((it) => <ItemMesh key={it.id} item={it} onPickHover={onPickHover} />)}</>;
}

function Generated() {
  const result = useStore((s) => s.result);
  const showBase = useStore((s) => s.showBase);
  const showLid = useStore((s) => s.showLid);
  const showDebug = useStore((s) => s.showDebug);
  const debugVisibility = useStore((s) => s.debugVisibility);
  const opacity = useStore((s) => s.shellOpacity);
  const showShellEdges = useStore((s) => s.showShellEdges);
  if (!result) return null;
  return (
    <>
      <ShellMesh data={result.base} color="#b66d24" edgeColor="#ffc36b" opacity={opacity} edgesVisible={showShellEdges} visible={showBase} />
      <ShellMesh data={result.lid} color="#82bd56" edgeColor="#d3ff9b" opacity={opacity} edgesVisible={showShellEdges} visible={showLid} />
      {showDebug && result.debug?.map((entry) => (
        <DebugMeshView
          key={entry.key}
          data={entry.mesh}
          kind={entry.key}
          visible={debugVisibility[entry.key]}
        />
      ))}
    </>
  );
}

function Marker({ point, color, scale = 1 }: { point: Vec3; color: string; scale?: number }) {
  return (
    <group position={point}>
      <mesh>
        <sphereGeometry args={[1.4 * scale, 24, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} depthTest={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.4 * scale, 0.12 * scale, 10, 48]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} depthTest={false} />
      </mesh>
    </group>
  );
}

function PickIndicators({ hover }: { hover: ConnectionPickPoint | null }) {
  const first = useStore((s) => s.connectionPick.first);
  return (
    <>
      {first && <Marker point={first.point} color="#2aff6a" scale={1.1} />}
      {hover && <Marker point={hover.point} color="#ffe45a" />}
      {first && hover && (
        <line>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[new Float32Array([...first.point, ...hover.point]), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#9dff6a" transparent opacity={0.85} depthTest={false} />
        </line>
      )}
    </>
  );
}

function ConnectionPolyline({ points }: { points: Vec3[] }) {
  const positions = useMemo(() => new Float32Array(points.flat()), [points]);
  return (
    <line>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color="#9dff6a" transparent opacity={0.95} depthTest={false} />
    </line>
  );
}

function VirtualConnections() {
  const items = useStore((s) => s.items);
  const connections = useStore((s) => s.connections);
  const visible = useStore((s) => s.showConnections);
  const result = useStore((s) => s.result);
  const params = useStore((s) => s.params);
  const routes = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    const preferredBounds: AABB | null = result ? {
      min: [
        result.outer.min[0] + params.wall,
        result.outer.min[1] + params.wall,
        result.outer.min[2] + params.floor,
      ],
      max: [
        result.outer.max[0] - params.wall,
        result.outer.max[1] - params.wall,
        result.outer.max[2] - params.wall,
      ],
    } : null;
    const plannedRoutes: Array<{ id: string; points: Vec3[] }> = [];
    for (const connection of connections) {
      const aItem = byId.get(connection.a.itemId);
      const bItem = byId.get(connection.b.itemId);
      if (!aItem || !bItem) continue;
      const a = endpointWorldPoint(connection.a, aItem);
      const b = endpointWorldPoint(connection.b, bItem);
      const aEscape = endpointWorldEscape(connection.a, connection, aItem);
      const bEscape = endpointWorldEscape(connection.b, connection, bItem);
      const radius = routeRadius(connection);
      const obstacles = items
        .filter((item) =>
          !(item.id === aItem.id && connection.a.face === "+z") &&
          !(item.id === bItem.id && connection.b.face === "+z")
        )
        .map((item) => expandAabb(itemWorldAabb(item), radius));
      const coreRoute = virtualConnectionRoute(
        connection,
        aEscape,
        bEscape,
        obstacles,
        preferredBounds,
        plannedRoutes.map((route) => route.points),
      );
      plannedRoutes.push({ id: connection.id, points: [a, ...coreRoute, b] });
    }
    return plannedRoutes;
  }, [connections, items, params.floor, params.wall, result]);
  if (!visible) return null;
  return (
    <>
      {routes.map((route) => (
        <group key={route.id}>
          <ConnectionPolyline points={route.points} />
          <Marker point={route.points[0]} color="#2aff6a" scale={0.8} />
          <Marker point={route.points[route.points.length - 1]} color="#2aff6a" scale={0.8} />
        </group>
      ))}
    </>
  );
}

export function Viewer() {
  const ref = useRef<HTMLDivElement>(null);
  const [hoverPick, setHoverPick] = useState<ConnectionPickPoint | null>(null);
  const connectionPickActive = useStore((s) => s.connectionPick.active);
  const importing = useStore((s) => s.importing);
  const importLabel = useStore((s) => s.importLabel);
  const generating = useStore((s) => s.generating);
  const error = useStore((s) => s.error);
  const showGrid = useStore((s) => s.showGrid);
  const gridZ = useStore((s) => s.result ? s.result.outer.min[2] - 0.2 : 0);
  const busyLabel = importing ? (importLabel ?? "Loading model") : generating ? "Generating enclosure" : null;
  return (
    <div ref={ref} style={{ width: "100%", height: "100%", cursor: connectionPickActive ? "crosshair" : "default", position: "relative", touchAction: "none" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {busyLabel && (
        <div style={busyOverlayStyle}>
          <div style={spinnerStyle} />
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontWeight: 700 }}>{busyLabel}…</div>
            <div style={{ fontSize: 12, color: "#b9c3ca" }}>
              Large STEP/STL files can take a few seconds.
            </div>
          </div>
        </div>
      )}
      {error && !busyLabel && (
        <div style={{ ...busyOverlayStyle, borderColor: "#8b3333", color: "#ffcaca" }}>
          Error: {error}
        </div>
      )}
      {connectionPickActive && (
        <div style={{
          position: "absolute",
          left: 16,
          top: 16,
          zIndex: 2,
          padding: "8px 10px",
          borderRadius: 6,
          background: "rgba(10, 24, 14, 0.86)",
          border: "1px solid #2a6",
          color: "#dcffdc",
          fontSize: 12,
          pointerEvents: "none",
        }}>
          {hoverPick ? `Click ${hoverPick.itemName} ${hoverPick.endpoint.face}` : "Hover a model surface"}
        </div>
      )}
      <Canvas
        camera={{ position: [80, -80, 80], fov: 45, near: 0.1, far: 5000, up: [0, 0, 1] }}
        shadows="soft"
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.08 }}
      >
        <color attach="background" args={["#0b0d10"]} />
        <ambientLight intensity={0.28} />
        <hemisphereLight args={["#d7ecff", "#24160d", 0.35]} />
        <directionalLight
          position={[90, -120, 170]}
          intensity={1.45}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-near={1}
          shadow-camera-far={500}
          shadow-camera-left={-120}
          shadow-camera-right={120}
          shadow-camera-top={120}
          shadow-camera-bottom={-120}
        />
        <directionalLight position={[-100, 80, 50]} intensity={0.22} />
        {showGrid && (
          <Grid
            args={[500, 500]}
            cellSize={5}
            sectionSize={25}
            fadeDistance={400}
            infiniteGrid
            position={[0, 0, gridZ]}
            rotation={[Math.PI / 2, 0, 0]}
          />
        )}
        <Items onPickHover={setHoverPick} />
        <Generated />
        <VirtualConnections />
        <PickIndicators hover={hoverPick} />
        <OrbitControls makeDefault />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={["#ff5555", "#55ff55", "#5599ff"]} labelColor="white" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}

const busyOverlayStyle: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: 18,
  transform: "translateX(-50%)",
  zIndex: 4,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderRadius: 10,
  background: "rgba(9, 13, 16, 0.9)",
  border: "1px solid rgba(255, 195, 107, 0.45)",
  color: "#f1efe8",
  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
  pointerEvents: "none",
};

const spinnerStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  border: "2px solid rgba(255,255,255,0.25)",
  borderTopColor: "#ffc36b",
  animation: "spin 0.8s linear infinite",
};
