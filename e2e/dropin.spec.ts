import { test, expect } from "@playwright/test";
import { findFixture } from "./fixtures";

test("STEP import with box below generates without errors", async ({ page }) => {
  const fixture = findFixture("step");
  test.skip(!fixture, "no step fixture");

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  // Import STEP file.
  await page.locator('input[type="file"]').first().setInputFiles(fixture!);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Add a LiPo 503450 battery box.
  const presetSelect = page.locator("select").first();
  await presetSelect.selectOption({ label: "LiPo 503450 (500 mAh)" });
  await page.getByRole("button", { name: "+ Battery", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Stack battery below.
  const belowButtons = page.getByRole("button", { name: "Below", exact: true });
  await belowButtons.last().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Flush the MCU to +x wall.
  const flushXButtons = page.getByRole("button", { name: "+x", exact: true });
  await flushXButtons.first().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Verify flush state shown.
  await expect(page.getByText(/Flush to wall \(\+x\)/)).toBeVisible();

  // Download base STL and check it's not empty.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download base.stl" }).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();

  // Read file to check it has substantial content.
  const fs = await import("fs");
  const stat = fs.statSync(path!);
  expect(stat.size).toBeGreaterThan(1000);

  // No console errors should have occurred.
  const realErrors = errors.filter((e) => !e.includes("ResizeObserver"));
  expect(realErrors).toEqual([]);
});
