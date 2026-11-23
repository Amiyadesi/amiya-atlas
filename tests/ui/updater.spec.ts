import { expect, test } from "@playwright/test";

test("startup, dismissal and manual checks share one platform-aware result", async ({page}) => {
  const version = "1.0.0", filename = "Relakeep_1.0.0_linux-web.tar.gz";
  const mirrorUrl = "https://atlas.sayori.org/downloads/" + filename;
  const githubUrl = "https://github.com/Amiyadesi/amiya-atlas/releases/download/v1.0.0/" + filename;
  let checks = 0;
  await page.route("https://atlas.sayori.org/downloads/releases.json", route => {
    checks++;
    return route.fulfill({headers: {"Access-Control-Allow-Origin":"*"}, json: {version, releasedAt:"2026-11-23", notes:"测试发布",
      assets:{linuxWeb:{version, filename, mirrorUrl, githubUrl}}}});
  });
  await page.goto("/");
  const banner = page.getByRole("complementary", {name:"新版本提示"});
  await expect(banner).toContainText("v1.0.0");
  await banner.getByRole("button", {name:"查看详情"}).click();
  const panel = page.locator("#app-update");
  await expect(panel).toContainText("发现新版本 v1.0.0");
  await expect(panel.getByRole("button", {name:"GitHub 镜像加速下载"})).toBeVisible();
  expect(checks).toBe(1);

  await banner.getByRole("button", {name:"忽略此版本"}).click();
  await page.reload();
  await page.getByRole("button", {name:"打开命令面板"}).waitFor();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", {name:"搜索命令、记忆或账户"}).fill("检查应用更新");
  await page.getByRole("option", {name:/检查应用更新/}).click();
  await expect(panel).toContainText("测试发布");
  await expect(banner).toHaveCount(0);
  expect(checks).toBe(2);
});
