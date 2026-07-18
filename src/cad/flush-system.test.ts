/**
 * System-level tests for flush-to-wall.
 *
 * Uses a simple 20×10×6 box item (like a small PCB) with known params.
 * Validates exact geometry values through the full pipeline:
 *   computeCombinedAabbWithFlush → buildEnclosureGeometry → computeCavityPocket
 *
 * These tests catch regressions where the enclosure or cavity drifts from
 * the expected tight-fit behavior.
 */
import { describe, it, expect } from "vitest";
import { computeCombinedAabbWithFlush, computeCavityPocket } from "./flush";
import { buildEnclosureGeometry } from "./shell";
import { transformedAabb } from "./bbox";
import type { AABB, EnclosureParams, Vec3 } from "./types";

const params: EnclosureParams = {
  wall: 2, floor: 1.6, clearance: 0.5, fillet: 0,
  lidFrac: 0.25, lipDepth: 3, lipTol: 0.2,
  snapFit: false, snapSize: 0.3, snapPlacement: "both-y",
};

// A 20×10×6 box centered at origin.
const localAabb: AABB = { min: [-10, -5, -3], max: [10, 5, 3] };

function makeItem(
  position: Vec3,
  flushFace: "+x" | "-x" | "+y" | "-y" | null = null,
) {
  return {
    aabb: localAabb,
    rotation: [0, 0, 0] as Vec3,
    position,
    flushFace,
  };
}

function worldAabb(position: Vec3): AABB {
  return transformedAabb(localAabb, [0, 0, 0], position);
}

describe("flush system: single 20×10×6 box", () => {
  // ── Baseline (no flush) ──────────────────────────────────────────────

  it("baseline: enclosure is symmetric around centered item", () => {
    const item = makeItem([0, 0, 0]);
    const world = worldAabb(item.position);
    const combined = computeCombinedAabbWithFlush([item], [world]);
    const geom = buildEnclosureGeometry(combined, params);

    // Combined = local AABB (item at origin).
    expect(combined).toEqual(localAabb);

    // Outer shell symmetric: ±(10+0.5+2) = ±12.5 on x.
    expect(geom.outer.min[0]).toBeCloseTo(-12.5);
    expect(geom.outer.max[0]).toBeCloseTo(12.5);

    // Inner symmetric: ±(10+0.5) = ±10.5.
    expect(geom.inner.min[0]).toBeCloseTo(-10.5);
    expect(geom.inner.max[0]).toBeCloseTo(10.5);

    const pocket = computeCavityPocket(world, params.clearance, geom.splitZ, null, geom.inner);
    // Pocket is item + clearance = ±10.5 on x — same as inner.
    expect(pocket.min[0]).toBeCloseTo(-10.5);
    expect(pocket.max[0]).toBeCloseTo(10.5);
  });

  // ── Flush +x ─────────────────────────────────────────────────────────

  it("flush +x: item moves to outer wall, enclosure tight on -x side", () => {
    // Step 1: store computes enclosure from pre-flush position [0,0,0].
    const preFlushWorld = worldAabb([0, 0, 0]);
    const storeItem = makeItem([0, 0, 0], "+x");
    const storeCombined = computeCombinedAabbWithFlush([storeItem], [preFlushWorld]);
    const storeGeom = buildEnclosureGeometry(storeCombined, params);

    // Store moves item so its +x edge reaches the actual reinforced exterior.
    const delta = storeGeom.interfaceOuter.max[0] - preFlushWorld.max[0];
    const newPos: Vec3 = [delta, 0, 0];
    const postFlushWorld = worldAabb(newPos);

    // Item's +x edge should be at the outer wall.
    expect(postFlushWorld.max[0]).toBeCloseTo(storeGeom.interfaceOuter.max[0]);

    // Step 2: worker sees item at flushed position.
    const workerItem = makeItem(newPos, "+x");
    const workerCombined = computeCombinedAabbWithFlush([workerItem], [postFlushWorld]);
    const workerGeom = buildEnclosureGeometry(workerCombined, params);

    // ── KEY INVARIANT: flushed side outer wall matches store ────────
    expect(workerGeom.interfaceOuter.max[0]).toBeCloseTo(storeGeom.interfaceOuter.max[0]);

    // ── KEY INVARIANT: item is at the outer wall ────────────────────
    expect(postFlushWorld.max[0]).toBeCloseTo(workerGeom.interfaceOuter.max[0]);

    // ── KEY INVARIANT: opposite side is tight around shifted item ───
    const minusXWall = postFlushWorld.min[0] - workerGeom.interfaceOuter.min[0];
    expect(minusXWall).toBeCloseTo(storeGeom.interfaceOuter.max[0] - preFlushWorld.max[0]);

    // ── Cavity should NOT have extra space on -x side ──────────────
    const pocket = computeCavityPocket(
      postFlushWorld, params.clearance, workerGeom.splitZ, "+x", workerGeom.inner,
    );
    // Pocket -x edge should be at item -x edge minus clearance.
    const pocketGap = postFlushWorld.min[0] - pocket.min[0];
    expect(pocketGap).toBeCloseTo(params.clearance);
  });

  it("flush -x: item moves to -x outer wall, tight on +x side", () => {
    // Store: item at [0,0,0], flush to -x.
    const preFlushWorld = worldAabb([0, 0, 0]);
    const storeItem = makeItem([0, 0, 0], "-x");
    const storeCombined = computeCombinedAabbWithFlush([storeItem], [preFlushWorld]);
    const storeGeom = buildEnclosureGeometry(storeCombined, params);

    const delta = storeGeom.interfaceOuter.min[0] - preFlushWorld.min[0];
    const newPos: Vec3 = [delta, 0, 0];
    const postFlushWorld = worldAabb(newPos);

    expect(postFlushWorld.min[0]).toBeCloseTo(storeGeom.interfaceOuter.min[0]);

    const workerItem = makeItem(newPos, "-x");
    const workerCombined = computeCombinedAabbWithFlush([workerItem], [postFlushWorld]);
    const workerGeom = buildEnclosureGeometry(workerCombined, params);

    // Flushed side: item -x edge at outer -x wall.
    expect(postFlushWorld.min[0]).toBeCloseTo(workerGeom.interfaceOuter.min[0]);

    // Opposite side: tight fit on +x.
    const plusXWall = workerGeom.interfaceOuter.max[0] - postFlushWorld.max[0];
    expect(plusXWall).toBeCloseTo(preFlushWorld.min[0] - storeGeom.interfaceOuter.min[0]);
  });

  it("flush +y: y-axis flush, x-axis unchanged", () => {
    const preFlushWorld = worldAabb([0, 0, 0]);
    const storeItem = makeItem([0, 0, 0], "+y");
    const storeCombined = computeCombinedAabbWithFlush([storeItem], [preFlushWorld]);
    const storeGeom = buildEnclosureGeometry(storeCombined, params);

    const delta = storeGeom.interfaceOuter.max[1] - preFlushWorld.max[1];
    const newPos: Vec3 = [0, delta, 0];
    const postFlushWorld = worldAabb(newPos);

    const workerItem = makeItem(newPos, "+y");
    const workerCombined = computeCombinedAabbWithFlush([workerItem], [postFlushWorld]);
    const workerGeom = buildEnclosureGeometry(workerCombined, params);

    // Y: item at outer wall, opposite tight.
    expect(postFlushWorld.max[1]).toBeCloseTo(workerGeom.interfaceOuter.max[1]);
    const minusYWall = postFlushWorld.min[1] - workerGeom.interfaceOuter.min[1];
    expect(minusYWall).toBeCloseTo(storeGeom.interfaceOuter.max[1] - preFlushWorld.max[1]);

    // X: unchanged from baseline.
    expect(workerGeom.outer.min[0]).toBeCloseTo(-12.5);
    expect(workerGeom.outer.max[0]).toBeCloseTo(12.5);
  });

  it("non-flushed item: no extra space anywhere", () => {
    const item = makeItem([0, 0, 0]);
    const world = worldAabb([0, 0, 0]);
    const combined = computeCombinedAabbWithFlush([item], [world]);
    const geom = buildEnclosureGeometry(combined, params);
    const pocket = computeCavityPocket(world, params.clearance, geom.splitZ, null, geom.inner);

    // Wall thickness identical on all 4 horizontal sides.
    for (const a of [0, 1] as const) {
      const wallMin = world.min[a] - geom.outer.min[a];
      const wallMax = geom.outer.max[a] - world.max[a];
      expect(wallMin).toBeCloseTo(params.clearance + params.wall);
      expect(wallMax).toBeCloseTo(params.clearance + params.wall);
    }

    // Cavity clearance identical on all 4 horizontal sides.
    for (const a of [0, 1] as const) {
      expect(world.min[a] - pocket.min[a]).toBeCloseTo(params.clearance);
      expect(pocket.max[a] - world.max[a]).toBeCloseTo(params.clearance);
    }
  });
});

