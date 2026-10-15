<script lang="ts">
 import type {FinanceAction} from '../../domain/ledger';
 import type {VaultSnapshot} from '../../lib/types';
 import {formatMoney,money} from '../../domain/money';
 export let actions:FinanceAction[]=[];
 export let snapshot:VaultSnapshot;
 export let changed:()=>void;
 let editError='';
 const label=(id:string)=>snapshot.ledgerAccounts?.find(a=>a.id===id)?.name??actions.flatMap(a=>a.type==='account.add'?[a.account]:[]).find(a=>a.id===id)?.name??id;
 function amount(index:number,leg:number,value:string){try{const a=actions[index];if(a.type!=='ledger.add')return;a.transaction.legs[leg].money=money(value,a.transaction.legs[leg].money.asset);actions=[...actions];editError='';changed();}catch(e){editError=String(e);}}
</script>
<div class="finance-preview">
 {#each actions as action,i}
  <article>
   {#if action.type==='account.add'}<strong>新建账户 · {action.account.name}</strong><span>{action.account.asset??'分类账户'}</span>
   {:else if action.type==='ledger.reverse'}<strong>冲正</strong><span>{snapshot.transactions?.find(t=>t.id===action.transactionId)?.note??action.transactionId} · {action.occurredAt}</span>
   {:else}<strong>{action.transaction.payee||action.transaction.note||'记一笔'}</strong><small>{action.transaction.occurredAt}</small>
    {#each action.transaction.legs as leg,j}<label>{label(leg.accountId)}<span><input aria-label={`${label(leg.accountId)} 金额`} value={leg.money.amount} inputmode="decimal" on:change={e=>amount(i,j,e.currentTarget.value)} /> {leg.money.asset}</span></label>{/each}
    {#if action.transaction.legs.some(l=>l.projectId)}<small>项目：{snapshot.entities.find(e=>e.id===action.transaction.legs.find(l=>l.projectId)?.projectId)?.name}</small>{/if}
    <blockquote>{action.evidence}</blockquote>
   {/if}
   <button type="button" class="text-button" on:click={()=>{actions=actions.filter((_,j)=>i!==j);changed();}}>移除</button>
  </article>
 {/each}
 {#if editError}<p class="error" role="alert">{editError}</p>{/if}
</div>
<style>.finance-preview{display:grid;gap:1rem}.finance-preview article{border-block:1px solid var(--line,#ddd);padding:1rem 0;display:grid;gap:.6rem}.finance-preview label{display:flex;justify-content:space-between;align-items:center;gap:1rem}.finance-preview input{width:10rem;font-weight:650;font-variant-numeric:tabular-nums}blockquote{margin:0;padding:.5rem 1rem;border-left:2px solid #888;color:var(--muted,#777)}small{color:var(--muted,#777)}</style>
