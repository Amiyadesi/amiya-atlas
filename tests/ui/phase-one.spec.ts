import { expect, test } from "@playwright/test";

test("system theme, explicit override, memory views and keyboard search", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "切换主题：跟随系统" }).click();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.getByLabel("记忆排序").selectOption("relations");
  await expect(page.locator(".entity-list.cards button").first()).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "打开命令面板" }).click();
  const search = page.getByRole("combobox", { name: "搜索命令、记忆或账户" });
  await search.fill("clfl main");
  await expect(
    page.getByRole("option", { name: /Cloudflare Main/ }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Cloudflare Main" }),
  ).toBeVisible();
  await page.keyboard.press("Control+Shift+Space");
  await expect(
    page.getByRole("dialog", { name: "随手记下一件事" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("preview an expense, open its account, cancel plaintext export, inspect flow", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "打开命令面板" }).waitFor();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "搜索命令、记忆或账户" });
  await search.fill("午饭 25 微信");
  await expect(page.getByRole("option").first()).toContainText("CNY 25.00");
  await search.press("Enter");
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "账本", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  await search.fill("微信");
  await search.press("Enter");
  await expect(
    page.getByLabel("账户筛选").locator("option:checked"),
  ).toHaveText("微信");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  await expect(
    page.getByRole("dialog", { name: "导出明文 CSV？" }),
  ).toContainText("未经加密");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "回顾", exact: true }).click();
  const node = page.locator(".flow g[tabindex]").first();
  await node.focus();
  await expect(page.locator(".flow-readout")).toContainText("25.00");
});

test("whole-vault money graph, category highlight, isolate toggle and relation editing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "关系图", exact: true }).click();
  await page.getByRole("button", { name: "金钱", exact: true }).click();
  await expect(page.getByLabel("聚焦资产")).toHaveValue("");
  await expect(page.locator(".graph-scene canvas")).toBeVisible();
  const total =
    (await page.getByLabel("聚焦资产").locator("option").count()) - 1;
  await expect(page.locator(".canvas-count")).toContainText(`${total} 个资产`);
  const category = page
    .locator(".canvas-legend")
    .getByRole("button", { name: "账号" });
  await category.click();
  await expect(category).toHaveAttribute("aria-pressed", "true");
  await category.click();
  await page.getByLabel("隐藏孤立节点").check();
  await expect(page.locator(".canvas-count")).not.toContainText(
    `${total} 个资产`,
  );
  await page.getByLabel("聚焦资产").selectOption("cloudflare-main");
  const detail = page.locator(".selection-detail");
  await expect(detail).toContainText("Global");
  await detail.getByRole("button", { name: "收藏", exact: true }).click();
  await expect(detail.getByRole("button", { name: "取消收藏" })).toBeVisible();
  await detail.getByRole("button", { name: "新增关联" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "编辑记录" })
      .getByRole("button", { name: "＋ 关联" }),
  ).toBeVisible();
});
