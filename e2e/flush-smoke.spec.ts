import { test, expect } from "@playwright/test";
import * as fs from "fs";

function readStlBounds(path: string): { min: [number, number, number]; max: [number, number, number] } {
  const buf = fs.readFileSync(path);
  if (buf.length < 84) throw new Error("STL too small");
  const triCount = buf.readUInt32LE(80);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triCount; t++) {
    const off = 84 + t * 50;
    for (let v = 0; v < 3; v++) {
      const vOff = off + 12 + v * 12;
      const x = buf.readFloatLE(vOff);
      const y = buf.readFloatLE(vOff + 4);
      const z = buf.readFloatLE(vOff + 8);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  }
  return { min, max };
}

function stlSize(path: string): [number, number, number] {
  const b = readStlBounds(path);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

async function addBoxAndWaitReady(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });
}

async function downloadStl(page: import("@playwright/test").Page, name: string): Promise<string> {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: `Download ${name}` }).click(),
  ]);
  const p = await dl.path();
  expect(p).toBeTruthy();
  return p!;
}

/** Wait for debounced regeneration to complete after a store action. */
async function waitForRegeneration(page: import("@playwright/test").Page) {
  // The App.tsx useEffect has a 200ms debounce. Wait for it to fire and
  // the worker to complete. We poll for the status text to cycle through
  // "Generating…" back to "Ready." by waiting long enough for both.
  await page.waitForTimeout(400);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });
}

function expectClose(actual: number, expected: number, tol: number, label: string) {
  const diff = Math.abs(actual - expected);
  expect(diff, `${label}: ${actual.toFixed(2)} vs ${expected.toFixed(2)}, diff=${diff.toFixed(3)}`).toBeLessThan(tol);
}

// Default "+ Box" is 20×20×10, params: wall=2, clearance=0.8, floor=1.6.
// Outer size no-flush: 20+2*(0.8+2) = 25.6 on x/y.

test("single box flush +x: flushed axis shrinks, non-flushed unchanged", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();
  await addBoxAndWaitReady(page);

  const beforePath = await downloadStl(page, "base.stl");
  const beforeSize = stlSize(beforePath);

  await page.getByRole("button", { name: "+x", exact: true }).first().click();
  await waitForRegeneration(page);

  const afterPath = await downloadStl(page, "base.stl");
  const afterSize = stlSize(afterPath);

  console.log(`Before: size=${beforeSize.map((v) => v.toFixed(2))}`);
  console.log(`After:  size=${afterSize.map((v) => v.toFixed(2))}`);

  // Y and Z unchanged (flush only affects x).
  expectClose(afterSize[1], beforeSize[1], 0.1, "Y depth");
  expectClose(afterSize[2], beforeSize[2], 0.1, "Z height");

  // X should shrink by clearance+wall = 2.8 (opposite side tightens).
  expect(afterSize[0]).toBeLessThan(beforeSize[0] - 0.5);
  expectClose(afterSize[0], beforeSize[0] - 2.8, 0.5, "X width shrank");
});

test("single box flush -y: flushed axis shrinks, non-flushed unchanged", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();
  await addBoxAndWaitReady(page);

  const beforePath = await downloadStl(page, "base.stl");
  const beforeSize = stlSize(beforePath);

  await page.getByRole("button", { name: "-y", exact: true }).first().click();
  await waitForRegeneration(page);

  const afterPath = await downloadStl(page, "base.stl");
  const afterSize = stlSize(afterPath);

  console.log(`Before: ${beforeSize.map((v) => v.toFixed(2))}`);
  console.log(`After:  ${afterSize.map((v) => v.toFixed(2))}`);

  // X and Z unchanged.
  expectClose(afterSize[0], beforeSize[0], 0.1, "X width");
  expectClose(afterSize[2], beforeSize[2], 0.1, "Z height");

  // Y shrinks.
  expect(afterSize[1]).toBeLessThan(beforeSize[1] - 0.5);
});

test("non-flushed box: symmetric center, valid geometry", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();
  await addBoxAndWaitReady(page);

  const basePath = await downloadStl(page, "base.stl");
  const bounds = readStlBounds(basePath);

  const buf = fs.readFileSync(basePath);
  const triCount = buf.readUInt32LE(80);
  expect(triCount).toBeGreaterThan(12);

  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  console.log(`Center: x=${cx.toFixed(2)}, y=${cy.toFixed(2)}`);
  expectClose(cx, 0, 1, "center X");
  expectClose(cy, 0, 1, "center Y");
});

test("flush +x: wall thickness uniform on opposite side", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();
  await addBoxAndWaitReady(page);

  const xInput = page.locator('input[aria-label="x"]').first();
  const origX = parseFloat(await xInput.inputValue());

  await page.getByRole("button", { name: "+x", exact: true }).first().click();
  await waitForRegeneration(page);

  const newX = parseFloat(await xInput.inputValue());
  expect(newX).toBeGreaterThan(origX);

  const afterPath = await downloadStl(page, "base.stl");
  const afterBounds = readStlBounds(afterPath);

  console.log(`Item moved from x=${origX.toFixed(2)} to x=${newX.toFixed(2)}`);
  console.log(`After bounds x: [${afterBounds.min[0].toFixed(2)}, ${afterBounds.max[0].toFixed(2)}]`);

  // -x wall = item.min.x - outer.min.x should be ~2.8 (clearance+wall).
  const itemHalfWidth = 10; // 20/2
  const itemMinX = newX - itemHalfWidth;
  const minusXWall = itemMinX - afterBounds.min[0];
  console.log(`-x wall thickness: ${minusXWall.toFixed(2)}`);
  expectClose(minusXWall, 2.8, 0.5, "-x wall thickness");
});

test("flush then un-flush: geometry returns to valid state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();
  await addBoxAndWaitReady(page);

  const beforeBuf = fs.readFileSync(await downloadStl(page, "base.stl"));
  const beforeTris = beforeBuf.readUInt32LE(80);

  const flushBtn = page.getByRole("button", { name: "+x", exact: true }).first();
  await flushBtn.click();
  await waitForRegeneration(page);

  await flushBtn.click();
  await waitForRegeneration(page);

  const afterBuf = fs.readFileSync(await downloadStl(page, "base.stl"));
  const afterTris = afterBuf.readUInt32LE(80);

  expect(afterTris).toBeGreaterThan(12);
  console.log(`Before: ${beforeTris} tris, After un-flush: ${afterTris} tris`);
});
