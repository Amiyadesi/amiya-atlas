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
  await page.getByRole("button", { name: "整理预览" }).click();
  await expect(
    page.getByRole("heading", { name: "我理解的是……" }),
  ).toBeVisible();
  await page.getByText("修改提案", { exact: true }).click();
  await page.getByLabel("Atlas test number monthly_cost").fill("not a number");
  await expect(page.getByRole("button", { name: "确认保存" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "稍后确认" })).toBeDisabled();
  await page.getByLabel("Atlas test number monthly_cost").fill("7");
  await page.screenshot({ path: "qa-artifacts/proposal.png", fullPage: true });
  await page.getByRole("button", { name: "稍后确认" }).click();
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page
    .getByRole("textbox", { name: "搜索记忆" })
    .fill("Atlas test number");
  await expect(
    page.getByText("没有找到相关记忆。", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "待确认", exact: true }).click();
  await page.getByRole("button", { name: "检查并确认" }).click();
  await page.getByText("修改提案", { exact: true }).click();
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
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索记忆" }).fill("美国");
  await expect(
    page.getByRole("button", { name: /Atlas test number/ }),
  ).toBeVisible();
  await page.route("http://127.0.0.1:11435/api/chat", (route) =>
    route.fulfill({ status: 500, body: "failure" }),
  );
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page
    .getByLabel("告诉 Atlas 一件事")
    .fill("这是一条应该保留的失败解析原文");
  await page.getByRole("button", { name: "整理预览" }).click();
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
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("button", { name: /Cloudflare Main/ }).click();
  await page.getByRole("button", { name: "探索关联" }).click();
  await page.getByLabel("从这里开始").selectOption("cloudflare-main");
  await expect(page.locator(".graph-node")).toHaveCount(2);
  await page.getByLabel("关系筛选").selectOption("Payment");
  await expect(page.locator(".graph-node")).toHaveCount(1);
  await page.setViewportSize({ width: 960, height: 850 });
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.getByRole("button", { name: "整理预览" })).toBeVisible();
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
  await page.getByRole("button", { name: "记忆", exact: true }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button", { name: /均衡 · 推荐/ })).toHaveClass(
    /chosen/,
  );
  await page.getByRole("button", { name: /轻量模型 Qwen3.5 2B/ }).click();
  await page.getByRole("button", { name: "保存模型设置" }).click();
  await expect(page.getByText("模型设置已保存")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /轻量模型 Qwen3.5 2B/ }),
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

test("saving original text skips the model, then shows progress before a separately confirmed proposal", async ({
  page,
}) => {
  let calls = 0;
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("http://127.0.0.1:11435/api/chat", async (route) => {
    calls++;
    await response;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ message: { content: JSON.stringify(proposal) } }),
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.goto("/");
  const before = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  await page.keyboard.press("Control+Shift+Space");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("告诉 Atlas 一件事").fill(raw);
  await dialog.getByRole("button", { name: "先存原文" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".inbox-item")).toContainText(raw);
  await expect(page.getByRole("button", { name: "开始整理" })).toBeEnabled();
  const saved = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  expect(calls).toBe(0);
  expect(saved.entities).toEqual(before.entities);
  expect(saved.relations).toEqual(before.relations);
  expect(saved.events).toEqual(before.events);
  expect(saved.captures).toHaveLength((before.captures?.length ?? 0) + 1);
  expect(saved.captures.at(-1)).toMatchObject({
    rawText: raw,
    status: "PENDING",
  });
  await page.getByRole("button", { name: "开始整理" }).click();
  await expect(
    page.getByRole("status", { name: "" }).filter({ hasText: "正在整理" }),
  ).toBeVisible();
  await expect.poll(() => calls).toBe(1);
  release();
  await expect(
    page.getByRole("heading", { name: "我理解的是……" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "确认保存" })).toBeInViewport();
  const staged = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  expect(staged.entities).toEqual(before.entities);
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(
    page.getByRole("heading", { name: "Atlas test number" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "撤销这次变更" }),
  ).toBeVisible();
});

test("memory search stays local on Enter and keeps natural language and filters while browsing", async ({
  page,
}) => {
  let calls = 0;
  await page.route("http://127.0.0.1:11435/api/chat", async (route) => {
    calls++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        message: { content: JSON.stringify({ search: "", region: "US" }) },
      }),
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  const search = page.getByRole("textbox", { name: "搜索记忆" });
  await search.fill("Saily");
  await search.press("Enter");
  await expect(page.getByRole("button", { name: /Saily \+1/ })).toBeVisible();
  await page.getByRole("button", { name: /Saily \+1/ }).click();
  await page.getByRole("button", { name: "返回记忆列表" }).click();
  await expect(search).toHaveValue("Saily");
  expect(calls).toBe(0);
  const question = "我有哪些美国的东西？";
  await search.fill(question);
  await page.getByRole("button", { name: "理解问题" }).click();
  await expect(page.locator(".search-interpretation")).toContainText("地区 US");
  await expect(search).toHaveValue(question);
  expect(calls).toBe(1);
  await page.getByRole("button", { name: /Saily \+1/ }).click();
  await page.getByRole("button", { name: "探索关联" }).click();
  await expect(
    page.getByRole("button", { name: "记忆", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "返回记忆详情" }).click();
  await page.getByRole("button", { name: "返回记忆列表" }).click();
  await expect(search).toHaveValue(question);
  await expect(page.locator(".search-interpretation")).toContainText("地区 US");
  await page.getByRole("button", { name: "清除搜索" }).click();
  await expect(search).toHaveValue("");
  await expect(page.locator(".search-interpretation")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Cloudflare Main/ }),
  ).toBeVisible();
});

test("a late interpretation never replaces a newer keyword search", async ({
  page,
}) => {
  let calls = 0;
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("http://127.0.0.1:11435/api/chat", async (route) => {
    calls++;
    await response;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        message: { content: JSON.stringify({ search: "", region: "JP" }) },
      }),
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  const search = page.getByRole("textbox", { name: "搜索记忆" });
  await search.fill("我有哪些日本的东西？");
  await page.getByRole("button", { name: "理解问题" }).click();
  await expect.poll(() => calls).toBe(1);
  await search.fill("Saily");
  release();
  await expect(page.getByRole("button", { name: "理解问题" })).toBeEnabled();
  await expect(search).toHaveValue("Saily");
  await expect(page.locator(".search-interpretation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Saily \+1/ })).toBeVisible();
});
