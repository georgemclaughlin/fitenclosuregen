import { test, expect } from "@playwright/test";
import * as fs from "fs";
import { findFixture } from "./fixtures";

function readStlTriCount(path: string): number {
  const buf = fs.readFileSync(path);
  if (buf.length < 84) return 0;
  return buf.readUInt32LE(80);
}

test("flipped STEP import flushed to -Y keeps valid base reliefs", async ({ page }) => {
  const fixture = findFixture("step");
  test.skip(!fixture, "no STEP fixture");

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await page.locator("input[type='file']").first().setInputFiles(fixture!);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Flip Y", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "-y", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Flush to wall \(-y\)/)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download base.stl" }).click(),
  ]);
  const basePath = await download.path();
  expect(basePath).toBeTruthy();

  // A very low triangle count usually means the import was covered by a broad
  // access pocket or shifted incorrectly during flip.
  expect(readStlTriCount(basePath!)).toBeGreaterThan(100);

  const realErrors = errors.filter((e) => !e.includes("ResizeObserver"));
  expect(realErrors).toEqual([]);
});
