import { test, expect } from "@playwright/test";
import { findFixture } from "./fixtures";

test("snap-fit tabs and pockets are visible", async ({ page }) => {
  const fixture = findFixture("step");
  test.skip(!fixture, "no step fixture");

  await page.goto("/");
  await page.locator('input[accept^=".stl"]').first().setInputFiles(fixture!);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Enable snap-fit.
  await page.getByRole("checkbox", { name: "Snap-fit lid", exact: true }).check();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  await page.getByRole("checkbox", { name: "Component", exact: true }).uncheck();
  await page.getByLabel("Shell opacity").fill("1");

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  async function orbit(dx: number, dy: number) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
    await page.mouse.up();
  }

  // Base only, tilted so we see the tongue top + snap tabs.
  await page.getByRole("checkbox", { name: "Lid", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Base", exact: true }).check();
  await orbit(0, -150);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -80);
  await page.waitForTimeout(400);
  await canvas.screenshot({ path: "e2e/screenshots/snap-01-base-tongue.png" });

  // Lid only, flipped to see the groove + snap pockets.
  await page.getByRole("checkbox", { name: "Base", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Lid", exact: true }).check();
  await orbit(0, -400);
  await page.waitForTimeout(400);
  await canvas.screenshot({ path: "e2e/screenshots/snap-02-lid-groove.png" });
});
