import { expect, test } from "@playwright/test";

test("repeated edits survive CAD worker recycling", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Box", exact: true }).click();
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });

  const x = page.getByLabel("x", { exact: true });
  await expect(x).toHaveCount(1);
  for (let position = 1; position <= 22; position++) {
    await x.fill(String(position));
    await expect(page.getByText(/^Generating…$/)).toBeVisible();
    await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });
  }

  await expect(x).toHaveValue("22");
  await expect(page.getByRole("button", { name: "Download base.stl" })).toBeEnabled();
  await expect(page.getByText(/^Error:/)).toHaveCount(0);
});
