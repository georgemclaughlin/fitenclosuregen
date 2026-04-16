import { test, expect } from "@playwright/test";
import { findFixture } from "./fixtures";

test("adding a second item auto-places alongside (no overlap)", async ({ page }) => {
  const fixture = findFixture("step");
  test.skip(!fixture, "no step fixture");

  await page.goto("/");
  await page.locator('input[type="file"]').first().setInputFiles(fixture!);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  await page.locator("select").first().selectOption({ label: "18650 (cylindrical)" });
  await page.getByRole("button", { name: "+ Battery", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // Overlap warning should NOT appear — auto-placement should put them apart.
  await expect(page.getByText(/overlap — adjust/)).toHaveCount(0);

  const canvas = page.locator("canvas").first();
  await page.waitForTimeout(300);
  await canvas.screenshot({ path: "e2e/screenshots/autoplace-01.png" });
});
