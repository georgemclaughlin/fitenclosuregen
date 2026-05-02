from __future__ import annotations

from dataclasses import dataclass
from math import cos, pi, sin
from pathlib import Path
from typing import Iterable

from lxml import etree


BRD_PATH = Path("/home/g/Downloads/sparkfun-sam-m10q/Hardware/SparkFun_u-blox_SAM-M10Q.brd")
OUT_DIR = Path("/home/g/Downloads/sparkfun-sam-m10q")


@dataclass
class Box:
    name: str
    x: float
    y: float
    z: float
    sx: float
    sy: float
    sz: float


@dataclass
class Cylinder:
    name: str
    x: float
    y: float
    z: float
    radius: float
    height: float
    segments: int = 48


def package_bounds(root: etree._ElementTree, library: str, package: str) -> tuple[float, float, float, float]:
    pkg = root.xpath(f"//libraries/library[@name='{library}']/packages/package[@name='{package}']")
    if not pkg:
      raise ValueError(f"missing package {library}:{package}")
    pkg = pkg[0]
    xs: list[float] = []
    ys: list[float] = []
    for el in pkg.iter():
        tag = el.tag
        if tag == "wire":
            xs += [float(el.get("x1")), float(el.get("x2"))]
            ys += [float(el.get("y1")), float(el.get("y2"))]
        elif tag in ("smd", "pad", "hole", "circle"):
            x = float(el.get("x"))
            y = float(el.get("y"))
            if tag == "circle":
                r = float(el.get("radius"))
                xs += [x - r, x + r]
                ys += [y - r, y + r]
            elif tag == "hole":
                d = float(el.get("drill"))
                xs += [x - d / 2, x + d / 2]
                ys += [y - d / 2, y + d / 2]
            else:
                dx = float(el.get("dx", el.get("diameter", el.get("drill", "0"))))
                dy = float(el.get("dy", el.get("diameter", el.get("drill", "0"))))
                xs += [x - dx / 2, x + dx / 2]
                ys += [y - dy / 2, y + dy / 2]
        elif tag == "rectangle":
            xs += [float(el.get("x1")), float(el.get("x2"))]
            ys += [float(el.get("y1")), float(el.get("y2"))]
    if not xs or not ys:
        raise ValueError(f"no bounds for {library}:{package}")
    return min(xs), min(ys), max(xs), max(ys)


