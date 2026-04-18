import { test, expect } from "@playwright/test";
import { findFixture } from "./fixtures";

test("inspect cutout on XIAO with -X snap", async ({ page }) => {
  const fixture = findFixture("step");
  test.skip(!fixture, "no step fixture");

  await page.goto("/");
  await page.locator('input[type="file"]').first().setInputFiles(fixture!);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Apply -X face snap so the USB connector pokes out the -X wall.
  await page.getByRole("button", { name: "-x", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Hide lid and component, make base opaque.
  await page.getByRole("checkbox", { name: "Lid", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Component", exact: true }).uncheck();
  await page.getByLabel("Shell opacity").fill("1");

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  // Zoom in.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(300);
  await canvas.screenshot({ path: "e2e/screenshots/cutout-xsnap.png" });

  // Rotate to see the -X face head-on.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await canvas.screenshot({ path: "e2e/screenshots/cutout-xsnap-side.png" });
});
