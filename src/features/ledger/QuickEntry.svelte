<script lang="ts">
  import { onDestroy } from "svelte";
  import type { VaultSnapshot } from "../../lib/types";
  import type { ProviderConfig } from "../../ai/provider";
  import type { Proposal } from "../../domain/proposal";
  import { parseFinance } from "../../ai/finance";
  import {
    emptyProposal,
    localLedgerProposal,
    numberIssues,
    ledgerAccountOptions,
    resolveLedgerAccount,
    applyFinanceActions,
  } from "../../domain/finance-capture";
  import {
    makeEntry,
    type Transaction,
    type FinanceAction,
  } from "../../domain/ledger";
  import { money } from "../../domain/money";
  import { confirmDialog } from "../../lib/dialog";
  export let snapshot: VaultSnapshot, config: ProviderConfig;
  export let stage: (raw: string, p: Proposal) => Promise<void>;
  export let save: (next: VaultSnapshot, ids: string[]) => Promise<void>;
  export let previewing = false;
  type Draft = {
    kind: Transaction["kind"];
    amount: string;
    asset: string;
    account: string;
    category: string;
    original: Transaction;
  };
  let sentence = "",
    error = "",
    busy = false,
    editing = false,
    drafts: Draft[] = [];
  let disposed = false;
  onDestroy(() => {
    disposed = true;
  });
  $: previewing = drafts.length > 0;
  async function parse(ai = false, typing = false) {
    if (busy || !sentence.trim()) return;
    busy = true;
    error = "";
    try {
      const raw = sentence;
      const p = ai
        ? await parseFinance(config, raw, snapshot)
        : localLedgerProposal(raw, snapshot, undefined, true);
      if (disposed || raw !== sentence) return;
      const txs =
        p?.financeActions?.flatMap((a) =>
          a.type === "ledger.add" ? [a.transaction] : [],
        ) ?? [];
      if (
        !p ||
        ai ||
        !txs.length ||
        p.uncertainty.length ||
        numberIssues(p.financeActions ?? [], sentence).length ||
        p.financeActions?.some((a) => a.type === "ledger.reverse")
      ) {
        if (typing) return;
        const proposal = p ?? emptyProposal();
        if (
          !p ||
          (!txs.length &&
            !proposal.uncertainty.length &&
            !proposal.financeActions?.length)
        )
          proposal.uncertainty.push("请核对收支方向与金额");
        await stage(raw, proposal);
        return;
      }
      const added =
        p.financeActions?.flatMap((a) =>
          a.type === "account.add" ? [a.account] : [],
        ) ?? [];
      const account = (id: string) =>
        [...added, ...(snapshot.ledgerAccounts ?? [])].find((a) => a.id === id)
          ?.name ?? id;
      drafts = txs.map((t) => ({
        kind: t.kind,
        amount: t.legs[0].money.amount.replace(/^-/, ""),
        asset: t.legs[0].money.asset,
        account: account(t.legs[0].accountId),
        category: account(t.legs[1].accountId),
        original: t,
      }));
    } catch (e) {
      if(!typing) error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  async function commit() {
    if (busy || !drafts.length) return;
    busy = true;
    error = "";
    try {
      const actions: FinanceAction[] = [],
        ids: string[] = [];
      for (const d of drafts) {
        const a = resolveLedgerAccount(
          snapshot,
          actions,
          d.account,
          "ASSET",
          d.asset,
          "未指定账户",
        );
        const c = resolveLedgerAccount(
          snapshot,
          actions,
          d.category,
          d.kind === "TRANSFER"
            ? "ASSET"
            : d.kind === "INCOME"
              ? "INCOME"
              : "EXPENSE",
          d.asset,
          d.kind === "INCOME" ? "其他收入" : "其他支出",
        );
        const t = makeEntry({
          kind: d.kind,
          amount: money(d.amount.trim(), d.asset),
          accountId: a.id,
          counterId: c.id,
          date: d.original.occurredAt,
          note: d.original.note || d.category,
          payee: d.original.payee,
          projectId: d.original.legs[1].projectId,
          resourceId: d.original.legs[1].resourceId,
        });
        ids.push(t.id);
        actions.push({
          type: "ledger.add",
          transaction: t,
          evidence: t.note || "快速记账",
        });
      }
      const backdated = actions.some(
        (a) =>
          a.type === "ledger.add" &&
          snapshot.financeRecords?.some(
            (r) =>
              r.type === "reconciliation" &&
              a.transaction.legs.some((l) => l.accountId === r.accountId) &&
              r.date >= a.transaction.occurredAt,
          ),
      );
      if (
        backdated &&
        !(await confirmDialog({
          title: "仍然入账？",
          description: "所选账户已核对过这笔流水的日期。",
          confirmLabel: "确认入账",
        }))
      )
        return;
      await save(applyFinanceActions(snapshot, actions), ids);
      sentence = "";
      drafts = [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="quick-entry">
  <form on:submit|preventDefault={() => drafts.length ? commit() : parse()}>
    <div class="line">
    <input
      aria-label="一句话记账"
      placeholder="午饭 22.5 微信"
      value={sentence}
      on:input={e => {
        sentence=e.currentTarget.value;
        drafts = [];editing=false;
        error = "";
        void parse(false,true);
      }}
      required
    />
    {#if sentence.trim() && !drafts.length}<button class="secondary" disabled={busy}>预览</button>{/if}
    {#if sentence.trim()}<button
      type="button"
      class="text-button"
      disabled={busy || !sentence.trim()}
      on:click={() => parse(true)}>AI 整理</button>{/if}
    </div>
    {#if drafts.length}<div class="confirmation reveal-in" aria-label="入账预览">
      {#each drafts as d, i}
        {#if !editing}<div class="draft-summary"><span>{d.category} · {d.account}</span><strong>{d.asset} {d.amount}</strong></div>
        {:else}<div class="draft reveal-in">
          <small>{d.original.note} · {d.asset}</small>
          <label
            >金额<input
              aria-label="确认金额"
              bind:value={d.amount}
              inputmode="decimal"
              placeholder="0.00"
              required
            /></label
          >
          <label
            >{d.kind === "TRANSFER" ? "转入账户" : "分类"}<input
              bind:value={d.category}
              list={"quick-cats-" + i}
              required
            /></label
          >
          <datalist id={"quick-cats-" + i}
            >{#each ledgerAccountOptions(snapshot, d.asset).filter( (a) => (d.kind === "TRANSFER" ? ["LIABILITY", "ASSET"].includes(a.kind) && a.asset === d.asset : a.kind === (d.kind === "INCOME" ? "INCOME" : "EXPENSE")) ) as a}<option
                value={a.name}
              ></option>{/each}</datalist
          >
          <label
            >账户<input
              bind:value={d.account}
              placeholder="未指定账户"
              list={"quick-funds-" + i}
            /></label
          >
          <datalist id={"quick-funds-" + i}
            >{#each ledgerAccountOptions(snapshot, d.asset).filter((a) => ["LIABILITY", "ASSET"].includes(a.kind) && a.asset === d.asset) as a}<option
                value={a.name}
              ></option>{/each}</datalist
          >
        </div>{/if}
      {/each}
      <div class="actions">
        <button type="button" class="text-button" on:click={()=>editing=!editing}>{editing?"收起":"调整"}</button>
        <button
          type="button"
          class="text-button"
          on:click={() => {
            drafts = [];
          }}>取消</button
        ><button class="primary" disabled={busy}>直接入账</button>
      </div>
    </div>{/if}
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .quick-entry {
    margin-block: 14px;
  }
  .line,
  .draft,
  .draft-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;padding:3px 0}
  .draft-summary span{min-width:0;overflow-wrap:anywhere;color:var(--muted)}
  .draft-summary strong{white-space:nowrap;font-variant-numeric:tabular-nums}
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .line input {
    min-width: 100px;
    flex: 1;
  }
  .confirmation {
    padding: 14px;
    border: 0;
    border-radius: 8px;
    background: var(--accent-dim);
    margin-top: 10px;
  }
  .draft {
    align-items: end;
    padding: 5px 0;
  }
  .draft label {
    flex: 1 1 90px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }
  .draft input {
    width: 100%;
  }
  .draft small {
    width: 100%;
    color: var(--accent);
  }
  .draft-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;padding:3px 0}
  .draft-summary span{min-width:0;overflow-wrap:anywhere;color:var(--muted)}
  .draft-summary strong{white-space:nowrap;font-variant-numeric:tabular-nums}
  .actions {
    justify-content: flex-end;
    margin-top: 9px;
  }
</style>
