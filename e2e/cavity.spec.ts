import { test, expect } from "@playwright/test";

test("box primitive gets open drop-in cavity and flush works", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  // Add a box primitive.
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Verify the box shows up and enclosure generated.
  await expect(page.getByText(/box —/)).toBeVisible();

  // Add a second box to test multi-item cavity.
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Stack the second box below the first.
  const belowButtons = page.getByRole("button", { name: "Below", exact: true });
  await belowButtons.last().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // No overlap warning should appear (items are stacked, not overlapping).
  await expect(page.getByText(/overlap/)).not.toBeVisible();

  // Test flush: click "+x" flush button on the first item.
  const flushButtons = page.getByRole("button", { name: "+x", exact: true });
  // There should be flush buttons (from "Flush to wall" section).
  await expect(flushButtons.first()).toBeVisible();
  await flushButtons.first().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Verify flush state is shown.
  await expect(page.getByText(/Flush to wall \(\+x\)/)).toBeVisible();

  // Un-flush: click the same button again.
  await flushButtons.first().click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Flush label should revert (check first item card only).
  await expect(page.getByText(/Flush to wall:/).first()).toBeVisible();

  // Capture screenshot for visual inspection.
  const canvas = page.locator("canvas").first();
  await page.waitForTimeout(400);
  await canvas.screenshot({ path: "e2e/screenshots/cavity-stacked-boxes.png" });
});

test("flush button moves item position", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  // Add a box.
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Read original x position.
  const xInput = page.locator('input[aria-label="x"]').first();
  const origX = await xInput.inputValue();

  // Flush to +x.
  const flushBtn = page.getByRole("button", { name: "+x", exact: true }).first();
  await flushBtn.click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  // Position should have changed.
  const newX = await xInput.inputValue();
  expect(parseFloat(newX)).not.toBe(parseFloat(origX));
});
