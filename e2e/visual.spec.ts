import { test, expect } from "@playwright/test";
import { findFixture } from "./fixtures";

/**
 * Load the T-Display STEP and capture screenshots of the default output from
 * multiple angles so we can inspect geometry visually.
 */

test("T-Display default output screenshots", async ({ page }) => {
  const fixture = findFixture("step");
  test.skip(!fixture, "no STEP fixture found");

  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles(fixture!);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  async function shot(name: string) {
    await page.waitForTimeout(200);
    await canvas.screenshot({ path: `e2e/screenshots/${name}.png` });
  }

  // Drag the orbit control to a camera angle. dy>0 rotates camera upward
  // (looking from higher). Negative dy flips below the object.
  async function orbitDrag(dy: number) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + dy, { steps: 10 });
    await page.mouse.up();
  }

  await shot("01-default-both");

  // Hide lid, keep base.
  await page.getByRole("checkbox", { name: "Lid", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Component", exact: true }).uncheck();
  await shot("02-base-only");

  // Hide base, show lid only.
  await page.getByRole("checkbox", { name: "Base", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Lid", exact: true }).check();
  await shot("03-lid-only");

  // Crank opacity up so we can see solid shape.
  const opacitySlider = page.getByLabel("Shell opacity");
  await opacitySlider.fill("1");
  await shot("04-lid-opaque");

  await page.getByRole("checkbox", { name: "Base", exact: true }).check();
  await page.getByRole("checkbox", { name: "Lid", exact: true }).uncheck();
  await shot("05-base-opaque");

  // Top-down view of base — see cavity silhouette.
  await orbitDrag(-200);
  await shot("06-base-top-down");

  // Show lid only, rotate further to see underside (groove).
  await page.getByRole("checkbox", { name: "Base", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Lid", exact: true }).check();
  await orbitDrag(-400);
  await shot("07-lid-underside");
});
