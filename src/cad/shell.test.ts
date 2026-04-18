import { describe, it, expect } from "vitest";
import { buildEnclosureGeometry, cutoutBox, faceFrame } from "./shell";
import { computeAabb, expandAabb } from "./bbox";
import type { AABB, EnclosureParams } from "./types";

const baseParams: EnclosureParams = {
  wall: 2, floor: 1.6, clearance: 0.5, fillet: 0,
  lidFrac: 0.25, lipDepth: 3, lipTol: 0.2,
  snapFit: false, snapSize: 0.3, snapPlacement: "both-y",
};

const comp: AABB = { min: [0, 0, 0], max: [20, 18, 6] };

describe("buildEnclosureGeometry", () => {
  it("inner wraps component with clearance on all sides", () => {
    const g = buildEnclosureGeometry(comp, baseParams);
    expect(g.inner.min).toEqual([-0.5, -0.5, -0.5]);
    expect(g.inner.max).toEqual([20.5, 18.5, 6.5]);
  });

  it("outer adds wall on sides, floor below, wall above", () => {
    const g = buildEnclosureGeometry(comp, baseParams);
    expect(g.outer.min[0]).toBeCloseTo(-2.5);
    expect(g.outer.min[1]).toBeCloseTo(-2.5);
    expect(g.outer.min[2]).toBeCloseTo(-2.1); // -0.5 - 1.6 floor
    expect(g.outer.max[0]).toBeCloseTo(22.5);
    expect(g.outer.max[2]).toBeCloseTo(8.5);  // 6.5 + 2 wall
  });

  it("splitZ leaves enough lid height for the lip, growing past lidFrac if needed", () => {
    const g = buildEnclosureGeometry(comp, baseParams);
    const lidHeight = g.outer.max[2] - g.splitZ;
    // Must fit tongue (lipDepth) + vertical play (lipTol) + wall above groove.
    expect(lidHeight).toBeGreaterThanOrEqual(baseParams.wall + baseParams.lipDepth + baseParams.lipTol - 1e-9);
  });

  it("splitZ honors lidFrac when the requested lid is already tall enough", () => {
    const tallComp: AABB = { min: [0, 0, 0], max: [20, 18, 60] };
    const g = buildEnclosureGeometry(tallComp, baseParams);
    const outerH = g.outer.max[2] - g.outer.min[2];
    expect(g.splitZ).toBeCloseTo(g.outer.max[2] - 0.25 * outerH);
  });

  it("tongueOuter is larger than tongueInner (valid ring)", () => {
    const g = buildEnclosureGeometry(comp, baseParams);
    expect(g.tongueOuter.max[0]).toBeGreaterThan(g.tongueInner.max[0]);
    expect(g.tongueInner.min[0]).toBeGreaterThan(g.tongueOuter.min[0]);
  });

  it("groove is wider than tongue (fit tolerance on both sides of ring)", () => {
    const g = buildEnclosureGeometry(comp, baseParams);
    // outer face of groove extends further outward than outer face of tongue
    expect(g.grooveOuter.max[0]).toBeGreaterThan(g.tongueOuter.max[0]);
    expect(g.grooveOuter.min[0]).toBeLessThan(g.tongueOuter.min[0]);
    // the groove slot's opening reaches further toward the cavity than the tongue's inner face
    expect(g.grooveInner.max[0]).toBeLessThan(g.tongueInner.max[0]);
    expect(g.grooveInner.min[0]).toBeGreaterThan(g.tongueInner.min[0]);
  });

  it("snap-fit keeps a thicker outer skin on the lid pockets", () => {
    const g = buildEnclosureGeometry(comp, { ...baseParams, snapFit: true });
    expect(g.snapPockets).toBeDefined();
    expect(g.snapPockets).toHaveLength(4);
    const upperPocket = g.snapPockets!.find((p) => p.max[1] > 0)!;
    const lowerPocket = g.snapPockets!.find((p) => p.min[1] < 0)!;
    expect(g.outer.max[1] - upperPocket.max[1]).toBeGreaterThanOrEqual(0.8 - 1e-9);
    expect(lowerPocket.min[1] - g.outer.min[1]).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });

  it("snap-fit groove opens directly to the inner cavity", () => {
    const g = buildEnclosureGeometry(comp, { ...baseParams, snapFit: true });
    expect(g.grooveInner.min[0]).toBeCloseTo(g.inner.min[0]);
    expect(g.grooveInner.max[0]).toBeCloseTo(g.inner.max[0]);
    expect(g.grooveInner.min[1]).toBeCloseTo(g.inner.min[1]);
    expect(g.grooveInner.max[1]).toBeCloseTo(g.inner.max[1]);
  });

  it("snap-fit produces discrete side tabs and matching lid pockets", () => {
    const g = buildEnclosureGeometry(comp, { ...baseParams, snapFit: true });
    expect(g.snapTabs).toBeDefined();
    expect(g.snapPockets).toBeDefined();
    expect(g.snapTabs).toHaveLength(4);
    expect(g.snapPockets).toHaveLength(4);
    const upperTab = g.snapTabs!.find((p) => p.max[1] > 0)!;
    const upperPocket = g.snapPockets!.find((p) => p.max[1] > 0)!;
    expect(upperTab.min[1]).toBeLessThan(g.tongueOuter.max[1]);
    expect(upperTab.max[1]).toBeGreaterThan(g.tongueOuter.max[1]);
    expect(upperPocket.max[1]).toBeGreaterThan(g.grooveOuter.max[1]);
    expect(upperPocket.max[0] - upperPocket.min[0]).toBeGreaterThan(upperTab.max[0] - upperTab.min[0]);
    const upperTabs = g.snapTabs!.filter((p) => p.max[1] > 0).sort((a, b) => a.min[0] - b.min[0]);
    expect(upperTabs).toHaveLength(2);
    expect(upperTabs[0].max[0]).toBeLessThan(upperTabs[1].min[0]);
  });

  it("snap placement can target a single X wall", () => {
    const g = buildEnclosureGeometry(comp, { ...baseParams, snapFit: true, snapPlacement: "+x" });
    expect(g.snapTabs).toHaveLength(2);
    expect(g.snapPockets).toHaveLength(2);
    expect(g.snapTabs![0].max[0]).toBeGreaterThan(g.tongueOuter.max[0]);
    expect(g.snapPockets![0].max[0]).toBeGreaterThan(g.grooveOuter.max[0]);
  });
});

