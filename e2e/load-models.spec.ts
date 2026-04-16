import { test, expect, Page } from "@playwright/test";
import { findFixture } from "./fixtures";

/**
 * Browser smoke tests. For each available fixture, upload it and verify:
 *  1. No errors surfaced in the app's status strip.
 *  2. No console errors or uncaught page exceptions.
 *  3. The generator reaches the "Ready." state (mesh successfully produced).
 */

type Severity = "error" | "warning";
interface ConsoleEntry { severity: Severity; text: string; }

async function uploadAndVerify(page: Page, fixture: string) {
  const consoleErrors: ConsoleEntry[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push({ severity: "error", text: msg.text() });
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/");
  await expect(page.getByText("Drop a model file")).toBeVisible();

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(fixture);

  // Wait for generation to finish; status strip transitions through Generating → Ready.
  await expect(page.getByText(/^Ready\.$/)).toBeVisible({ timeout: 45_000 });

  // No errors from app code.
  const ignore = [
    /three-mesh-bvh@0\.7\.8: Deprecated/,
    /Download the React DevTools/,
  ];
  const relevantConsole = consoleErrors.filter((e) => !ignore.some((r) => r.test(e.text)));
  expect(relevantConsole, `console errors: ${JSON.stringify(relevantConsole)}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.map((e) => e.message).join("; ")}`).toEqual([]);

  // Export buttons enabled ⇒ valid mesh result.
  await expect(page.getByRole("button", { name: /Download base\.stl/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Download lid\.stl/ })).toBeEnabled();
}

for (const kind of ["step", "stl", "obj", "3mf"] as const) {
  const fixture = findFixture(kind);
  test(`loads ${kind.toUpperCase()} and generates shell`, async ({ page }) => {
    test.skip(!fixture, `no ${kind} fixture found locally`);
    await uploadAndVerify(page, fixture!);
  });
}
