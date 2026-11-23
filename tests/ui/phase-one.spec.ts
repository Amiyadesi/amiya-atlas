import { expect, test } from "@playwright/test";

test("system theme, explicit override, memory views and keyboard search", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "我的", exact: true }).click();
  await page
    .getByRole("group", { name: "外观主题" })
    .getByRole("button", { name: "浅色" })
    .click();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "资产", exact: true }).click();
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.getByLabel("记忆排序").selectOption("relations");
  await expect(page.locator(".entity-list.cards button").first()).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Control+k");
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
  await expect(page.getByRole("dialog", { name: "快速记录" })).toBeVisible();
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
    page.getByRole("heading", { name: "今日", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  await search.fill("微信");
  await search.press("Enter");
  await expect(page.getByLabel("清除流水筛选")).toContainText("微信");
  await page.getByLabel("更多操作").click();
  await page.getByRole("button", { name: "导出 CSV" }).click();
  await expect(
    page.getByRole("dialog", { name: "导出明文 CSV？" }),
  ).toContainText("未经加密");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "洞察", exact: true }).click();
  await page.setViewportSize({width:375,height:812});
  const chart=page.locator(".flow");
  await expect(chart.locator("svg")).toHaveAttribute("viewBox",/^0 0 360 /);
  expect(await chart.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  const node = chart.locator("g[tabindex]").first();
  await node.focus();
  await expect(page.locator(".flow-readout")).toContainText("25.00");
});

test("whole-vault money graph, category highlight, isolate toggle and relation editing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资产", exact: true }).click();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByRole("button", { name: "金钱", exact: true }).click();
  await page.getByLabel("图谱筛选").click();
  await expect(page.getByLabel("聚焦资产")).toHaveValue("");
  await expect(page.locator(".graph-scene canvas")).toBeVisible();
  const total =
    (await page.getByLabel("聚焦资产").locator("option").count()) - 1;
  await expect(page.locator(".canvas-count")).toContainText(`${total} 个资产`);
  await page.getByLabel("图谱筛选").click();
  const category = page
    .locator(".canvas-legend")
    .getByRole("button", { name: "账号" });
  await category.click();
  await expect(category).toHaveAttribute("aria-pressed", "true");
  await category.click();
  await page.getByLabel("图谱筛选").click();
  await page.getByLabel("隐藏孤立节点").check();
  await expect(page.locator(".canvas-count")).not.toContainText(
    `${total} 个资产`,
  );
  await page.getByLabel("聚焦资产").selectOption("cloudflare-main");
  await page.getByLabel("图谱筛选").click();
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

test("375px: four destinations, shared month, settings subpages and sheets fit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  const fit = async () =>
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
  await expect(nav.getByRole("button")).toHaveText([
    "今日",
    "资产",
    "洞察",
    "我的",
  ]);
  await expect(page.getByLabel("账户筛选")).toHaveCount(0);
  await page.getByLabel("上个月").click();
  const month = await page.getByLabel("选择月份").inputValue();
  await page.getByLabel("本月概览，查看洞察").click();
  await expect(page.getByLabel("选择月份")).toHaveValue(month);
  await expect(
    page.getByRole("group", { name: "洞察视图" }).getByRole("button"),
  ).toHaveText(["回顾", "订阅", "投资", "项目"]);
  for (const tab of ["今日", "资产", "洞察", "我的"]) {
    await nav.getByRole("button", { name: tab }).click();
    await expect(
      page.getByRole("heading", { name: tab, exact: true }),
    ).toBeVisible();
    await fit();
    if (tab === "我的") break;
    await page.getByRole("button", { name: "快速记录", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "快速记录" });
    await expect(sheet.getByLabel("金额", { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "记资产", exact: true }).click();
    await expect(
      sheet.getByRole("button", { name: "手动填表单" }),
    ).toBeVisible();
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await fit();
    await sheet.getByLabel("关闭快速输入").click();
  }
  await expect(
    page.getByRole("button", { name: "快速记录", exact: true }),
  ).toBeHidden();
  await expect(page.getByLabel("接口地址")).toHaveCount(0);
  for (const title of [
    "官网账户",
    "资金账户与对账",
    "备份与导出",
    "AI 模型",
    "多端同步",
    "安全与锁屏",
    "应用更新",
  ]) {
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true, level: 1 }),
    ).toBeVisible();
    await fit();
    await page.getByRole("button", { name: "返回", exact: true }).click();
  }
});