describe("cutoutBox", () => {
  const outer: AABB = { min: [0, 0, 0], max: [30, 20, 10] };

  it("+x face punches inward from outer.max.x", () => {
    const box = cutoutBox(
      { id: "1", face: "+x", u: 10, v: 5, w: 9, h: 4, shape: "rect" },
      outer, 2,
    );
    expect(box.max[0]).toBeGreaterThan(outer.max[0]); // sticks out
    expect(box.min[0]).toBeLessThan(outer.max[0] - 2); // punches through wall
    expect(box.min[1]).toBeCloseTo(10 - 4.5); // outer.y.min + u - w/2
    expect(box.max[1]).toBeCloseTo(10 + 4.5);
  });

  it("-z face punches inward from outer.min.z", () => {
    const box = cutoutBox(
      { id: "1", face: "-z", u: 5, v: 5, w: 6, h: 6, shape: "rect" },
      outer, 2,
    );
    expect(box.min[2]).toBeLessThan(outer.min[2]);
    expect(box.max[2]).toBeGreaterThan(outer.min[2] + 2);
  });
});

describe("faceFrame", () => {
  const outer: AABB = { min: [0, 0, 0], max: [30, 20, 10] };
  it("+z uses X and Y as U/V", () => {
    const f = faceFrame("+z", outer);
    expect(f.nAxis).toBe(2);
    expect(f.uAxis).toBe(0);
    expect(f.vAxis).toBe(1);
    expect(f.plane).toBe(10);
    expect(f.outward).toBe(1);
  });
});

describe("bbox helpers", () => {
  it("computeAabb finds bounds", () => {
    const pos = new Float32Array([0, 0, 0, 1, 2, 3, -1, -2, 5]);
    expect(computeAabb(pos)).toEqual({ min: [-1, -2, 0], max: [1, 2, 5] });
  });
  it("expandAabb grows on both sides", () => {
    const a: AABB = { min: [0, 0, 0], max: [10, 10, 10] };
    const e = expandAabb(a, [1, 2, 3]);
    expect(e.min).toEqual([-1, -2, -3]);
    expect(e.max).toEqual([11, 12, 13]);
  });
});
