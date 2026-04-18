import { describe, it, expect } from "vitest";
import { computeCombinedAabbWithFlush, computeCavityPocket } from "./flush";
import type { AABB, Vec3 } from "./types";

function item(
  aabb: AABB,
  rotation: Vec3 = [0, 0, 0],
  flushFace: "+x" | "-x" | "+y" | "-y" | null = null,
) {
  return { aabb, rotation, flushFace };
}

const box10: AABB = { min: [-5, -5, -5], max: [5, 5, 5] };
const box10Offset: AABB = { min: [0, 0, 0], max: [10, 10, 10] };

describe("computeCombinedAabbWithFlush", () => {
  it("no items → degenerate fallback [-1,1]", () => {
    const r = computeCombinedAabbWithFlush([], []);
    expect(r).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
  });

  it("single non-flushed item uses world AABB directly", () => {
    const worldAabb: AABB = { min: [-5, -5, -5], max: [5, 5, 5] };
    const r = computeCombinedAabbWithFlush(
      [item(box10)],
      [worldAabb],
    );
    expect(r).toEqual(worldAabb);
  });

  it("single item flushed +x: max uses local, min uses world", () => {
    // Item shifted right after flush. World AABB: [3, 13].
    const worldAabb: AABB = { min: [3, -5, -5], max: [13, 5, 5] };
    const r = computeCombinedAabbWithFlush(
      [item(box10, [0, 0, 0], "+x")],
      [worldAabb],
    );
    // X max: local rotated = 5 (prevents circular growth)
    expect(r.max[0]).toBeCloseTo(5);
    // X min: world = 3 (tight around shifted item)
    expect(r.min[0]).toBeCloseTo(3);
    // Y and Z from world
    expect(r.min[1]).toBeCloseTo(-5);
    expect(r.max[1]).toBeCloseTo(5);
  });

  it("single item flushed -y: min uses local, max uses world", () => {
    // Item shifted down after flush. World AABB y: [-13, -3].
    const worldAabb: AABB = { min: [-5, -13, -5], max: [5, -3, 5] };
    const r = computeCombinedAabbWithFlush(
      [item(box10, [0, 0, 0], "-y")],
      [worldAabb],
    );
    // Y min: local = -5 (flushed side)
    expect(r.min[1]).toBeCloseTo(-5);
    // Y max: world = -3 (tight on opposite side)
    expect(r.max[1]).toBeCloseTo(-3);
  });

  it("asymmetric local AABB: flushed side uses local, opposite uses world", () => {
    // Local AABB: [0, 10]. After flush +x, world: [8, 18].
    const worldAabb: AABB = { min: [8, 0, 0], max: [18, 10, 10] };
    const r = computeCombinedAabbWithFlush(
      [item(box10Offset, [0, 0, 0], "+x")],
      [worldAabb],
    );
    // X max: local = 10 (flushed side)
    expect(r.max[0]).toBeCloseTo(10);
    // X min: world = 8 (opposite side, tight)
    expect(r.min[0]).toBeCloseTo(8);
  });

  it("two items, one flushed: both contribute correctly", () => {
    const worldA: AABB = { min: [3, -5, -5], max: [13, 5, 5] }; // flushed +x
    const worldB: AABB = { min: [-5, -5, 6], max: [5, 5, 16] }; // not flushed
    const r = computeCombinedAabbWithFlush(
      [item(box10, [0, 0, 0], "+x"), item(box10)],
      [worldA, worldB],
    );
    // X max: local of A = 5, world of B = 5 → 5
    expect(r.max[0]).toBeCloseTo(5);
    // X min: world of A = 3, world of B = -5 → -5
    expect(r.min[0]).toBeCloseTo(-5);
    // Z: union of world AABBs → [-5, 16]
    expect(r.min[2]).toBeCloseTo(-5);
    expect(r.max[2]).toBeCloseTo(16);
  });

  it("flushed side width is preserved from local AABB", () => {
    // The flushed side should match the local AABB, preventing circular
    // growth where the enclosure chases the shifted item.
    const worldAabb: AABB = { min: [-2, -5, -5], max: [8, 5, 5] };
    const r = computeCombinedAabbWithFlush(
      [item(box10, [0, 0, 0], "+x")],
      [worldAabb],
    );
    // Max on x from local = 5, not world = 8
    expect(r.max[0]).toBeCloseTo(5);
  });
});

describe("computeCavityPocket", () => {
  const inner: AABB = { min: [-6, -6, -6], max: [6, 6, 6] };
  const splitZ = 3;
  const clearance = 0.5;
  const itemAabb: AABB = { min: [-5, -5, -5], max: [5, 5, 5] };

  it("non-flushed: pocket = item AABB expanded by clearance, top at max(splitZ, item+c)", () => {
    const p = computeCavityPocket(itemAabb, clearance, splitZ, null, inner);
    expect(p.min[0]).toBeCloseTo(-5.5);
    expect(p.max[0]).toBeCloseTo(5.5);
    expect(p.min[2]).toBeCloseTo(-5.5);
    expect(p.max[2]).toBeCloseTo(5.5);
  });

  it("non-flushed: top extends to splitZ when item is short", () => {
    const shortItem: AABB = { min: [-5, -5, -5], max: [5, 5, 0] };
    const p = computeCavityPocket(shortItem, clearance, splitZ, null, inner);
    expect(p.max[2]).toBeCloseTo(3);
  });

  it("flushed +x: x-axis spans full inner box", () => {
    const shiftedItem: AABB = { min: [0, -5, -5], max: [10, 5, 5] };
    const p = computeCavityPocket(shiftedItem, clearance, splitZ, "+x", inner);
    expect(p.min[0]).toBeCloseTo(inner.min[0]);
    expect(p.max[0]).toBeCloseTo(inner.max[0]);
    expect(p.min[1]).toBeCloseTo(-5.5);
    expect(p.max[1]).toBeCloseTo(5.5);
  });

  it("flushed -y: y-axis spans full inner box", () => {
    const p = computeCavityPocket(itemAabb, clearance, splitZ, "-y", inner);
    expect(p.min[1]).toBeCloseTo(inner.min[1]);
    expect(p.max[1]).toBeCloseTo(inner.max[1]);
    expect(p.min[0]).toBeCloseTo(-5.5);
    expect(p.max[0]).toBeCloseTo(5.5);
  });

  it("flushed pocket covers full inner on flushed axis, non-flushed axes unchanged", () => {
    const shiftedItem: AABB = { min: [2, -5, -5], max: [12, 5, 5] };
    const pNon = computeCavityPocket(shiftedItem, clearance, splitZ, null, inner);
    const pFlush = computeCavityPocket(shiftedItem, clearance, splitZ, "+x", inner);
    expect(pFlush.min[0]).toBeCloseTo(inner.min[0]);
    expect(pFlush.max[0]).toBeCloseTo(inner.max[0]);
    expect(pNon.min[0]).toBeCloseTo(1.5);
    expect(pNon.max[0]).toBeCloseTo(12.5);
    expect(pFlush.min[1]).toBeCloseTo(pNon.min[1]);
    expect(pFlush.max[1]).toBeCloseTo(pNon.max[1]);
  });

  it("flushed pocket eliminates gap on opposite side", () => {
    const shiftedItem: AABB = { min: [3, -5, -5], max: [13, 5, 5] };
    const pFlush = computeCavityPocket(shiftedItem, clearance, splitZ, "+x", inner);
    expect(pFlush.min[0]).toBeCloseTo(inner.min[0]);
  });
});