describe("flush system: asymmetric local AABB (not centered at origin)", () => {
  // Simulates a STEP import where geometry isn't centered.
  const asymAabb: AABB = { min: [0, -5, -3], max: [20, 5, 3] };

  function makeAsymItem(position: Vec3, flushFace: "+x" | "-x" | null = null) {
    return { aabb: asymAabb, rotation: [0, 0, 0] as Vec3, position, flushFace };
  }

  it("flush +x: enclosure tight on both sides", () => {
    const preWorld = transformedAabb(asymAabb, [0, 0, 0], [0, 0, 0]);
    const storeItem = makeAsymItem([0, 0, 0], "+x");
    const storeCombined = computeCombinedAabbWithFlush([storeItem], [preWorld]);
    const storeGeom = buildEnclosureGeometry(storeCombined, params);

    const delta = storeGeom.interfaceOuter.max[0] - preWorld.max[0];
    const newPos: Vec3 = [delta, 0, 0];
    const postWorld = transformedAabb(asymAabb, [0, 0, 0], newPos);

    const workerItem = makeAsymItem(newPos, "+x");
    const workerCombined = computeCombinedAabbWithFlush([workerItem], [postWorld]);
    const workerGeom = buildEnclosureGeometry(workerCombined, params);

    // +x: item at outer wall.
    expect(postWorld.max[0]).toBeCloseTo(workerGeom.interfaceOuter.max[0]);

    // -x: tight around shifted item.
    const minusXWall = postWorld.min[0] - workerGeom.interfaceOuter.min[0];
    expect(minusXWall).toBeCloseTo(storeGeom.interfaceOuter.max[0] - preWorld.max[0]);
  });
});
