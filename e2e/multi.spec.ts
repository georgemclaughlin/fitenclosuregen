import { test, expect } from "@playwright/test";
import { findFixture } from "./fixtures";

test("add imported MCU + battery primitive stacked above", async ({ page }) => {
  const fixture = findFixture("step");
  test.skip(!fixture, "no step fixture");

  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  // The drop zone disappears once we've added anything; use the native file picker first.
  await page.locator('input[accept^=".stl"]').first().setInputFiles(fixture!);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Add an 18650 battery via the battery preset dropdown.
  // First select 18650 from the <select>, then click "+ Battery".
  await page.locator("select").first().selectOption({ label: "18650 (cylindrical)" });
  await page.getByRole("button", { name: "+ Battery", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Find the battery card (it's the second item) and stack it above the MCU.
  // Click the "Above" button on the second card.
  const aboveButtons = page.getByRole("button", { name: "Above", exact: true });
  await aboveButtons.last().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

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

  await page.waitForTimeout(400);
  await canvas.screenshot({ path: "e2e/screenshots/multi-01-default.png" });

  // Zoom in + orbit to see the stacked battery inside.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);
  await orbit(120, -80);
  await page.waitForTimeout(400);
  await canvas.screenshot({ path: "e2e/screenshots/multi-02-side.png" });

  // Make shell semi-transparent so we see the battery clearly.
  // It already is default opacity 0.35.
});
