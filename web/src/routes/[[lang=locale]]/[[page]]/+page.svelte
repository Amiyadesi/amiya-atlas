<script lang="ts">
  import ProductPreview from "$lib/ProductPreview.svelte";
  import SiteIcon from "$lib/SiteIcon.svelte";
  import "$lib/site.css";
  import { onMount } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { auth, api, type Balance, type Features } from "$lib/client";
  let { data } = $props<{ data: { page: string; en: boolean } }>();
  const t = (zh: string, en: string) => (data.en ? en : zh);
  const href = (page = "") =>
    `${data.en ? "/en" : ""}/${page}`.replace(/\/$/, "") || "/";
  const themeCycle = { system: "light", light: "dark", dark: "system" } as const;
  type Theme = keyof typeof themeCycle;
  let theme = $state<Theme>("system");
  const themeName = (mode: Theme) => ({ system: t("跟随系统", "System"), light: t("浅色", "Light"), dark: t("暗色", "Dark") })[mode];
  let themeLabel = $derived(t(`主题：${themeName(theme)}。切换为${themeName(themeCycle[theme])}`, `Theme: ${themeName(theme)}. Switch to ${themeName(themeCycle[theme])}`));
  onMount(() => {
    const value = document.documentElement.dataset.theme;
    if (value === "light" || value === "dark") theme = value;
  });
  function cycleTheme() {
    theme = themeCycle[theme];
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("relakeep:web-theme", theme);
    } catch { /* Keep the choice for this visit when storage is unavailable. */ }
  }
  let features = $state<Features | null>(null);
  let user = $state<{ id: string; email: string; name: string } | null>(null);
  let linkedProviders = $state<string[]>([]);
  let balance = $state<Balance | null>(null);
  let purchases = $state<
    Array<{
      id: string;
      kind: string;
      original: number;
      remaining: number;
      created_at: number;
      revoked: number;
    }>
  >([]);
  let email = $state(""),
    otp = $state(""),
    code = $state(""),
    sent = $state(false),
    busy = $state(false),
    message = $state("");
  let emailError = $state("");
  let currency = $state<"cny" | "hkd" | "usd">("cny");
  let verified = $state(false),
    approved = $state(false);
  let next = $state("/account");
  const checkoutIds = new Map<string, string>();
  const price = () =>
    ({ cny: "¥20", hkd: "HK$23.50", usd: "US$2.99" })[currency];
  const title = () =>
    ({
      home: t(
        "理清资产关联与日常收支",
        "Connected assets and everyday bookkeeping",
      ),
      pricing: t("价格", "Pricing"),
      download: t("下载络笺", "Download Relakeep"),
      guide: t("使用教程", "User guide"),
      login: t("登录", "Sign in"),
      account: t("账户", "Account"),
      device: t("连接桌面应用", "Connect your desktop app"),
      success: t("正在确认付款", "Confirming your payment"),
      privacy: t("隐私说明", "Privacy"),
      refunds: t("退款与订阅说明", "Refunds and subscriptions"),
    })[data.page as "home"] ?? "Relakeep";
  async function refresh() {
    const session = await auth.getSession();
    if (session.error)
      throw new Error(t("登录状态读取失败", "Could not read your session"));
    user = session.data?.user ?? null;
    if (user && data.page === "account") {
      const accounts = await auth.listAccounts();
      assertResult(accounts);
      linkedProviders = accounts.data?.map(account => account.providerId) ?? [];
    } else linkedProviders = [];
    if (user && ["account", "success", "pricing"].includes(data.page)) {
      balance = await api<Balance>("/account/balance");
      purchases = await api("/account/purchases");
    }
  }
  async function act(task: () => Promise<void>) {
    busy = true;
    message = "";
    try {
      await task();
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : t("操作失败", "Request failed");
    } finally {
      busy = false;
    }
  }
  const assertResult = (result: {
    error?: { message?: string; error_description?: string } | null;
  }) => {
    if (result.error)
      throw new Error(
        result.error.message ??
          result.error.error_description ??
          "Request failed",
      );
  };
  async function sendOtp() {
    emailError = "";
    email = email.trim().toLowerCase();
    if (!features?.emailDomains.includes(email.split('@')[1] ?? '')) {
      emailError = t("该邮箱暂不支持，请使用 Gmail、Outlook、QQ、163 等常见邮箱。", "This email provider is not supported. Try Gmail, Outlook, Yahoo or Proton.");
      return;
    }
    await act(async () => {
      assertResult(
        await auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" }),
      );
      sent = true;
    });
  }
  async function login() {
    await act(async () => {
      assertResult(await auth.signIn.emailOtp({ email, otp }));
      window.location.assign(next);
    });
  }
  async function social(provider: "github" | "google", link = false) {
    await act(async () => {
      const callbackURL =
        window.location.origin + (link ? href("account") : next);
      assertResult(
        await (link
          ? auth.linkSocial({ provider, callbackURL })
          : auth.signIn.social({ provider, callbackURL })),
      );
    });
  }
  async function purchase(kind: "monthly" | "topup") {
    if (!user) {
      window.location.assign(
        href("login") + "?next=" + encodeURIComponent(href("pricing")),
      );
      return;
    }
    await act(async () => {
      const key = kind + ":" + currency;
      const requestId = checkoutIds.get(key) ?? crypto.randomUUID();
      checkoutIds.set(key, requestId);
      try {
        const { url } = await api<{ url: string }>("/account/checkout", {
          kind,
          currency,
          requestId,
        });
        if (new URL(url).hostname !== "checkout.stripe.com")
          throw new Error("Unexpected checkout destination");
        window.location.assign(url);
      } catch (error) {
        if (
          [
            "CHECKOUT_EXPIRED",
            "CHECKOUT_ALREADY_COMPLETED",
            "SUBSCRIPTION_EXISTS",
            "SUBSCRIPTION_CHECKOUT_PENDING",
          ].includes((error as { code?: string }).code ?? "")
        )
          checkoutIds.delete(key);
        throw error;
      }
    });
  }
  async function portal() {
    await act(async () => {
      const { url } = await api<{ url: string }>("/account/portal", {});
      if (new URL(url).hostname !== "billing.stripe.com")
        throw new Error("Unexpected portal destination");
      window.location.assign(url);
    });
  }
  async function selectModel(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const model = select.value;
    await act(async () => {
      try {
        balance = await api<Balance>("/account/model", { model });
        message = t("已保存，软件下次云请求生效", "Saved for your next cloud request");
      } finally {
        select.value = balance!.selectedModel;
      }
    });
  }
  async function verifyDevice() {
    await act(async () => {
      await api("/auth/device?user_code=" + encodeURIComponent(code));
      verified = true;
    });
  }
  async function decide(allow: boolean) {
    if (allow && !window.confirm(t(`确认连接设备 ${code}？请核对桌面应用中的设备码。`, `Connect device ${code}? Confirm this code matches your desktop app.`))) return;
    await act(async () => {
      assertResult(
        await (allow
          ? auth.device.approve({ userCode: code })
          : auth.device.deny({ userCode: code })),
      );
      approved = true;
      message = allow
        ? t(
            "已连接。返回桌面应用即可。",
            "Connected. Return to your desktop app.",
          )
        : t("已拒绝这次连接。", "Connection denied.");
    });
  }
  afterNavigate(() => {
    document.documentElement.lang = data.en ? "en" : "zh-CN";
    const params = new URLSearchParams(window.location.search);
    const destination = params.get("next");
    next =
      destination &&
      /^\/(?:en\/)?(?:account|pricing|device)(?:\?|$)/.test(destination)
        ? destination
        : href("account");
    code = params.get("user_code") ?? "";
    void act(async () => {
      features = await api<Features>("/features");
      await refresh();
    });
  });
