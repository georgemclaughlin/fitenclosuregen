import { test, expect } from "@playwright/test";

test("add a connection corridor and show its debug helper", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(page.getByText("Click a point on any model to set point 1.")).toBeVisible();

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas missing");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByText(/Click Box /)).toBeVisible();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByText(/Point 1 set on Box/)).toBeVisible();

  await page.mouse.move(box.x + box.width / 2 + 32, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2 + 32, box.y + box.height / 2);
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[value="Connection"]')).toBeVisible();

  await page.getByLabel("Debug helpers").check();
  await expect(page.getByRole("checkbox", { name: "Connections", exact: true })).toBeVisible();
  await expect(page.getByText(/green = connections/)).toBeVisible();
});
