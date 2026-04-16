import { useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, Grid } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../state/store";
import type { Item, MeshData, Primitive } from "../cad/types";

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

function ShellMesh({ data, color, opacity, visible }: {
  data: MeshData; color: string; opacity: number; visible: boolean;
}) {
  const geom = useMemo(() => meshGeometry(data), [data]);
  if (!visible) return null;
  return (
    <mesh geometry={geom} castShadow receiveShadow>
      <meshStandardMaterial color={color} transparent opacity={opacity} roughness={0.7} metalness={0.05} />
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

function ItemMesh({ item }: { item: Item }) {
  const visible = useStore((s) => s.showComponent);
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
  return (
    <group position={item.position} rotation={itemRot}>
      <mesh geometry={geomData.geom} rotation={geomData.rotation}>
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
    </group>
  );
}

function Items() {
  const items = useStore((s) => s.items);
  return <>{items.map((it) => <ItemMesh key={it.id} item={it} />)}</>;
}

function Generated() {
  const result = useStore((s) => s.result);
  const showBase = useStore((s) => s.showBase);
  const showLid = useStore((s) => s.showLid);
  const opacity = useStore((s) => s.shellOpacity);
  if (!result) return null;
  return (
    <>
      <ShellMesh data={result.base} color="#d2a15a" opacity={opacity} visible={showBase} />
      <ShellMesh data={result.lid} color="#9ed07c" opacity={opacity} visible={showLid} />
    </>
  );
}

export function Viewer() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} style={{ width: "100%", height: "100%" }}>
      <Canvas camera={{ position: [80, -80, 80], fov: 45, near: 0.1, far: 5000, up: [0, 0, 1] }} shadows>
        <ambientLight intensity={0.5} />
        <directionalLight position={[100, 100, 150]} intensity={0.9} castShadow />
        <directionalLight position={[-80, 60, 40]} intensity={0.3} />
        <Grid
          args={[500, 500]}
          cellSize={5}
          sectionSize={25}
          fadeDistance={400}
          infiniteGrid
          rotation={[Math.PI / 2, 0, 0]}
        />
        <Items />
        <Generated />
        <OrbitControls makeDefault />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={["#ff5555", "#55ff55", "#5599ff"]} labelColor="white" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}
