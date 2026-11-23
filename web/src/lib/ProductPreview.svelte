<script lang="ts">
  import SiteIcon from "./SiteIcon.svelte";

  let { en = false }: { en?: boolean } = $props();
  const t = (zh: string, english: string) => en ? english : zh;
  const tabs = ["connections", "ledger", "import"] as const;
  type Tab = typeof tabs[number];
  let tab = $state<Tab>("connections");
  function moveTab(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next = ({ ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + last) % tabs.length, Home: 0, End: last })[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tab = tabs[next];
    document.getElementById("tab-" + tab)!.focus();
  }

  const records = [
    { id: "email", name: ["主邮箱", "Primary email"], detail: ["hello@example.invalid", "hello@example.invalid"], x: 19, y: 26 },
    { id: "sim", name: ["备用号码", "Backup SIM"], detail: ["尾号 0826", "Ending in 0826"], x: 19, y: 68 },
    { id: "google", name: ["Google 主账号", "Google account"], detail: ["网站账号", "Website account"], x: 48, y: 46 },
    { id: "card", name: ["日常付款卡", "Everyday card"], detail: ["尾号 1234", "Ending in 1234"], x: 79, y: 20 },
    { id: "subscription", name: ["Google One", "Google One"], detail: ["¥19/月", "¥19/mo"], x: 80, y: 68 },
  ] as const;
  type Asset = typeof records[number]["id"];
  const edges = [
    { a: "email", b: "google", d: "M19 26 C35 26 30 46 48 46", out: ["用于登录", "Signs in to"], into: ["注册邮箱", "Sign-in email"] },
    { a: "sim", b: "google", d: "M19 68 C35 68 30 46 48 46", out: ["用于找回", "Recovers"], into: ["找回号码", "Recovery number"] },
    { a: "google", b: "subscription", d: "M48 46 C66 46 63 68 80 68", out: ["关联订阅", "Subscription"], into: ["所属账号", "Account"] },
    { a: "card", b: "subscription", d: "M79 20 C96 20 97 68 80 68", out: ["支付订阅", "Pays for"], into: ["付款方式", "Payment method"] },
  ] as const;
  let selected = $state<Asset>("google");
  const record = (id: Asset) => records.find(r => r.id === id)!;
  const label = (pair: readonly [string, string]) => pair[en ? 1 : 0];
  let links = $derived(edges.filter(e => e.a === selected || e.b === selected));
  let booked = $state(false);
</script>

<div class="showcase">
  <div class="window-bar">
    <div><img src="/mark.svg" alt="" width="19" height="19" /><b>Relakeep</b><span class="crumb">/</span>{t("工作区", "Workspace")}</div>
    <span class="sample"><i></i>{t("示例库", "Demo vault")}</span>
  </div>
  <div class="preview-tabs" role="tablist" aria-label={t("产品预览", "Product preview")}>
    {#each tabs as item, i}
      <button id={"tab-" + item} role="tab" aria-controls={"panel-" + item}
        aria-selected={tab === item} tabindex={tab === item ? 0 : -1}
        onclick={() => tab = item} onkeydown={(event) => moveTab(event, i)}>
        <SiteIcon name={item} size={16} />{[t("关系图谱", "Connections"), t("复式账本", "Ledger"), t("本地导入", "Import")][i]}
      </button>
    {/each}
  </div>

  <div id="panel-connections" role="tabpanel" aria-labelledby="tab-connections" hidden={tab !== "connections"}>
    <div class="atlas-drawing">
      <span class="map-count">{t("5 项资产 · 4 条关联", "5 assets · 4 connections")}</span>
      <svg class="thread-map" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" aria-hidden="true">
        {#each edges as edge}
          <path class:lit={edge.a === selected || edge.b === selected} d={edge.d} vector-effect="non-scaling-stroke" />
        {/each}
      </svg>
      {#each records as item}
        <button class="asset-node node-{item.id}" style:left={item.x + "%"} style:top={item.y + "%"}
          aria-pressed={selected === item.id} onclick={() => selected = item.id}>
          <span class="node-icon">{#if item.id === "google"}G{:else}<SiteIcon name={item.id} size={21}/>{/if}</span>
          <strong>{label(item.name)}</strong>
          {#if item.id === "subscription"}<span class="fee">{label(item.detail)}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="atlas-inspector" aria-live="polite">
      <div class="inspect-heading"><strong>{label(record(selected).name)}</strong><span>{label(record(selected).detail)}</span></div>
      <div class="inspect-links">
        {#each links as link}
          {@const other = record(link.a === selected ? link.b : link.a)}
          <button onclick={() => selected = other.id}><small>{label(link.a === selected ? link.out : link.into)}</small>{label(other.name)} <span aria-hidden="true">↗</span></button>
        {/each}
      </div>
    </div>
  </div>

  <div id="panel-ledger" class="demo-sheet" role="tabpanel" aria-labelledby="tab-ledger" hidden={tab !== "ledger"}>
    <div class="sheet-title"><h2>{t("日常账本", "Everyday ledger")}</h2><span>CNY</span></div>
    <div class="entry-line"><span>{t("午饭 22.5 微信", "Lunch 22.5 WeChat")}</span>
      <button onclick={() => booked = !booked}>{booked ? t("撤销示例", "Undo") : t("试记一笔", "Book entry")}</button>
    </div>
    <div class="day-group" aria-live="polite">
      <h3>{t("今天", "Today")}</h3>
      {#if booked}<div><span>{t("午饭", "Lunch")} <small>· {t("微信", "WeChat")}</small></span><b class="expense">−¥22.50</b></div>{/if}
      <div><span>{t("设计定金", "Design deposit")} <small>· {t("工作室", "Studio")}</small></span><b class="income">+¥800.00</b></div>
      <h3>{t("昨天", "Yesterday")}</h3>
      <div><span>Google One <small>· {t("订阅", "Subscription")}</small></span><b class="expense">−¥19.00</b></div>
    </div>
    <div class="budget"><label for="demo-budget">{t("本月餐饮预算", "Monthly food budget")}</label><b>¥{booked ? "210.00" : "187.50"} / ¥500</b>
      <progress id="demo-budget" max="500" value={booked ? 210 : 187.5}></progress></div>
    <a class="text-link" href={(en ? "/en" : "") + "/guide#bookkeeping"}>{t("查看项目成本分摊", "Explore project costs")} →</a>
  </div>

  <div id="panel-import" class="demo-sheet" role="tabpanel" aria-labelledby="tab-import" tabindex="0" hidden={tab !== "import"}>
    <div class="sheet-title"><h2>{t("本地导入预览", "Local import preview")}</h2><SiteIcon name="lock" /></div>
    <div class="import-file"><SiteIcon name="import"/><b>Bitwarden.json</b><span class="safe-tag">{t("已剔除密码", "Passwords stripped")}</span></div>
    <div class="link-summary"><span class="node-icon"><SiteIcon name="email" /></span><div><strong>hello@example.invalid</strong><small>{t("1 个邮箱自动关联 3 个账号", "1 email automatically linked to 3 accounts")}</small></div></div>
    <div class="bill-result"><h3>{t("微信 / 支付宝账单", "WeChat / Alipay bills")}</h3><p>{t("12 笔待入账，已跳过 2 笔重复流水。", "12 entries ready. 2 duplicates skipped.")}</p></div>
    <div class="found-sub"><div><span>{t("发现可能的订阅", "Possible subscription")}</span><strong>Google One</strong></div><b>{t("¥19/月", "¥19/mo")}</b></div>
  </div>
</div>
