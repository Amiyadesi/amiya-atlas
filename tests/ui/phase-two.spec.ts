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
  await page.getByRole("button", { name: "资产", exact: true }).click();
  await page.getByRole("button", { name: "导入数据", exact: true }).click();
  await dialog.getByLabel("选择导入文件").setInputFiles(file);
  await expect(dialog).toContainText("+0 资产 · +0 关联");
  await expect(dialog.getByRole("button", { name: "确认导入" })).toBeDisabled();
});
test("confirm two expenses on Home, undo, then use the Ledger drawer and monthly review", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  const line = page.getByRole("textbox", { name: "一句话记账" });
  await line.fill("午饭 22.5 微信，打车 14");
  await expect(page.getByLabel("入账预览")).toContainText("22.50");
  await page.getByRole("button", { name: "调整", exact: true }).click();
  await expect(page.getByLabel("确认金额")).toHaveCount(2);
  await page.getByLabel("确认金额").first().fill("23.50");
  await page.getByRole("button", { name: "直接入账", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今日", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销入账" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "冲正分录" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  await line.fill("咖啡 18 微信");
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
  await page.getByLabel("关闭快速输入").click();
  await page.getByRole("button", { name: "洞察", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "每日支出趋势柱状图" }),
  ).toBeVisible();
  await expect(page.locator(".charts .rank").first()).toContainText("36.00");
});
test("bill selection imports optional subscriptions and skips duplicate orders", async ({
  page,
}) => {
  await page.goto("/");
  const file = {
    name: "wechat.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "微信支付账单明细\n交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号\n2026-08-08 12:00:00,商户消费,Netflix,订阅,支出,66.00,零钱,支付成功,test-order",
    ),
  };
  const dialog = page.getByRole("dialog", { name: "数据导入中心" });
  await page.getByLabel("更多操作").click();
  await page.getByRole("button", { name: "导入账单" }).click();
  await dialog.getByLabel("选择导入文件").setInputFiles(file);
  await dialog.getByRole("checkbox", { name: /Netflix · CNY/ }).check();
  await expect(dialog).toContainText("+1 笔流水 · 跳过 0 条重复 · +1 项订阅");
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await page.getByLabel("更多操作").click();
  await page.getByRole("button", { name: "导入账单" }).click();
  await dialog.getByLabel("选择导入文件").setInputFiles(file);
  await expect(dialog).toContainText("+0 笔流水 · 跳过 1 条重复");
});

test("empty mobile vault shows zeroes; account and billing controls live one level down", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    sessionStorage.setItem("relakeep-access", "test");
    localStorage.setItem(
      "relakeep:update-prefs",
      JSON.stringify({ autoCheck: false }),
    );
  });
  await page.route("/", async (route) => {
    const source = await route.fetch();
    await route.fulfill({
      response: source,
      body: (await source.text()).replace(
        "<html ",
        "<html data-relakeep-host ",
      ),
    });
  });
  await page.route("**/api/invoke", async (route) => {
    const { command, args } = route.request().postDataJSON();
    const replies: Record<string, unknown> = {
      vault_status: { exists: true, unlocked: true },
      load_snapshot: { revision: 0, entities: [], relations: [], events: [] },
      sync_status: { configured: true, automatic: false, conflicts: [] },
      voice_status: { supported: false, ready: false },
      cloud_status: { connected: true, email: "test@example.invalid" },
    };
    const cloud: Record<string, unknown> = {
      "/api/features": { cloud: true, billing: true },
      "/api/account/balance": {
        unlimited: true,
        total: 0,
        monthly: 0,
        topup: 0,
        selectedModel: "a",
        canChooseModels: true,
        models: [{ id: "a", name: "测试模型" }],
      },
    };
    const data =
      command === "cloud_request" ? cloud[args.path] : replies[command];
    if (data === undefined) throw new Error("Unexpected IPC: " + command);
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto("/");
  await expect(page.locator(".hero-amount")).toHaveText("¥0.00");
  await expect(page.locator(".pending-pill")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /从 Bitwarden/ }),
  ).toBeVisible();
  await page.getByLabel("关闭起步引导").click();
  await expect(page.getByRole("button", { name: /从 Bitwarden/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "我的", exact: true }).click();
  const profile = page.getByRole("button", { name: /test@example.invalid/ });
  await expect(profile).toContainText("不限次数");
  await expect(page.getByRole("button", { name: /月套餐/ })).toHaveCount(0);
  await profile.click();
  await expect(page.getByLabel("云模型")).toHaveValue("a");
  await expect(
    page.getByRole("button", { name: "管理订阅 / 付款" }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(profile).toBeVisible();
});
