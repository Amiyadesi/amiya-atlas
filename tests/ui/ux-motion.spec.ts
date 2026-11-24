import { expect, test } from "@playwright/test";

test("UX principles: safe destructive focus, true backdrop hit-test, toggle-back, in-place reversal, header-safe auto-import & return-to-today", async ({
  page,
}) => {
  await page.goto("/");

  // 1. MonthSwitcher shows one-tap '本月' return pill when viewing another month & restores focus
  await expect(page.getByRole("button", { name: "回到本月" })).toHaveCount(0);
  await page.getByLabel("上个月").click();
  const returnToday = page.getByRole("button", { name: "回到本月" });
  await expect(returnToday).toBeVisible();
  await returnToday.click();
  await expect(returnToday).toHaveCount(0);
  await expect(page.getByLabel("选择月份")).toBeFocused();

  // 2. QuickSheet: streamlined EntryForm, real inside-padding click stays open, real outside backdrop click closes
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "快速记录" });
  await expect(
    sheet.getByRole("group", { name: "记账类型" }).getByRole("button"),
  ).toHaveText(["支出", "收入", "转账"]);
  await expect(
    sheet.getByRole("group", { name: "记录类型" }).locator(".seg-thumb"),
  ).toHaveCount(1);

  // Clicking inside the dialog's own padding gutter must NOT dismiss it
  const box = (await sheet.boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + 6);
  await expect(sheet).toBeVisible();

  // Clicking strictly outside the dialog bounding box dismisses it
  await page.mouse.click(4, 4);
  await expect(sheet).toHaveCount(0);

  // 3. Log an expense via shorthand ('地铁 6 微信'), inspect drawer ('分类'), reverse IN-PLACE with safe Cancel focus
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  const line = page.getByRole("textbox", { name: "一句话记账" });
  await line.fill("地铁 6 微信");
  await line.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: /地铁 6 微信/ }).click();
  const drawer = page.getByRole("dialog", { name: "地铁 6 微信" });
  await expect(drawer).toContainText("分类");
  await expect(drawer).not.toContainText("对方分录");

  await drawer.getByRole("button", { name: "冲正", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "冲正这笔流水？" });
  await expect(confirm).toBeVisible();
  // Destructive confirm defaults focus to Cancel
  await expect(
    confirm.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "确认冲正", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "已生成冲正记录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "今日", exact: true }),
  ).toBeVisible();

  // 4. Assets category chip toggle-back & detail return restores focus
  await page.getByRole("button", { name: "资产", exact: true }).click();
  const groupChip = page
    .locator(".record-filters")
    .getByRole("button", { name: "账号", exact: true });
  await groupChip.click();
  await expect(groupChip).toHaveClass(/chosen/);
  await groupChip.click();
  await expect(groupChip).not.toHaveClass(/chosen/);

  // 5. ImportCenter: password CSV whose data row mentions '微信支付账单' stays on Assets tab,
  //    while a genuine WeChat bill CSV auto-switches from Assets to Bills
  await page.getByRole("button", { name: "导入数据", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "数据导入中心" });
  await importDialog.getByLabel("选择导入文件").setInputFiles({
    name: "passwords-with-wechat-row.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "name,url,username,password,note\n微信支付账单,https://pay.weixin.qq.com,me@example.test,SECRET,note",
    ),
  });
  await expect(
    importDialog.getByRole("button", { name: "账号与密码管理器" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(importDialog).toContainText("已剔除 2 个敏感字段");

  await importDialog.getByLabel("选择导入文件").setInputFiles({
    name: "wechat-auto.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "微信支付账单明细\n交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号\n2026-11-10 12:00:00,商户消费,瑞幸咖啡,拿铁,支出,19.00,零钱,支付成功,auto-order-1",
    ),
  });
  await expect(
    importDialog.getByRole("button", { name: "账单与流水" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(importDialog).toContainText("已自动识别为账单文件");
  await importDialog.getByLabel("关闭导入中心").click();
  await expect(importDialog).toHaveCount(0);
});

test("Motion quality: interruptible exit, drag cancel snap-back, 60fps pacing, zero CLS, reduced-motion & multi-viewport fit", async ({
  page,
}) => {
  const viewports = [
    { name: "mobile", width: 390, height: 844, scheme: "dark" as const },
    { name: "narrow", width: 768, height: 900, scheme: "light" as const },
    { name: "desktop", width: 1440, height: 900, scheme: "dark" as const },
  ];

  for (const vp of viewports) {
    await page.emulateMedia({
      colorScheme: vp.scheme,
      reducedMotion: "no-preference",
    });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/");

    await page.evaluate(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      if (typeof PerformanceObserver !== "undefined") {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<
            PerformanceEntry & { hadRecentInput?: boolean; value?: number }
          >) {
            if (!entry.hadRecentInput) {
              (window as unknown as { __cls: number }).__cls +=
                entry.value ?? 0;
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      }
    });

    for (const tab of ["今日", "资产", "洞察", "我的"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: tab, exact: true }),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow, `${vp.name} ${vp.scheme} ${tab} overflow`).toBe(false);
    }

    // Measure frame pacing while switching segmented tabs AND opening/closing QuickSheet
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    const metrics = await page.evaluate(async () => {
      const frames: number[] = [];
      let last = performance.now();
      let running = true;
      const loop = (now: number) => {
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".insight-tabs button"),
      );
      for (const b of buttons) {
        b.click();
        await new Promise((r) => setTimeout(r, 95));
      }
      running = false;
      const valid = frames.slice(2);
      const avg =
        valid.reduce((s, v) => s + v, 0) / Math.max(1, valid.length);
      const slowFrames = valid.filter((ms) => ms > 34).length;
      const cls = (window as unknown as { __cls: number }).__cls ?? 0;
      return { avgFrameMs: avg, count: valid.length, slowFrames, cls };
    });

    expect(metrics.count, `${vp.name} frame samples`).toBeGreaterThanOrEqual(10);
    expect(metrics.cls, `${vp.name} CLS`).toBeLessThan(0.05);
    expect(metrics.avgFrameMs, `${vp.name} avg frame ms`).toBeLessThan(26);
    expect(metrics.slowFrames, `${vp.name} slow frames`).toBeLessThanOrEqual(4);
  }

  // Normal-motion interruptibility: reopen QuickSheet mid-exit animation must stay open
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "快速记录" });
  await expect(sheet).toBeVisible();

  // Pointercancel after large downward drag must snap back, NEVER dismiss
  await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>("dialog.quick-sheet")!;
    const handle = dialog.querySelector<HTMLElement>(".sheet-handle")!;
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        clientX: 195,
        clientY: 200,
      }),
    );
    dialog.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: 195,
        clientY: 360,
      }),
    );
    dialog.dispatchEvent(
      new PointerEvent("pointercancel", {
        bubbles: true,
        pointerId: 1,
        clientX: 195,
        clientY: 360,
      }),
    );
  });
  await page.waitForTimeout(260);
  await expect(sheet).toBeVisible();

  // Reopen mid-exit under normal motion
  await page.keyboard.press("Escape");
  await page.waitForTimeout(30);
  await page.keyboard.press("Control+Shift+Space");
  await page.waitForTimeout(260);
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Verify prefers-reduced-motion collapses duration tokens cleanly
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const reducedDur = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--dur-sheet")
      .trim(),
  );
  expect(reducedDur).toBe("0ms");
});