def board_size(root: etree._ElementTree) -> tuple[float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for wire in root.xpath("//board/plain/wire[@layer='20']"):
        xs += [float(wire.get("x1")), float(wire.get("x2"))]
        ys += [float(wire.get("y1")), float(wire.get("y2"))]
    return max(xs) - min(xs), max(ys) - min(ys)


def element(root: etree._ElementTree, name: str) -> etree._Element:
    found = root.xpath(f"//elements/element[@name='{name}']")
    if not found:
        raise ValueError(f"missing element {name}")
    return found[0]


def box_from_element(root: etree._ElementTree, name: str, height: float, z: float) -> Box:
    el = element(root, name)
    library = el.get("library")
    package = el.get("package")
    min_x, min_y, max_x, max_y = package_bounds(root, library, package)
    return Box(
        name=name,
        x=float(el.get("x")),
        y=float(el.get("y")),
        z=z,
        sx=max_x - min_x,
        sy=max_y - min_y,
        sz=height,
    )


def cylinder_from_element(root: etree._ElementTree, name: str, radius: float, height: float, z: float) -> Cylinder:
    el = element(root, name)
    return Cylinder(name=name, x=float(el.get("x")), y=float(el.get("y")), z=z, radius=radius, height=height)


def cube_vertices(box: Box) -> list[tuple[float, float, float]]:
    hx, hy, hz = box.sx / 2, box.sy / 2, box.sz / 2
    cx, cy, cz = box.x, box.y, box.z + hz
    return [
        (cx - hx, cy - hy, cz - hz),
        (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz),
        (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz),
        (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz),
        (cx - hx, cy + hy, cz + hz),
    ]


def cube_faces(offset: int) -> list[tuple[int, int, int]]:
    return [
        (offset + 1, offset + 2, offset + 3), (offset + 1, offset + 3, offset + 4),
        (offset + 5, offset + 8, offset + 7), (offset + 5, offset + 7, offset + 6),
        (offset + 1, offset + 5, offset + 6), (offset + 1, offset + 6, offset + 2),
        (offset + 2, offset + 6, offset + 7), (offset + 2, offset + 7, offset + 3),
        (offset + 3, offset + 7, offset + 8), (offset + 3, offset + 8, offset + 4),
        (offset + 4, offset + 8, offset + 5), (offset + 4, offset + 5, offset + 1),
    ]


def cylinder_mesh(cyl: Cylinder, offset: int) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    top_z = cyl.z + cyl.height
    verts.append((cyl.x, cyl.y, cyl.z))
    verts.append((cyl.x, cyl.y, top_z))
    for i in range(cyl.segments):
        a = (i / cyl.segments) * 2 * pi
        px = cyl.x + cyl.radius * cos(a)
        py = cyl.y + cyl.radius * sin(a)
        verts.append((px, py, cyl.z))
        verts.append((px, py, top_z))
    for i in range(cyl.segments):
        ni = (i + 1) % cyl.segments
        b0 = offset + 3 + i * 2
        t0 = b0 + 1
        b1 = offset + 3 + ni * 2
        t1 = b1 + 1
        faces.append((offset + 1, b1, b0))
        faces.append((offset + 2, t0, t1))
        faces.append((b0, b1, t1))
        faces.append((b0, t1, t0))
    return verts, faces


def write_obj(boxes: Iterable[Box], cylinders: Iterable[Cylinder], path: Path) -> None:
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    for box in boxes:
        offset = len(verts)
        verts.extend(cube_vertices(box))
        faces.extend(cube_faces(offset))
    for cyl in cylinders:
        offset = len(verts)
        cverts, cfaces = cylinder_mesh(cyl, offset)
        verts.extend(cverts)
        faces.extend(cfaces)
    with path.open("w", encoding="ascii") as f:
        f.write("# Simplified SparkFun GPS-21834 model\n")
        for x, y, z in verts:
            f.write(f"v {x:.5f} {y:.5f} {z:.5f}\n")
        for a, b, c in faces:
            f.write(f"f {a} {b} {c}\n")


def facet_normal(a: tuple[float, float, float], b: tuple[float, float, float], c: tuple[float, float, float]) -> tuple[float, float, float]:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    mag = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
    return nx / mag, ny / mag, nz / mag


def write_stl(boxes: Iterable[Box], cylinders: Iterable[Cylinder], path: Path) -> None:
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    for box in boxes:
        offset = len(verts)
        verts.extend(cube_vertices(box))
        faces.extend(cube_faces(offset))
    for cyl in cylinders:
        offset = len(verts)
        cverts, cfaces = cylinder_mesh(cyl, offset)
        verts.extend(cverts)
        faces.extend(cfaces)
    with path.open("w", encoding="ascii") as f:
        f.write("solid sparkfun_sam_m10q_simplified\n")
        for a, b, c in faces:
            va, vb, vc = verts[a - 1], verts[b - 1], verts[c - 1]
            nx, ny, nz = facet_normal(va, vb, vc)
            f.write(f"  facet normal {nx:.6f} {ny:.6f} {nz:.6f}\n")
            f.write("    outer loop\n")
            f.write(f"      vertex {va[0]:.6f} {va[1]:.6f} {va[2]:.6f}\n")
            f.write(f"      vertex {vb[0]:.6f} {vb[1]:.6f} {vb[2]:.6f}\n")
            f.write(f"      vertex {vc[0]:.6f} {vc[1]:.6f} {vc[2]:.6f}\n")
            f.write("    endloop\n")
            f.write("  endfacet\n")
        f.write("endsolid sparkfun_sam_m10q_simplified\n")


def main() -> None:
    root = etree.parse(str(BRD_PATH))
    board_x, board_y = board_size(root)
    board_thickness = 1.6
    boxes = [
        Box("board", board_x / 2, board_y / 2, 0.0, board_x, board_y, board_thickness),
        box_from_element(root, "U1", height=7.6, z=board_thickness),
        box_from_element(root, "J1", height=3.8, z=board_thickness),
        box_from_element(root, "J2", height=3.8, z=board_thickness),
        box_from_element(root, "BT1", height=2.1, z=board_thickness),
    ]
    cylinders = [
        cylinder_from_element(root, "H1", radius=1.45, height=board_thickness, z=0.0),
        cylinder_from_element(root, "H2", radius=1.45, height=board_thickness, z=0.0),
        cylinder_from_element(root, "H3", radius=1.45, height=board_thickness, z=0.0),
        cylinder_from_element(root, "H4", radius=1.45, height=board_thickness, z=0.0),
    ]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    obj_path = OUT_DIR / "SparkFun_u-blox_SAM-M10Q_simplified.obj"
    stl_path = OUT_DIR / "SparkFun_u-blox_SAM-M10Q_simplified.stl"
    write_obj(boxes, cylinders, obj_path)
    write_stl(boxes, cylinders, stl_path)
    print(obj_path)
    print(stl_path)


if __name__ == "__main__":
    main()
