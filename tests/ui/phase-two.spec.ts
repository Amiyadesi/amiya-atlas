import { expect, test } from "@playwright/test";

test("local password import previews only metadata; repeat import adds nothing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "打开命令面板" }).click();
  await page
    .getByRole("combobox", { name: "搜索命令、记忆或账户" })
    .fill("导入数据");
  await page.getByRole("option", { name: /导入数据/ }).click();
  const dialog = page.getByRole("dialog", { name: "数据导入中心" });
  const file = {
    name: "logins.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "name,url,username,password,note\nWorkshop,https://workshop.test,hello@workshop.test,DO_NOT_STORE,PRIVATE_NOTE",
    ),
  };
  await dialog.getByLabel("选择导入文件").setInputFiles(file);
  await expect(dialog).toContainText("已剔除 2 个敏感字段");
  await expect(dialog).not.toContainText("DO_NOT_STORE");
  await expect(dialog).toContainText("+2 资产 · +1 关联");
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("button", { name: "导入数据", exact: true }).click();
  await dialog.getByLabel("选择导入文件").setInputFiles(file);
  await expect(dialog).toContainText("+0 资产 · +0 关联");
  await expect(dialog.getByRole("button", { name: "确认导入" })).toBeDisabled();
});
test("confirm two expenses on Home, undo, then use the Ledger drawer and monthly review", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "快速记一笔", exact: true }).click();
  const line = page.getByRole("textbox", { name: "一句话记账" });
  await line.fill("午饭 22.5 微信，打车 14");
  await line.press("Enter");
  await expect(page.getByLabel("确认金额")).toHaveCount(2);
  await page.getByLabel("确认金额").first().fill("23.50");
  await page.getByRole("button", { name: "直接入账", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "随手记", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销入账" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "冲正分录" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "账本", exact: true }).click();
  await line.fill("咖啡 18 微信");
  await line.press("Enter");
  await line.press("Enter");
  await page.getByRole("button", { name: /咖啡 18 微信/ }).click();
  const drawer = page.getByRole("dialog", { name: "咖啡 18 微信" });
  await drawer.getByText(/复式分录/).click();
  await expect(drawer.locator(".leg")).toHaveCount(2);
  await drawer.getByRole("button", { name: "再来一笔" }).click();
  await expect(
    page.getByRole("textbox", { name: "金额", exact: true }),
  ).toHaveValue("18.00");
  await page.getByRole("button", { name: "保存并再记一笔" }).click();
  await expect(
    page.getByRole("textbox", { name: "金额", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "金额", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "回顾", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "每日支出趋势柱状图" }),
  ).toBeVisible();
  await expect(page.locator(".charts .rank").first()).toContainText("36.00");
});
test("bill selection imports optional subscriptions and skips duplicate orders", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "账本", exact: true }).click();
  const file = {
    name: "wechat.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "微信支付账单明细\n交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号\n2026-08-08 12:00:00,商户消费,Netflix,订阅,支出,66.00,零钱,支付成功,test-order",
    ),
  };
  const dialog = page.getByRole("dialog", { name: "数据导入中心" });
  await page.getByRole("button", { name: "导入账单" }).click();
  await dialog.getByLabel("选择导入文件").setInputFiles(file);
  await dialog.getByRole("checkbox", { name: /Netflix · CNY/ }).check();
  await expect(dialog).toContainText("+1 笔流水 · 跳过 0 条重复 · +1 项订阅");
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await page.getByRole("button", { name: "导入账单" }).click();
  await dialog.getByLabel("选择导入文件").setInputFiles(file);
  await expect(dialog).toContainText("+0 笔流水 · 跳过 1 条重复");
});
