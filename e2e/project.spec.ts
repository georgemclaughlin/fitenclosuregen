import { expect, test } from "@playwright/test";

test("save, open, undo, redo, and autosave restore a portable project", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Project name").fill("Portable sensor case");
  const x = page.getByLabel("x", { exact: true });
  await x.fill("8");
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(x).toHaveValue("0");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(x).toHaveValue("8");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("portable-sensor-case.dropfit");
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByText("No items yet.")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Portable sensor case");
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("8");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.locator('input[accept^=".dropfit"]').setInputFiles(savedPath!);
  await expect(page.getByRole("status")).toHaveText(/^Opened /);
  await expect(page.getByLabel("Project name")).toHaveValue("Portable sensor case");
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("8");

  // Wait for the debounced IndexedDB autosave, then verify a full reload.
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.getByLabel("Project name")).toHaveValue("Portable sensor case");
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("8");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});
