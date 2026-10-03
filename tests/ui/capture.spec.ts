import { test, expect } from "@playwright/test";
const raw = "Atlas test number 是我的美国备用号码，每月六元，目前保留。";
const proposal = {
  entitiesToCreate: [
    {
      ref: "number",
      name: "Atlas test number",
      type: "Phone / SIM",
      status: "ACTIVE",
      attributes: {
        region: "US",
        monthly_cost: 6,
        currency: "CNY",
        decision: "Keep",
      },
      notes: "备用号码",
      evidence: raw,
    },
  ],
  entitiesToUpdate: [],
  relationsToCreate: [],
  eventsToCreate: [],
  uncertainty: [],
};
test("capture proposal can be corrected, saved, searched and explored; failed parse keeps original", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://127.0.0.1:11435/api/chat", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ message: { content: JSON.stringify(proposal) } }),
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "今天要告诉 Atlas 什么？" }),
  ).toBeVisible();
  await page.screenshot({ path: "qa-artifacts/home.png", fullPage: true });
  await page.getByLabel("告诉 Atlas 一件事").fill(raw);
  await page.getByRole("button", { name: "帮我记住" }).click();
  await expect(
    page.getByRole("heading", { name: "我理解的是……" }),
  ).toBeVisible();
  await page.getByLabel("Atlas test number monthly_cost").fill("not a number");
  await expect(page.getByRole("button", { name: "确认保存" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "稍后确认" })).toBeDisabled();
  await page.getByLabel("Atlas test number monthly_cost").fill("7");
  await page.screenshot({ path: "qa-artifacts/proposal.png", fullPage: true });
  await page.getByRole("button", { name: "稍后确认" }).click();
  await page.getByRole("button", { name: "记忆 Memory" }).click();
  await page
    .getByRole("textbox", { name: "搜索记忆" })
    .fill("Atlas test number");
  await expect(
    page.getByText("没有找到相关记忆。", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "待确认 Inbox" }).click();
  await page.getByRole("button", { name: "检查并确认" }).click();
  await expect(page.getByLabel("Atlas test number monthly_cost")).toHaveValue(
    "7",
  );
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(
    page.getByRole("heading", { name: "Atlas test number" }),
  ).toBeVisible();
  await expect(page.locator("dd", { hasText: /^7$/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "当时你说的是" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "探索关联" }).click();
  await expect(page.locator(".graph-node")).toHaveCount(1);
  await page.screenshot({ path: "qa-artifacts/graph.png", fullPage: true });
  await page.getByRole("button", { name: "搜索 Search" }).click();
  await page.getByRole("textbox", { name: "搜索记忆" }).fill("美国");
  await expect(
    page.getByRole("button", { name: /Atlas test number/ }),
  ).toBeVisible();
  await page.route("http://127.0.0.1:11435/api/chat", (route) =>
    route.fulfill({ status: 500, body: "failure" }),
  );
  await page.getByRole("button", { name: "首页 Home" }).click();
  await page
    .getByLabel("告诉 Atlas 一件事")
    .fill("这是一条应该保留的失败解析原文");
  await page.getByRole("button", { name: "帮我记住" }).click();
  await expect(page.getByRole("alert")).toContainText("原文已保留");
  await expect(page.locator(".inbox-item")).toContainText(
    "这是一条应该保留的失败解析原文",
  );
  expect(errors).toEqual([]);
});
test("one-hop graph filters and narrow layout remain usable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "探索 Explore" }).click();
  await page.getByLabel("从这里开始").selectOption("cloudflare-main");
  await expect(page.locator(".graph-node")).toHaveCount(2);
  await page.getByLabel("关系筛选").selectOption("Payment");
  await expect(page.locator(".graph-node")).toHaveCount(1);
  await page.setViewportSize({ width: 960, height: 850 });
  await page.getByRole("button", { name: "首页 Home" }).click();
  await expect(page.getByRole("button", { name: "帮我记住" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("quick capture keeps the draft, reads clipboard on demand, and submits only a proposal", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let calls = 0;
  await page.route("http://127.0.0.1:11435/api/chat", (route) => {
    calls++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ message: { content: JSON.stringify(proposal) } }),
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.goto("/");
  await page.getByLabel("告诉 Atlas 一件事").fill("还没说完的草稿");
  await page.keyboard.press("Control+Shift+Space");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("告诉 Atlas 一件事")).toHaveValue(
    "还没说完的草稿",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("告诉 Atlas 一件事")).toHaveValue(
    "还没说完的草稿",
  );
  expect(calls).toBe(0);
  await page.getByLabel("告诉 Atlas 一件事").fill("");
  await page.evaluate((text) => navigator.clipboard.writeText(text), raw);
  await page.keyboard.press("Control+Alt+V");
  await expect(dialog.getByLabel("告诉 Atlas 一件事")).toHaveValue(raw);
  expect(calls).toBe(0);
  await page.screenshot({
    path: "qa-artifacts/quick-capture.png",
    fullPage: true,
  });
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "我理解的是……" }),
  ).toBeVisible();
  expect(calls).toBe(1);
  await page.getByRole("button", { name: "记忆 Memory" }).click();
  await page
    .getByRole("textbox", { name: "搜索记忆" })
    .fill("Atlas test number");
  await expect(
    page.getByText("没有找到相关记忆。", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "锁定记忆库" }).click();
  await page.keyboard.press("Control+Alt+R");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("先解锁");
});

test("model profiles and browser voice availability are clear", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置 Settings" }).click();
  await expect(page.getByRole("button", { name: /均衡 · 推荐/ })).toHaveClass(
    /chosen/,
  );
  await page.getByRole("button", { name: /更大模型 Qwen3.5 4B/ }).click();
  await page.getByRole("button", { name: "保存模型设置" }).click();
  await expect(page.getByText("模型设置已保存")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /更大模型 Qwen3.5 4B/ }),
  ).toHaveClass(/chosen/);
  await expect(
    page.getByRole("button", { name: "下载并准备语音模型" }),
  ).toBeDisabled();
  await expect(page.locator("#voice-settings")).toContainText(
    "Whisper Small Q5_1",
  );
  await page.setViewportSize({ width: 960, height: 850 });
  await page.screenshot({ path: "qa-artifacts/settings.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
