<script lang="ts">
  import { attributeLabel } from "../../domain/proposal";
  import type { Proposal } from "../../domain/proposal";
  import { proposalDiff } from "../../domain/changes";
  import type { ProposalChange } from "../../domain/changes";
  import type { VaultSnapshot } from "../../lib/types";
  export let content: Proposal;
  export let snapshot: VaultSnapshot;
  export let busy = false;
  export let onCancel: (change: ProposalChange) => void;
  $: changes = proposalDiff(content, snapshot);
  const labels = { add: "＋ 新增", update: "修改", remove: "－ 删除" };
  function label(key: string) {
    return (
      (
        {
          name: "名称",
          type: "类型",
          status: "状态",
          relation: "关联",
          event: "事件",
          dueAt: "日期",
          policy: "续费策略",
          recurrence: "重复规则",
        } as Record<string, string>
      )[key] ?? attributeLabel(key.replace(/^attribute:/, ""))
    );
  }
  function value(key: string, text: string) {
    if (key === "dueAt" && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
      const date = new Date(text);
      if (!Number.isNaN(date.getTime()))
        return date.toLocaleString("zh-CN", { hour12: false });
    }
    if (!["relation", "event", "policy"].includes(key)) return text;
    return (
      (
        {
          RELATED_TO: "相关",
          AUTHENTICATES_WITH: "登录身份",
          REGISTERED_WITH: "注册绑定",
          RECOVERS_WITH: "找回方式",
          PAID_BY: "付款方式",
          MANAGED_BY: "由此管理",
          MANAGES: "管理",
          OWNS: "持有",
          ISSUED_BY: "发行方",
          HOSTED_ON: "托管于",
          DEPENDS_ON: "依赖",
          SOURCE_IN: "源码位于",
          DEPLOYED_ON: "部署于",
          EXPIRY: "到期",
          RENEWAL: "续费",
          REVIEW: "复查",
          CANCELLATION: "取消",
          REMINDER: "提醒",
          AUTO_RENEW: "自动续费",
          MANUAL: "手动续费",
          DO_NOT_RENEW: "不续费",
        } as Record<string, string>
      )[text] ?? text
    );
  }
</script>

<div class="proposal-diff" aria-label="记忆变更预览" aria-live="polite">
  <div class="diff-summary">
    <strong>这次会改变什么</strong>
    <div>
      <span class="diff-add"
        >＋ {changes.filter((c) => c.kind === "add").length} 新增</span
      ><span>↔ {changes.filter((c) => c.kind === "update").length} 修改</span
      ><span class="diff-remove"
        >－ {changes.filter((c) => c.kind === "remove").length} 删除</span
      >
    </div>
  </div>
  {#each changes as change}
    <article
      class="diff-card"
      class:diff-deletion={change.kind === "remove"}
      aria-label={`${labels[change.kind]}${change.category}：${change.label}`}
    >
      <div class="diff-heading">
        <div>
          <span
            class="diff-kind"
            class:diff-add={change.kind === "add"}
            class:diff-remove={change.kind === "remove"}
            >{labels[change.kind]}{change.category}</span
          >
          <h3>{change.label}</h3>
        </div>
        {#if !change.automatic}<button
            class="text-button"
            disabled={busy}
            on:click={() => onCancel(change)}
            aria-label={`取消${change.label}的${labels[change.kind]}变更`}
            >取消此项</button
          >{/if}
      </div>
      {#if change.automatic}<p class="diff-context">
          随这项记忆一起移除；取消记忆删除即可保留。
        </p>{/if}
      <dl class="diff-rows">
        {#each change.rows as row}
          <div class="diff-row">
            <dt>{label(row.key)}</dt>
            <dd>
              {#if row.before !== undefined}<div class="diff-old">
                  <span class="diff-sign" aria-hidden="true">−</span><span
                    class="sr-only">移除值：</span
                  ><del>{value(row.key, row.before) || "（空）"}</del>
                </div>{/if}
              {#if row.after !== undefined}<div class="diff-new">
                  <span class="diff-sign" aria-hidden="true">＋</span><span
                    class="sr-only">新增值：</span
                  ><ins>{value(row.key, row.after) || "（空）"}</ins>
                </div>{/if}
            </dd>
          </div>
        {/each}
      </dl>
    </article>
  {:else}<p class="muted">
      没有要应用的变更。已取消的项目和没有变化的字段不会写入。
    </p>{/each}
  {#if content.entitiesToDelete?.length}<p class="diff-removal-note">
      删除会移除当前记忆及上面列出的关联、生命周期。原始输入仍保留；应用后可撤销最近一次确认。
    </p>{/if}
</div>
