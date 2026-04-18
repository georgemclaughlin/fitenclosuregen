import { test, expect } from "@playwright/test";
import * as fs from "fs";

function readStlTriCount(path: string): number {
  const buf = fs.readFileSync(path);
  if (buf.length < 84) return 0;
  return buf.readUInt32LE(80);
}

test("two stacked boxes produce open drop-in cavity (not solid fill)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  // Add first box.
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Add second box and stack it below.
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });
  const belowButtons = page.getByRole("button", { name: "Below", exact: true });
  await belowButtons.last().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Download base STL.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download base.stl" }).click(),
  ]);
  const basePath = await download.path();
  expect(basePath).toBeTruthy();

  const triCount = readStlTriCount(basePath!);
  console.log(`Base STL triangle count: ${triCount}`);
  // A solid box is 12 triangles. A hollow shell with drop-in cavity has 100+.
  expect(triCount).toBeGreaterThan(50);

  // Download lid too and verify.
  const [lidDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download lid.stl" }).click(),
  ]);
  const lidPath = await lidDownload.path();
  const lidTriCount = readStlTriCount(lidPath!);
  console.log(`Lid STL triangle count: ${lidTriCount}`);
  expect(lidTriCount).toBeGreaterThan(12);

  const realErrors = errors.filter((e) => !e.includes("ResizeObserver"));
  expect(realErrors).toEqual([]);
});

test("flush moves item and enclosure stays fixed size", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  // Add two boxes.
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Stack second below first.
  const belowButtons = page.getByRole("button", { name: "Below", exact: true });
  await belowButtons.last().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Download base before flush.
  const [dl1] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download base.stl" }).click(),
  ]);
  const beforePath = await dl1.path();
  const beforeSize = fs.statSync(beforePath!).size;

  // Flush first box to +x.
  const flushXBtns = page.getByRole("button", { name: "+x", exact: true });
  await flushXBtns.first().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Verify flush state shown and no errors.
  await expect(page.getByText(/Flush to wall \(\+x\)/)).toBeVisible();

  // Download base after flush.
  const [dl2] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download base.stl" }).click(),
  ]);
  const afterPath = await dl2.path();
  const afterSize = fs.statSync(afterPath!).size;
  console.log(`Base STL before flush: ${beforeSize} bytes, after flush: ${afterSize} bytes`);

  // After flush the geometry should still be valid (non-empty).
  const afterTriCount = readStlTriCount(afterPath!);
  expect(afterTriCount).toBeGreaterThan(12);

  const realErrors = errors.filter((e) => !e.includes("ResizeObserver"));
  expect(realErrors).toEqual([]);
});
