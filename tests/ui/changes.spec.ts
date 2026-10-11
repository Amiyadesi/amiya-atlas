import { test, expect } from "@playwright/test";
const empty = () => ({
  entitiesToCreate: [] as unknown[],
  entitiesToUpdate: [] as unknown[],
  relationsToCreate: [],
  eventsToCreate: [],
  uncertainty: [],
});

test("a rejected stale deletion refreshes its diff and retries against new relationships", async ({
  page,
}) => {
  const text = "从 Atlas 删除 Saily。";
  let requests = 0;
  await page.route("http://127.0.0.1:11435/api/chat", (route) => {
    requests++;
    return route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        message: {
          content: JSON.stringify({
            ...empty(),
            entitiesToDelete: [{ id: "sim-saily" }],
          }),
        },
      }),
    });
  });
  await page.goto("/");
  await page.getByLabel("告诉 Atlas 一件事").fill(text);
  await page.getByRole("button", { name: "整理预览" }).click();
  await expect(page.getByLabel("－ 删除记忆：Saily +1")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    const api = await import(path);
    const snapshot = await api.loadSnapshot();
    snapshot.relations.push({
      id: "new-recovery",
      sourceId: "service-reddit",
      targetId: "sim-saily",
      type: "RECOVERS_WITH",
      privacy: "PRIVATE",
      createdAt: new Date().toISOString(),
    });
    await api.saveSnapshot(snapshot);
  });
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(page.getByRole("button", { name: "重新理解" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认保存" })).toBeDisabled();
  await page.getByRole("button", { name: "重新理解" }).click();
  await expect(page.getByRole("button", { name: "确认保存" })).toBeEnabled();
  await expect(page.getByLabel("记忆变更预览")).toContainText(
    "Reddit Main → Saily +1 US number",
  );
  expect(requests).toBe(2);
  await page.getByRole("button", { name: "确认保存" }).click();
  const after = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  expect(after.entities.some((e: { id: string }) => e.id === "sim-saily")).toBe(
    false,
  );
  expect(
    after.relations.some((r: { id: string }) => r.id === "new-recovery"),
  ).toBe(false);
  expect(
    after.entities.some((e: { id: string }) => e.id === "service-reddit"),
  ).toBe(true);
});

test("mixed changes disclose cascades, require confirmation, and undo can return to review and cancel only deletion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const text = "从 Atlas 删除 sayori.org，然后新增 3HK 香港备用号码。";
  const proposal = {
    ...empty(),
    entitiesToCreate: [
      {
        ref: "new",
        name: "3HK",
        type: "Phone / SIM",
        status: "ACTIVE",
        attributes: { region: "HK", roles: ["备用"] },
        notes: "",
      },
    ],
    entitiesToDelete: [{ id: "domain-sayori" }],
    eventsToDelete: [{ id: "event-3" }],
  };
  await page.route("http://127.0.0.1:11435/api/chat", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ message: { content: JSON.stringify(proposal) } }),
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.goto("/");
  await page.getByLabel("告诉 Atlas 一件事").fill(text);
  await page.getByRole("button", { name: "整理预览" }).click();
  const diff = page.getByLabel("记忆变更预览");
  await expect(diff).toContainText("＋ 新增记忆");
  await expect(diff.locator(".diff-deletion")).toHaveCount(3);
  await expect(diff).toContainText("Cloudflare Main → sayori.org");
  await expect(diff).toContainText("随这项记忆一起移除");
  const before = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  expect(
    before.entities.some((e: { id: string }) => e.id === "domain-sayori"),
  ).toBe(true);
  expect(before.entities.some((e: { name: string }) => e.name === "3HK")).toBe(
    false,
  );
  await page.setViewportSize({ width: 960, height: 850 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "qa-artifacts/change-diff.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认保存" }).click();
  const committed = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  expect(
    committed.entities.some((e: { id: string }) => e.id === "domain-sayori"),
  ).toBe(false);
  expect(
    committed.relations.some(
      (r: { targetId: string }) => r.targetId === "domain-sayori",
    ),
  ).toBe(false);
  expect(
    committed.events.some(
      (e: { entityId: string }) => e.entityId === "domain-sayori",
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "撤销这次变更" }).click();
  await expect(diff.locator(".diff-deletion")).toHaveCount(3);
  const restored = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  expect(
    restored.entities.find((e: { id: string }) => e.id === "domain-sayori"),
  ).toEqual(
    before.entities.find((e: { id: string }) => e.id === "domain-sayori"),
  );
  expect(
    restored.entities.some((e: { name: string }) => e.name === "3HK"),
  ).toBe(false);
  await diff
    .getByRole("button", { name: "取消sayori.org的－ 删除变更" })
    .click();
  await expect(diff.locator(".diff-deletion")).toHaveCount(0);
  await page.getByRole("button", { name: "确认保存" }).click();
  const final = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  expect(
    final.entities.some((e: { id: string }) => e.id === "domain-sayori"),
  ).toBe(true);
  expect(final.entities.some((e: { name: string }) => e.name === "3HK")).toBe(
    true,
  );
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  expect(final.events.sort(byId)).toEqual(before.events.sort(byId));
  expect(final.relations.sort(byId)).toEqual(before.relations.sort(byId));
  expect(errors).toEqual([]);
});

test("retiring a number displays the state diff and keeps its graph and original fields", async ({
  page,
}) => {
  const text = "Saily 不用了，改用 3HK 香港备用号码。";
  const proposal = {
    ...empty(),
    entitiesToCreate: [
      {
        ref: "new",
        name: "3HK",
        type: "Phone / SIM",
        status: "ACTIVE",
        attributes: { region: "HK" },
        notes: "",
      },
    ],
    entitiesToUpdate: [
      {
        id: "sim-saily",
        name: "Saily +1 US number",
        type: "Phone / SIM",
        status: "INACTIVE",
        attributes: {},
        notes: "",
      },
    ],
  };
  await page.route("http://127.0.0.1:11435/api/chat", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ message: { content: JSON.stringify(proposal) } }),
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.goto("/");
  await page.getByLabel("告诉 Atlas 一件事").fill(text);
  await page.getByRole("button", { name: "整理预览" }).click();
  const diff = page.getByLabel("记忆变更预览");
  await expect(diff).toContainText("使用中");
  await expect(diff).toContainText("已停用");
  await expect(diff.locator(".diff-deletion")).toHaveCount(0);
  await page.screenshot({
    path: "qa-artifacts/retirement-diff.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认保存" }).click();
  const saved = await page.evaluate(async () => {
    const path = "/src/lib/api.ts";
    return (await import(path)).loadSnapshot();
  });
  const sim = saved.entities.find((e: { id: string }) => e.id === "sim-saily");
  expect(sim.status).toBe("INACTIVE");
  expect(
    sim.fields.find((f: { key: string }) => f.key === "carrier").value,
  ).toBe("Saily");
  expect(
    saved.events.some((e: { entityId: string }) => e.entityId === sim.id),
  ).toBe(true);
});
