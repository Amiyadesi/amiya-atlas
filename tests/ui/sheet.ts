import type { Page } from "@playwright/test";

export async function openAssetSheet(page: Page) {
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  await page
    .getByRole("dialog", { name: "快速记录" })
    .getByRole("button", { name: "记资产", exact: true })
    .click();
}
