import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/features", route => route.fulfill({ json: {} }));
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
});

test("inspect an asset, book the lunch example, and follow its guide", async ({ page }) => {
  await page.goto("/en", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Google One ¥19/ }).click();
  await expect(page.getByRole("button", { name: /Payment method Everyday card/ })).toBeVisible();
  await page.getByRole("tab", { name: "Connections" }).press("ArrowRight");
  await page.getByRole("button", { name: "Book entry" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "210");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "187.5");
  await page.getByRole("tab", { name: "Ledger" }).press("End");
  await expect(page.getByRole("tabpanel")).toContainText("Passwords stripped");
  await page.getByRole("tab", { name: "Ledger" }).click();
  await page.getByRole("link", { name: "Explore project costs" }).click();
  await expect(page).toHaveURL(/\/en\/guide#bookkeeping$/);
});

test("a saved theme overrides the OS; system mode follows changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/", { waitUntil: "networkidle" });
  const root = page.locator("html");
  await expect(root).toHaveCSS("background-color", "rgb(15, 17, 23)");
  await page.getByRole("button", { name: /主题：跟随系统/ }).click();
  await page.reload({ waitUntil: "networkidle" });
  await expect(root).toHaveCSS("background-color", "rgb(246, 247, 250)");
  await page.getByRole("button", { name: /主题：浅色/ }).click();
  await page.getByRole("button", { name: /主题：暗色/ }).click();
  await expect(root).toHaveCSS("background-color", "rgb(15, 17, 23)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveCSS("background-color", "rgb(246, 247, 250)");
});