</script>

<svelte:head>
  <title>{title()} · 络笺 Relakeep</title>
  <meta
    name="description"
    content={t(
      "络笺将账号、订阅和复式账本放进一个本地加密库。从现有文件导入，在三维关系图和金钱图谱中查看资产、成本与项目损益。",
      "Keep accounts, subscriptions and a double-entry ledger in one encrypted local vault. Import existing records and explore asset relationships, costs and project P&L.",
    )}
  />
  <link
    rel="canonical"
    href={"https://atlas.sayori.org" +
      href(data.page === "home" ? "" : data.page)}
  />
  <meta property="og:title" content={"络笺 Relakeep · " + title()} />
  <meta
    property="og:description"
    content={t(
      "资产在本地，关系不再靠记忆。",
      "Your assets stay local. Their connections stay clear.",
    )}
  />
  <meta property="og:type" content="website" />
  <meta property="og:image" content="https://atlas.sayori.org/og-image.svg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={"络笺 Relakeep · " + title()} />
  <meta
    name="twitter:description"
    content={t(
      "资产在本地，关系不再靠记忆。",
      "Your assets stay local. Their connections stay clear.",
    )}
  />
  <meta name="twitter:image" content="https://atlas.sayori.org/og-image.svg" />
</svelte:head>

<a class="skip" href="#main">{t("跳到正文", "Skip to content")}</a>
<header class="site-header">
  <a class="brand" href={href()} aria-label="Relakeep"
      ><img src="/mark.svg" alt="" width="31" height="31" /><span
      >络笺<span class="brand-en">Relakeep</span></span
    ></a
  >
  <nav aria-label={t("主导航", "Main navigation")}>
    <a class:current={data.page === "pricing"} href={href("pricing")}
      >{t("价格", "Pricing")}</a
    >
    <a class:current={data.page === "guide"} href={href("guide")}
      >{t("教程", "Guide")}</a
    >
    <a class:current={data.page === "account"} href={href("account")}
      >{t("账户", "Account")}</a
    >
  </nav>
  <div class="header-tools">
    <button class="theme-toggle" aria-label={themeLabel} title={themeLabel} onclick={cycleTheme}><SiteIcon name={theme} size={17}/></button>
    <a
      class="locale"
      aria-label={t("切换至英文", "Switch to Chinese")}
      hreflang={data.en ? "zh-CN" : "en"}
      href={(data.en ? "" : "/en") +
        "/" +
        (data.page === "home" ? "" : data.page)}
      onclick={() => {
        try {
          const nextLocale = data.en ? "zh-Hans" : "en";
          localStorage.setItem("sayori:ui-language", nextLocale);
          document.cookie = `sayori_locale=${nextLocale}; Domain=.sayori.org; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
        } catch {}
      }}>{data.en ? "中文" : "EN"}</a
    >
    <a class="button small" href={href("download")}
      >{t("下载", "Download")} <span aria-hidden="true">↓</span></a
    >
  </div>
</header>
<main id="main">
  {#if data.page === "home"}
    <section class="hero wrap">
      <div class="hero-copy">
        <div class="release-line"><a href={href("download")}>v0.9.4</a><span>{t("本地加密工作区", "Local-first workspace")}</span></div>
        <h1>{t("资产有来路，", "Follow the links.")}<br />{t("花销有去处。", "Track the costs.")}</h1>
        <p class="lead">{t("哪个账号在续费？钱从哪张卡出，又花在哪个项目上？络笺把数字资产和复式账本放进同一个本地加密库。", "Which account renews? Which card pays? Which project picks up the bill? Keep your digital assets and double-entry books together in one encrypted local vault.")}</p>
        <div class="actions">
          <a class="button" href={href("download")}><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="m3 5 8-1v7H3zm10-1 8-1v8h-8zM3 13h8v7l-8-1zm10 0h8v8l-8-1z"/></svg>{t("下载 Windows 版", "Download for Windows")}</a>
          <a class="text-link" href="#how">{t("看看怎么用", "See how it works")} →</a>
        </div>
        <div class="hero-footnote"><SiteIcon name="lock" size={14}/>{t("本地使用免费，无需注册。", "Free to use locally. No sign-up.")}</div>
      </div>
      <ProductPreview en={data.en} />
    </section>
    <section class="workflow wrap" id="how">
      <h2>{t("从已有的记录开始", "Start with the records you have")}</h2>
      <div class="workflow-grid">
        <article><SiteIcon name="import" size={23}/><h3>{t("导入账号，不导入密码", "Bring accounts, not passwords")}</h3>
          <p>{t("在本地读取 Bitwarden 或浏览器导出文件，让邮箱和账号自动连线。导入微信、支付宝账单时，先看重复流水和可能的订阅，再决定保留哪些。", "Import a Bitwarden or browser export locally to link email addresses to accounts. Bring in WeChat or Alipay bills, review duplicates and choose which subscriptions to keep.")}</p>
          <a class="text-link" href={href("guide") + "#import"}>{t("支持的导入格式", "Supported imports")} →</a></article>
        <article><SiteIcon name="ledger" size={23}/><h3>{t("一句话，记一笔", "One line to book lunch")}</h3>
          <p>{t("输入「午饭 22.5 微信」，核对后就能入账。不用先建账户。按天回看收支，月底核对预算；投资持仓则单独查看数量、成本和已实现盈亏。", "Enter lunch, the amount and the wallet you paid from. Review and book it without setting up accounts first. Track spending by day, check your budget and review investment positions and realized gains separately.")}</p>
          <a class="text-link" href={href("guide") + "#bookkeeping"}>{t("打开账本教程", "Book your first entry")} →</a></article>
        <article><SiteIcon name="connections" size={23}/><h3>{t("顺着月费找到项目", "Trace a fee to its project")}</h3>
          <p>{t("在三维关系图里找到账号、订阅和付款卡。切换金钱图谱，从固定成本一路看到项目分摊，分清一项业务的收入、直接成本与损益。", "Explore accounts, subscriptions and cards in the 3D relationship graph. Switch to the money graph to follow fixed costs into projects and see what each one earned after direct and allocated costs.")}</p>
          <a class="text-link" href={href("guide") + "#graphs"}>{t("查看图谱教程", "Explore the two graphs")} →</a></article>
      </div>
    </section>
    <section class="backup-strip wrap"><SiteIcon name="lock" size={22}/>
      <div><h2>{t("备份也由你保管", "Your backup stays yours")}</h2><p>{t("加密备份可留在本机，也可保存到自己的 GitHub 私密仓库。", "Keep an encrypted backup on your computer or in your own private GitHub repository.")}</p></div>
      <div><a class="text-link" href={href("guide") + "#github-backup"}>{t("备份教程", "Backup guide")} →</a><a class="text-link" href={href("pricing")}>{t("模型与费用", "AI and pricing")} →</a></div>
    </section>
  {:else if data.page === "pricing"}
    <section class="wrap page-intro">
      <h1>{title()}</h1>
    </section>
    <section class="wrap">
      <div class="price-controls">
        <label
          >{t("币种", "Currency")}
          <select bind:value={currency}
            ><option value="cny">CNY</option><option value="hkd">HKD</option
            ><option value="usd">USD</option></select
          ></label
        >
      </div>
      <div class="pricing-grid">
        <article class="price-card">
          <h2>{t("本地使用", "Local")}</h2>
          <div class="price">{t("免费", "Free")}</div>
          <ul>
            <li>
              {t(
                "资产、关系、提醒与搜索",
                "Assets, relationships, reminders and search",
              )}
            </li>
            <li>
              {t("本地加密与加密备份", "Encrypted local vault and backups")}
            </li>
            <li>{t("本地模型 / Ollama", "Local model / Ollama")}</li>
            <li>
              {t(
                "自带 API Key（供应商另计费）",
                "Your API key (provider charges apply)",
              )}
            </li>
          </ul>
          <a class="button secondary" href={href("download")}
            >{t("下载使用", "Download")}</a
          >
        </article>
        <article class="price-card featured">
          <h2>{t("云 AI 月套餐", "Cloud AI monthly")}</h2>
          <div class="price">{price()}<small> / {t("月", "month")}</small></div>
          <p>
            {t("每月 300 次", "300 credits / month")}
          </p>
          <ul>
            <li>
              {t(
                "整理与智能查询",
                "Capture and smart search",
              )}
            </li>
            <li>DeepSeek V4 / V4.1 Flash · GPT-6 Luna</li>
            <li>
              {t(
                "额度当月有效",
                "Credits expire each month",
              )}
            </li>
            <li>
              {t(
                "自动续费，可取消",
                "Auto-renews; cancel anytime",
              )}
            </li>
          </ul>
          <button
            class="button"
            disabled={busy || !features?.billing || balance?.subscription?.status === 'active'}
            onclick={() => purchase("monthly")}
            >{balance?.subscription?.status === 'active' ? t("已订阅", "Subscribed") : features?.billing
              ? t("订阅月套餐", "Subscribe")
              : t("云 AI 暂未开放", "Cloud AI coming later")}</button
          >
        </article>
        <article class="price-card">
          <h2>{t("云 AI 加量包", "Cloud AI top-up")}</h2>
          <div class="price">{price()}<small> / {t("包", "pack")}</small></div>
          <p>{t("300 次，永久有效", "300 credits, no expiry")}</p>
          <ul>
            <li>{t("整理与智能查询", "Capture and smart search")}</li>
            <li>DeepSeek V4 Flash</li>
            <li>{t("单次购买", "One-time purchase")}</li>
          </ul>
          <button
            class="button secondary"
            disabled={busy || !features?.billing}
            onclick={() => purchase("topup")}
            >{features?.billing
              ? t("购买加量包", "Buy a top-up")
              : t("云 AI 暂未开放", "Cloud AI coming later")}</button
          >
        </article>
      </div>
      <a class="text-link" href={href("refunds")}>{t("退款说明", "Refund policy")}</a>
    </section>
  {:else if data.page === "download"}
    <section class="wrap page-intro">
      <h1>{title()}</h1>
    </section>
    <section class="wrap download-panel">
      <img src="/mark.svg" width="76" height="76" alt="" />
      <div>
        <h2>Relakeep 0.9.3</h2>
        <p>Windows 10 / 11 · x64</p>
      </div>
      <a
        class="button"
        href="/downloads/Relakeep_0.9.3_x64-setup.exe"
        rel="noopener"
        >{t("下载安装程序", "Download installer")} ↓</a
      >
    </section>
    <section class="wrap platform-downloads">
      <div><span><strong>Android</strong><small>0.9.4 · Android 7+ · arm64</small></span><a class="text-link" href="/downloads/Relakeep_0.9.4_arm64.apk">{t("下载 APK", "Download APK")} ↓</a></div>
      <div><span><strong>Debian / Ubuntu</strong><small>0.9.2 · amd64</small></span><a class="text-link" href="/downloads/Relakeep_0.9.2_amd64.deb">{t("下载 deb", "Download deb")} ↓</a></div>
      <div><span><strong>{t("Linux 网页版", "Linux web app")}</strong><small>0.9.3 · x64 · localhost:5011</small></span><a class="text-link" href="/downloads/Relakeep_0.9.3_linux-web.tar.gz">{t("下载程序", "Download app")} ↓</a></div>
      <div><span><strong>Docker</strong><small>0.9.2 · {t("首次部署到自己的服务器", "First install on your own server")}</small></span><a class="text-link" href="/downloads/Relakeep_0.9.2_selfhost.tar.gz">{t("下载部署包", "Download package")} ↓</a></div>
    </section>
    <section class="wrap two-columns">
      <article>
        <a class="text-link" href={href("guide")}
          >{t("安装和使用教程", "Installation and user guide")} ↗</a
        >
      </article>
      <article>
        <a
          class="text-link"
          href="https://github.com/Amiyadesi/amiya-atlas/releases/latest"
          rel="noopener">{t("国际下载 · GitHub Releases", "International downloads · GitHub Releases")} ↗</a
        >
      </article>
    </section>
  {:else if data.page === "guide"}
    <section class="wrap page-intro" id="guide">
      <h1>{title()}</h1>
    </section>
    <div class="wrap guide-layout">
      <aside aria-label={t("教程目录", "Guide contents")}>
        <a href="#install">{t("安装与升级", "Install and upgrade")}</a>
        <a href="#capture">{t("记下一条", "Capture")}</a>
        <a href="#bookkeeping">{t("账本与极速记账", "Bookkeeping & Cost Map")}</a>
        <a href="#import">{t("从其他软件导入", "Import from Bitwarden & Bills")}</a>
        <a href="#graphs">{t("三维关系图与金钱图谱", "3D Relationship & Money Graph")}</a>
        <a href="#models">{t("选择模型", "Choose a model")}</a>
        <a href="#backup">{t("备份恢复", "Backup and restore")}</a>
        <a href="#browser">{t("浏览器扩展", "Browser extension")}</a>
        <a href="#github-backup">{t("GitHub 私密备份", "Private GitHub backup")}</a>
        <a href="#sync">{t("多端同步", "Device sync")}</a>
        <a href="#selfhost">{t("自建服务器", "Self-hosting")}</a>
      </aside>
      <div class="prose">
        <section id="install">
          <h2>{t("安装与升级", "Install and upgrade")}</h2>
          <ol>
            <li>
              {t(
                "Windows 运行安装程序；Android 安装 APK；Debian / Ubuntu 打开 deb 包安装。",
                "Run the Windows installer, install the Android APK, or open the deb package on Debian / Ubuntu.",
              )}
            </li>
            <li>
              {t(
                "首次启动设置主密码，创建记忆库。妥善保存主密码，恢复备份时需要使用。",
                "Set a master password to create your vault. Keep it safe; you will need it to restore backups.",
              )}
            </li>
            <li>{t("Windows 首次解锁时勾选“记住这台电脑”，下次打开会自动进入。", "On Windows, select “Remember this computer” when unlocking to open automatically next time.")}</li>
            <li>{t("应用内按 Ctrl + Shift + L 锁定；启用设备解锁后，在锁定页按同一快捷键打开。", "Press Ctrl + Shift + L in the app to lock. With device unlock enabled, use the same shortcut on the lock screen to open it.")}</li>
            <li>
              {t(
                "升级前导出加密备份，关闭程序，再更新所有同步设备。新版写入账本后，不要用 0.4 等旧版打开同一份库。",
                "Export an encrypted backup and close the app before updating all devices that sync. Once you save new ledger entries, do not reopen that vault in 0.4 or another older version.",
              )}
            </li>
          </ol>
        </section>
        <section id="capture">
          <h2>{t("记下一条，再看变更", "Capture, then review")}</h2>
          <p>
            {t(
              "在首页输入：“我的 Acme 主账号用 hello@example.invalid 注册，用日本备用号码找回。”点击“整理预览”，检查记忆、属性和关联，再点击保存。",
              "Enter: “My Acme account uses hello@example.invalid for sign-up and my Japan backup SIM for recovery.” Select “Preview changes”, review the records, fields and connections, then save.",
            )}
          </p>
        </section>
        <section id="bookkeeping">
          <h2>{t("账本与极速记账", "Bookkeeping & Cost Map")}</h2>
          <p>{t("午饭花了 22.5 元？在首页或账本输入「午饭 22.5 微信」，按 Enter 预览。核对金额、账户和分类，再按 Enter 入账。不必先建账户，也不需要 AI。", "Paid ¥22.50 for lunch? In quick entry on Home or Ledger, try “午饭 22.5 微信” (lunch, 22.5, WeChat). Press Enter to preview, check the amount, account and category, then press Enter to post. No account setup or AI required.")}</p>
          <ul>
            <li><strong>{t("连续记账。", "Keep entering. ")}</strong>{t("在「记一笔」选择「保存并再记一笔」，继续填下一笔金额。流水按天分组；点开一笔可查看复式分录。", "In the entry form, choose Save and add another to move to the next amount. Transactions are grouped by day; open one to inspect both sides of the entry.")}</li>
            <li><strong>{t("预算与对账。", "Check the books. ")}</strong>{t("到「回顾」设置预算、查看本月支出。在「账户 → 对账」填实际余额和差额原因。记错时打开原流水点「冲正」，反向分录会保留原始记录。", "Set a budget in Review and compare it with this month’s spending. Under Accounts → Reconcile, enter the actual balance and explain the difference. To correct an entry, open it and choose Reverse; the original stays in the ledger.")}</li>
            <li><strong>{t("固定成本与项目损益。", "Map fixed costs. ")}</strong>{t("为订阅填写费用和周期，在「项目 → 分摊成本」指定项目比例。固定费用按币种折算到每月；经营项目的损益会区分直接成本和分摊成本。", "Give a subscription a fee and billing cycle, then assign a share under Projects → Allocate costs. Fixed costs are normalized per month, by currency. Business project P&L separates direct expenses from allocated costs.")}</li>
          </ul>
        </section>
        <section id="import">
          <h2>{t("从其他软件导入", "Import from Bitwarden & Bills")}</h2>
          <p>{t("在应用的「设置 → 数据导入中心」选择本地文件，先预览，再确认。官网示例不需要上传文件。", "In the app, open Settings → Data import center and select a local file. Review the preview before confirming. The website demo needs no files.")}</p>
          <ul>
            <li><strong>{t("账号。", "Accounts. ")}</strong>{t("选择未加密的 Bitwarden JSON 或 CSV，也支持浏览器、1Password 和 KeePass 导出的 CSV。导入只保留账号等元数据，剔除密码、验证码密钥等敏感字段；邮箱可自动关联多个账号。", "Use an unencrypted Bitwarden JSON or CSV export, or a CSV from your browser, 1Password or KeePass. The importer keeps account metadata, strips passwords and authenticator secrets, and links accounts that share an email address.")}</li>
            <li><strong>{t("账单。", "Bills. ")}</strong>{t("在「账本 → 导入账单」选择微信、支付宝或通用 CSV；通用表格可自行匹配列。预览中核对收支方向与账户，跳过重复流水。若发现可能的订阅，勾选才会创建订阅资产。", "In Ledger → Import bills, choose a WeChat, Alipay or generic CSV. Map columns for a generic file, check directions and accounts, and skip duplicates. Suggested subscriptions become assets only if you select them.")}</li>
          </ul>
          <p class="guide-note"><SiteIcon name="lock" size={16}/>{t("原始导出文件可能含明文密码。仅在可信设备上导出，导入后删除文件。", "The original export can contain plaintext passwords. Export on a trusted device and delete the file after import.")}</p>
        </section>
        <section id="graphs">
          <h2>{t("三维关系图与金钱图谱", "3D Relationship & Money Graph")}</h2>
          <p><kbd>Ctrl+K</kbd> {t("打开应用的命令面板。输入资产名；用方向键选择，按 Enter 查看，或在资产结果上按 Alt+Enter 在图中定位。", "opens the app’s command palette. Search for an asset, use the arrow keys to select it, then press Enter to open it or Alt+Enter to locate it in the graph.")}</p>
          <p><strong>{t("看关系。", "Trace relationships. ")}</strong>{t("在「关系图 → 关系」拖动旋转、滚轮缩放，点击球体查看相邻资产。点图例按类别筛选，勾选「隐藏孤立节点」暂时收起没有连线的资产。", "In Graph → Relationships, drag to rotate, scroll to zoom and select a node to inspect its neighbors. Filter by category in the legend, or turn on Hide isolated nodes to remove unconnected assets from view.")}</p>
          <p><strong>{t("看钱流。", "Follow the money. ")}</strong>{t("切换到「金钱」，先选币种，再沿资源月费的连线查看项目分摊和闲置成本。点节点看关联流水，回到项目损益核对收入与成本。", "Switch to Money and choose a currency. Follow a resource’s monthly fee into project allocations and idle costs. Select a node for related entries, then compare revenue and costs in project P&L.")}</p>
        </section>
        <section id="models">
          <h2>{t("选择整理方式", "Choose your AI")}</h2>
          <ul>
            <li>
              {t(
                "Windows 本地模型：设置 → 模型，选择模型并下载。",
                "Windows local model: open Settings → Model, choose a model and download it.",
              )}
            </li>
            <li>
              {t(
                "Ollama：填写本地地址和模型名，先测试连接。",
                "Ollama: enter its local URL and model name, then test the connection.",
              )}
            </li>
            <li>
              {t(
                "自带 API Key：填写兼容接口、模型和 Key。供应商直接向你计费。",
                "Your API key: enter a compatible endpoint, model and key. Your provider bills you directly.",
              )}
            </li>
            <li>
              {t(
                "官网账户：设置 → 官网账户 → 登录，在浏览器中登录并核对设备码，批准后返回应用。",
                "Website account: open Settings → Website account → Sign in. Sign in in your browser, check the device code, approve and return to the app.",
              )}
            </li>
          </ul>
        </section>
        <section id="backup">
          <h2>{t("备份与恢复", "Backup and restore")}</h2>
          <p>
            {t(
              "设置 → 记忆与备份 → 导出加密备份，保存到其他磁盘。恢复前先备份当前数据，再选择“恢复备份”，打开备份文件并输入它的主密码。",
              "Open Settings → Memories and backups → Export encrypted backup and save it to another drive. Before restoring, back up your current data, select “Restore backup”, open the backup file and enter its master password.",
            )}
          </p>
          <p>
            {t(
              "需要分享部分数据时，选择“脱敏导出”。完整备份请选择“导出加密备份”。",
              "To share data, select “Redacted export”. For a complete backup, select “Export encrypted backup”.",
            )}
          </p>
        </section>
        <section id="browser">
          <h2>{t("浏览器扩展", "Browser extension")}</h2>
          <p>
            {t(
              "Windows 安装目录有 extension 文件夹。打开 chrome://extensions 或 edge://extensions，启用开发者模式 → 加载已解压扩展 → 选择 extension。打开并解锁络笺，在网页中点击“加入络笺”，选择登录身份。",
              "On Windows, find the extension folder in the install directory. Open chrome://extensions or edge://extensions, enable developer mode and load the unpacked folder. On a webpage, click the capture action and choose a sign-in identity. The desktop app must be running and unlocked.",
            )}
          </p>
        </section>
        <section id="github-backup">
          <h2>{t("GitHub 私密备份", "Private GitHub backup")}</h2>
          <ol>
            <li><a href="https://github.com/Amiyadesi/relakeep-vault-template/generate" target="_blank" rel="noreferrer">{t("打开备份模板", "Open the backup template")}</a>。{t("创建自己的新仓库，可见性选择 Private，再 clone 到本机。", "Create your own new repository with Private visibility, then clone it.")}</li>
            <li>{t("安装 Git 和 GitHub CLI，执行 gh auth login。", "Install Git and GitHub CLI, then run gh auth login.")}</li>
            <li>{t("桌面设置 → 记忆与备份 → 导出加密备份。打开私密仓库文件夹中的终端，执行下方命令，把路径换成刚导出的文件。", "Export an encrypted backup from desktop Settings. Open a terminal in your private repository and run the command below with your exported file path.")}</li>
          </ol>
          <p><code>powershell -NoProfile -ExecutionPolicy Bypass -File .\backup.ps1 -Backup "C:\Users\YourName\Downloads\atlas-encrypted-backup.json"</code></p>
          <p>{t("每次导出新的备份后，运行这条命令上传。", "Run this command after each new backup export to upload it.")}</p>
          <p>{t("恢复前先备份当前数据。运行 restore.ps1，或下载 vault/latest.atlas-backup.json，在软件里恢复并输入原主密码。", "Back up your current data before restoring. Run restore.ps1 or download vault/latest.atlas-backup.json, then restore it in the app with its master password.")}</p>
        </section>
        <section id="sync">
          <h2>{t("多端同步", "Device sync")}</h2>
          <ol>
            <li>{t("设置 → 同步 → 自建服务器，填写域名或 https://IP:端口，点击“保存并同步”。", "Open Settings → Sync → Your server, enter its domain or https://IP:port and select Save and sync.")}</li>
            <li>{t("在打开的浏览器中登录服务器，核对设备码并允许连接，然后回到软件。", "Sign in to the server in your browser, confirm the device code and return to the app.")}</li>
            <li>{t("另一台设备也连接同一地址。若提示另一份记忆库，选择“导入远端记忆库”，输入它的主密码。", "Connect the other device to the same address. If prompted about a different vault, select Import remote vault and enter its master password.")}</li>
          </ol>
          <p>{t("用自己的网盘：选择“网盘 / WebDAV”，填写文件夹地址、用户名和应用密码。", "For your own drive, select WebDAV and enter the folder URL, username and app password.")}</p>
          <p>{t("保持“自动同步”开启。应用打开、回到前台或恢复网络时自动同步；冲突时选择保留本机或远端。", "Leave automatic sync on. Sync runs while the app is open, on returning to the foreground and after reconnecting. Choose a local or remote version when a conflict appears.")}</p>
          <p>{t("电脑在“设置 → 同步”点击“浏览器打开”，进入 localhost:5011；Linux 独立网页版解压后运行 ./relakeep-web，打开终端给出的链接。", "On a computer, select Open in browser in Sync settings for localhost:5011. For the standalone Linux web app, extract it, run ./relakeep-web and open the link printed in the terminal.")}</p>
        </section>
        <section id="selfhost">
          <h2>{t("自建服务器", "Self-hosting")}</h2>
          <p>{t("下载 Docker 部署包并解压；服务器安装 Node.js 24 和 Docker Compose。域名指向服务器，开放 80/443 端口，然后执行：", "Extract the Docker deployment package. Install Node.js 24 and Docker Compose on your server, point a domain at it, open ports 80/443 and run:")}</p>
          <pre><code>node scripts/init-selfhost.mjs selfhost.env https://atlas.example.com{"\n"}docker compose -f compose.yaml -f compose.https.yaml up -d --build</code></pre>
          <p>{t("打开自己的域名，使用 selfhost.env 中的 RELAKEEP_SETUP_TOKEN 创建登录账户，再创建或导入记忆库。", "Open your domain, create your login account with RELAKEEP_SETUP_TOKEN from selfhost.env, then create or import your vault.")}</p>
          <p>{t("升级已有部署时，保留原数据卷、selfhost.env、身份密钥与 Compose 项目名，沿用原来的 -p 和 -f 参数重新构建。不要从新目录直接启动或删除旧卷。", "For an existing deployment, keep the data volumes, selfhost.env, identity keys and Compose project name. Rebuild with your original -p and -f options. Do not launch from a new directory or delete the old volumes.")}</p>
          <p>{t("网页“设置 → 服务器登录”可开启验证器两步验证、添加通行密钥、选择是否记录登录环境，以及退出已连接设备。保存好两步验证的恢复码。", "In the web app, open Settings → Server sign-in to enable authenticator 2FA, add passkeys, choose whether to record login environments and revoke devices. Save your 2FA recovery codes.")}</p>
          <p>{t("IP 连接请先配置设备信任的 HTTPS 证书；通行密钥使用 HTTPS 域名。网页版会在自己的服务器解密记忆库。", "For an IP address, configure an HTTPS certificate your devices trust. Use an HTTPS domain for passkeys. The web app decrypts your vault on your own server.")}</p>
          <a class="text-link" href="/downloads/Relakeep_0.4.1_guide.md" download>{t("下载完整部署与备份教程", "Download the deployment and backup guide")} ↓</a>
        </section>
      </div>
    </div>
  {:else if data.page === "login"}
    <section class="auth-card">
      <h1>{title()}</h1>
      {#if user}<p>{user.email}</p>
        <a class="button" href={next}>{t("继续", "Continue")} →</a>{:else}<div
          class="social-buttons"
        >
          {#if features?.github}<button
              class="button secondary"
              disabled={busy}
              onclick={() => social("github")}>GitHub</button
            >{/if}{#if features?.google}<button
              class="button secondary"
              disabled={busy}
              onclick={() => social("google")}>Google</button
            >{/if}
        </div>
        {#if features?.email}<form
          onsubmit={(e) => {
            e.preventDefault();
            void (sent ? login() : sendOtp());
          }}
        >
          <label
            >{t("邮箱", "Email")}<input
              type="email"
              bind:value={email}
              required
              autocomplete="email"
              disabled={sent || busy}
              placeholder="you@example.com"
              aria-invalid={emailError ? "true" : undefined}
              aria-describedby={emailError ? "email-error" : undefined}
              oninput={() => emailError = ""}
            /></label
          >{#if emailError}<p id="email-error" class="field-error" role="alert">{emailError}</p>{/if}{#if sent}<label
              >{t("六位验证码", "Six-digit code")}<input
                type="text"
                bind:value={otp}
                required
                inputmode="numeric"
                pattern="[0-9]{6}"
                maxlength="6"
                autocomplete="one-time-code"
              /></label
            >{/if}<button class="button" disabled={busy || !features?.email}
            >{busy
              ? t("请稍候…", "Please wait…")
              : sent
                ? t("验证并登录", "Verify and sign in")
                : features?.email
                  ? t("发送验证码", "Send a code")
                  : t("邮箱登录配置中", "Email setup in progress")}</button
          >{#if sent}<button
              class="text-link"
              type="button"
              onclick={() => {
                sent = false;
                otp = "";
              }}>{t("修改邮箱 / 重发", "Change email / resend")}</button
            >{/if}
        </form>{/if}{/if}
    </section>
  {:else if data.page === "account"}
    <section class="wrap page-intro">
      <h1>{title()}</h1>
      {#if user}<p class="lead">{user.email}</p>{/if}
    </section>
    {#if user}<section class="wrap">
        <div class="balance-panel">
          <div>
            <span class="eyebrow">{t("可用额度", "AVAILABLE CREDITS")}</span
            ><strong
              >{balance?.unlimited ? "∞" : balance?.total ?? "—"}<small>{t("次", "credits")}</small
              ></strong
            >
          </div>
          <div>
            <p>
              {t("本月", "Monthly")} <b>{balance?.monthly ?? "—"}</b> · {t(
                "永久加量",
                "Top-up",
              )} <b>{balance?.topup ?? "—"}</b>
            </p>
            <p>
              {balance?.unlimited ? t("无限订阅", "Unlimited subscription") : balance?.subscription?.cancels
                ? t(
                    "已取消，将在当前周期结束时停止续费",
                    "Canceled; renewal stops at period end",
                  )
                : balance?.subscription?.status === "active"
                  ? t("月订阅有效", "Monthly subscription active")
                  : t("没有有效月订阅", "No active monthly subscription")}
            </p>
            {#if balance?.unlimited}<p>{t("内部额度", "Internal credit")} · US${balance.internalBalanceUsd.toLocaleString(data.en ? "en-US" : "zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>{/if}
            <div class="actions">
              <a class="button small" href={href("pricing")}
                >{t("购买额度", "Buy credits")}</a
              >{#if features?.billing}<button class="text-link" disabled={busy} onclick={portal}
                >{t("管理付款与订阅", "Manage billing")} ↗</button
              >{/if}
            </div>
          </div>
        </div>
        {#if balance}<article class="github-backup-panel">
          <h3>{t("云模型", "Cloud model")}</h3>
          <div class="actions"><select aria-label={t("云模型", "Cloud model")} value={balance.selectedModel} disabled={busy} onchange={selectModel}
          >{#each balance.models as model, index}<option value={model.id} disabled={index > 0 && !balance.canChooseModels}>{model.name}</option>{/each}</select>
          {#if !balance.canChooseModels}<a class="button secondary small" href={href("pricing")}>{t("订阅选模型", "Subscribe to choose")}</a>{/if}</div>
        </article>{/if}
        <div class="two-columns">
          <article>
            <h3>{t("关联登录方式", "Link sign-in methods")}</h3>
            <div class="social-buttons">
              {#if features?.github}<button
                  class="button secondary small"
                  disabled={busy || linkedProviders.includes("github")}
                  onclick={() => social("github", true)}
                  >GitHub · {linkedProviders.includes("github") ? t("已关联", "Linked") : t("关联", "Link")}</button
                >{/if}{#if features?.google}<button
                  class="button secondary small"
                  disabled={busy || linkedProviders.includes("google")}
                  onclick={() => social("google", true)}
                  >Google · {linkedProviders.includes("google") ? t("已关联", "Linked") : t("关联", "Link")}</button
                >{/if}
            </div>
          </article>
        </div>
        <article class="github-backup-panel"><h3>{t("GitHub 备份", "GitHub backups")}</h3><div class="actions"><a class="button secondary small" href="https://github.com/Amiyadesi/relakeep-vault-template/generate" target="_blank" rel="noreferrer">{t("创建备份库", "Create a backup repository")}</a><a class="text-link" href={href("guide") + "#github-backup"}>{t("备份教程", "Backup guide")}</a></div></article>
        <button
              class="text-link"
              disabled={busy}
              onclick={() =>
                act(async () => {
                  assertResult(await auth.signOut());
                  user = null;
                  balance = null;
                })}>{t("退出登录", "Sign out")}</button>
        {#if purchases.length}<h3>{t("最近购买记录", "Recent purchases")}</h3>
          <div class="purchase-list">
            {#each purchases as item}<div>
                <span
                  >{item.kind === "monthly"
                    ? t("月套餐", "Monthly")
                    : t("加量包", "Top-up")}<small
                    >{new Date(item.created_at).toLocaleDateString(
                      data.en ? "en" : "zh-CN",
                    )}</small
                  ></span
                ><span
                  >{item.revoked
                    ? t("已退款 / 撤销", "Refunded / revoked")
                    : `${item.remaining} / ${item.original}`}</span
                >
              </div>{/each}
          </div>{/if}
      </section>{:else}<div class="wrap">
        <a class="button" href={href("login")}>{t("登录", "Sign in")} →</a
        >
      </div>{/if}
  {:else if data.page === "device"}
    <section class="auth-card">
      <h1>{title()}</h1>
      {#if !user}<a
          class="button"
          href={href("login") +
            "?next=" +
            encodeURIComponent(
              href("device") + "?user_code=" + encodeURIComponent(code),
            )}>{t("先登录云账户", "Sign in first")} →</a
        >{:else if approved}<p class="notice">
          {message}
        </p>{:else if verified}<div class="device-code">{code}</div>
        <div class="actions">
          <button class="button" disabled={busy} onclick={() => decide(true)}
            >{t("批准连接", "Approve")}</button
          ><button
            class="button secondary"
            disabled={busy}
            onclick={() => decide(false)}>{t("拒绝", "Deny")}</button
          >
        </div>{:else}<form
          onsubmit={(e) => {
            e.preventDefault();
            void verifyDevice();
          }}
        >
          <label
            >{t("设备码", "Device code")}<input
              bind:value={code}
              required
              minlength="6"
              maxlength="16"
              autocomplete="off"
            /></label
          ><button class="button" disabled={busy}
            >{t("核对设备", "Check device")}</button
          >
        </form>{/if}
    </section>
  {:else if data.page === "success"}
    <section class="auth-card">
      <h1>{title()}</h1>
      <p>
        {t(
          "付款确认后，刷新余额。",
          "Refresh your balance after payment is confirmed.",
        )}
      </p>
      {#if user}<div class="device-code">
          {balance?.total ?? "—"}
          {t("次", "credits")}
        </div>
        <button class="button" disabled={busy} onclick={() => act(refresh)}
          >{t("刷新余额", "Refresh balance")}</button
        >{/if}<a class="text-link" href={href("account")}
        >{t("返回账户", "Back to account")} →</a
      >
    </section>
  {:else if data.page === "privacy"}
    <section class="wrap page-intro">
      <span class="eyebrow">PRIVACY · 2026-10-14</span>
      <h1>{title()}</h1>
    </section>
    <article class="wrap prose legal">
      <h2>{t("本地 Vault", "Local vault")}</h2>
      <p>
        {t(
          "记忆、关联、随手记和提案在本机加密保存。自动锁定时间可在设置中选择，默认不自动锁定。记住本机由当前 Windows 账户保护；启用后，使用该 Windows 会话的人可以打开记忆库。官网不接收完整资产库，也无法找回本地主密码。",
          "Memories, relationships, captures and proposals are encrypted on your computer. Automatic locking is configurable and off by default. Remembering this computer is protected by your Windows account; anyone using that signed-in session can open the vault. The website does not receive the full vault or recover your local master password.",
        )}
      </p>
      <h2>{t("模型调用", "Model requests")}</h2>
      <p>
        {t(
          "本地模型在本机推理。BYOK 将本次原话和必要上下文发送给你配置的供应商。主动选择官网云服务时，我们发送本次原话、最多 12 个相关对象的名称与类型，以及增改删所必需的非秘密关系、提醒或字段名称。不发送完整库、历史原文、已有字段值或 SECRET 项。不要在原话中输入凭据。",
          "Local inference stays on your device. BYOK sends the current input and necessary context to your chosen provider. Website cloud sends your current input, up to 12 related object names and types, and non-secret relationships, reminders or field names needed for the requested changes. It excludes the full vault, past captures, existing field values and SECRET items. Never include credentials in your input.",
        )}
      </p>
      <p>
        {t(
          "官网云请求通过我们管理的私有网关，按账户中选择的模型转发至 llm.pm 的 DeepSeek 服务或 OpenAI 的 GPT 服务。本次原话和必要上下文会经过对应服务；供应商的数据留存取决于其现行政策。",
          "Hosted AI requests pass through our private gateway to llm.pm for DeepSeek or OpenAI for GPT, based on your account's selected model. Your current input and necessary context pass through the selected service; provider retention follows its current policy.",
        )}
      </p>
      <h2>{t("账户、支付与留存", "Account, payments and retention")}</h2>
      <p>
        {t(
          "服务器保存登录邮箱、OAuth 账户标识、会话、Stripe 客户与订阅标识、购买批次和扣费账本。登录使用必要 Cookie。Stripe 托管付款，我们不保存银行卡支付凭据。月套餐与加量包的余额按购买批次记录。",
          "The server stores your sign-in email, OAuth identities, sessions, Stripe customer and subscription IDs, purchase batches and credit ledger. Sign-in uses necessary cookies. Stripe hosts payment details; we do not store card credentials. Credits are tracked by purchase batch.",
        )}
      </p>
      <p>
        {t(
          "成功 AI 结果加密缓存 1 小时，供相同请求重试；到期后清除结果，账本和请求摘要长期保留以防重复扣费和处理退款。后端不保存原文日志或资产数据库。不发送产品使用遥测。基础网络服务商仍可能保存访问记录。云数据库每日加密备份到 Sayori，保留 30 天。",
          "Successful AI results are encrypted and cached for one hour for retries, then removed. The ledger and request digests remain for deduplication and refunds. The backend stores no raw-input logs or asset database. There is no product-usage telemetry. Network providers may retain access records. The cloud database is backed up encrypted to Sayori daily and retained for 30 days.",
        )}
      </p>
      <h2>{t("联系与删除请求", "Contact and deletion requests")}</h2>
      <p>
        {t(
          "账户或隐私请求请发至 me@sayori.org。我们会核验账户身份；依法需保留的支付记录不会随本地 Vault 删除而自动删除。",
          "Send account and privacy requests to me@sayori.org. We verify account ownership. Payment records that must be retained are not automatically erased when you delete a local vault.",
        )}
      </p>
    </article>
  {:else if data.page === "refunds"}
    <section class="wrap page-intro">
      <span class="eyebrow">REFUNDS · 2026-10-13</span>
      <h1>{title()}</h1>
    </section>
    <article class="wrap prose legal">
      <h2>{t("退款条件", "Refund eligibility")}</h2>
      <p>
        {t(
          "购买后 7 天内，本笔购买产生的额度完全未使用，可申请退款。按购买批次判断，不根据账户当前总余额判断。请使用购买账户邮箱发至 me@sayori.org，附 Stripe 收据或订单标识；不要发送银行卡号。",
          "Within 7 days of purchase, you may request a refund if none of that purchase’s credits has been used. Eligibility is checked per purchase, not against the total account balance. Email me@sayori.org from your account email with your Stripe receipt or order ID. Do not send a card number.",
        )}
      </p>
      <p>
        {t(
          "支持人员核验后通过 Stripe 原路退款。退款到账时间取决于支付方式和银行。该笔购买的额度会被回收；退款不影响其他购买批次。法律规定的其他消费者权利不受本说明限制。",
          "Support verifies the request and refunds through Stripe to the original payment method. Arrival time depends on the payment method and bank. Credits from that purchase are revoked. Other purchases are unaffected. This policy does not limit rights required by applicable law.",
        )}
      </p>
      <h2>{t("订阅与取消", "Subscription and cancellation")}</h2>
      <p>
        {t(
          "月套餐自动续费，每个已付款周期 300 次，未用完的月额度不累积。一个账户最多一个有效订阅。通过账户页的“管理付款与订阅”进入 Stripe Customer Portal，取消在当前周期末生效。取消不会自动退款。",
          "The monthly plan renews automatically and grants 300 credits per paid period, with no rollover. Each account can have one active subscription. Open “Manage billing” in your account to use Stripe Customer Portal. Cancellation takes effect at period end and does not automatically issue a refund.",
        )}
      </p>
      <h2>{t("加量与使用", "Top-ups and usage")}</h2>
      <p>
        {t(
          "加量包每包 300 次，永久有效，可单独购买；月额度优先使用。每次云整理或智能查询生成可审阅结果后扣一次，失败不扣费，同一次请求重试不重复扣费。",
          "Each top-up grants 300 credits with no expiry and can be purchased independently. Monthly credits are used first. Hosted capture or smart search costs one credit when it produces a reviewable result. Failed requests and retries of the same request do not incur additional charges.",
        )}
      </p>
      <h2>{t("服务范围", "Service scope")}</h2>
      <p>
        {t(
          "AI 可能出错。结果仅供你审阅，必须确认后才写入本地库。本地管理、本地模型、普通搜索和自带 Key 功能免费，官网云服务不开放或余额用完时，你仍可主动选择这些方式。不同 Sayori 网站的账户和支付体系彼此独立。",
          "AI can make mistakes. Results are previews and require your confirmation before changing your local vault. Local management, local models, keyword search and BYOK are free. You can choose them if hosted AI is unavailable or credits run out. Accounts and payments on other Sayori websites are separate.",
        )}
      </p>
    </article>
  {/if}
  {#if message && !(data.page === "device" && approved)}<div
      class="status-message"
      role="status"
    >
      {message}
    </div>{/if}
</main>
<footer class="wrap site-footer">
  <div>
    <a class="brand" href={href()}
      ><img src="/mark.svg" alt="" width="25" height="25" />络笺
      <span class="brand-en">Relakeep</span></a
    >
  </div>
  <div class="footer-links">
    <a href={href("privacy")}>{t("隐私", "Privacy")}</a><a
      href={href("refunds")}>{t("退款", "Refunds")}</a
    ><a href="mailto:me@sayori.org">{t("联系", "Contact")}</a><a
      href="https://github.com/Amiyadesi/amiya-atlas">GitHub ↗</a
    >
  </div>
  <div class="ecosystem">
    <a href="https://sayori.org">Sayori ↗</a><a href="https://studio.sayori.org"
      >{t("工作室", "Studio")} ↗</a
    ><a href="https://nav.sayori.org"
      >{t("导航", "Directory")} ↗</a
    ><a href="https://blog.sayori.org">{t("博客", "Blog")} ↗</a><span
      >© 2026 Relakeep</span
    >
  </div>
</footer>
