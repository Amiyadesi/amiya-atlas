<script lang="ts">
 import type {VaultSnapshot} from '../../lib/types';
 import {monthlyCosts,periodReport} from '../../domain/reports';
 import {allocate} from '../../domain/allocation';
 import {ASSETS,units,fromUnits,formatMoney,total,type Money} from '../../domain/money';
 import ExploreCanvas from '../graph/ExploreCanvas.svelte';
 export let snapshot:VaultSnapshot;
 export let month:string;
 export let rootId='';
 export let mode:'graph'|'flow'='graph';
 export let onOpen:(id:string)=>void;
 let asset='CNY',selected='';
 $: costs=monthlyCosts(snapshot,`${month}-01`);
 $: report=periodReport(snapshot,`${month}-01`,`${month}-31`);
 $: graph=withAllocations();
 $: amounts=new Map([...costs.rows.filter(r=>!r.usage&&r.monthly.asset===asset).map(r=>[r.entity.id,r.monthly] as const),...report.projects.map(p=>[p.id,total([...p.direct,...p.allocated]).find(m=>m.asset===asset)??fromUnits(0n,asset)] as const)]);
 $: max=[...amounts.values()].reduce((max,m)=>units(m)>max?units(m):max,1n);
 $: decorations=Object.fromEntries([...amounts].map(([id,m])=>[id,{label:formatMoney(m),weight:Number(units(m)*1000n/max)/1000,idle:costs.rows.find(r=>r.entity.id===id)?.allocation.idle.amount}]));
 $: flows=buildFlows(snapshot,month,asset);
 $: recent=report.transactions.filter(t=>t.privacy!=='SECRET'&&t.legs.some(l=>l.projectId===selected||l.resourceId===selected)).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)).slice(0,8);
 $: project=report.projects.find(p=>p.id===selected);
 function withAllocations(){const edges=costs.rows.flatMap(row=>row.allocation.shares.filter(s=>units(s.amount)!==0n&&s.amount.asset===asset).map(share=>({id:`allocation:${row.allocation.ruleId}:${share.projectId}`,sourceId:row.entity.id,targetId:share.projectId,type:'ALLOCATED_TO',note:formatMoney(share.amount),privacy:'PRIVATE' as const,createdAt:row.entity.createdAt})));return{...snapshot,relations:[...snapshot.relations,...edges]};}
 function buildFlows(s:VaultSnapshot,month:string,asset:string){const accounts=new Map(s.ledgerAccounts?.map(a=>[a.id,a]));const names=new Map(s.entities.filter(e=>e.privacy!=='SECRET').map(e=>[e.id,e.name]));const sums=new Map<string,bigint>();const labels=new Map<string,string>();
  const put=(from:string,to:string,n:bigint)=>{const key=`${from}\0${to}`;sums.set(key,(sums.get(key)??0n)+n);};
  for(const t of s.transactions??[]){if(!t.occurredAt.startsWith(month)||t.privacy==='SECRET')continue;for(const l of t.legs){if(l.money.asset!==asset)continue;const a=accounts.get(l.accountId);if(!a||a.privacy==='SECRET')continue;const accountKey=`${a.kind==='INCOME'?'i':'e'}:${a.id}`;labels.set(accountKey,a.name);
   const shares=l.projectId?[{projectId:l.projectId,amount:l.money}]:l.resourceId&&a.kind==='EXPENSE'?(()=>{const r=allocate(s,l.resourceId,t.occurredAt,l.money);return[...r.shares,{projectId:'idle',amount:r.idle}];})():[{projectId:'unassigned',amount:l.money}];
   for(const share of shares){const p=`p:${share.projectId}`;labels.set(p,names.get(share.projectId)??(share.projectId==='idle'?'闲置容量':'未分配'));if(a.kind==='INCOME')put(accountKey,p,-units(share.amount));if(a.kind==='EXPENSE')put(p,accountKey,units(share.amount));}
  }}
  const links=[...sums].filter(([,n])=>n>0n).map(([key,n])=>{const [from,to]=key.split('\0');return{from,to,n};});const ids=[...new Set(links.flatMap(l=>[l.from,l.to]))].slice(0,80);const nodes=ids.map(id=>({id,label:labels.get(id)??id,x:id.startsWith('i:')?60:id.startsWith('p:')?440:820,y:0,height:0}));let maxTotal=1n;const totals=new Map<string,bigint>();for(const node of nodes){const incoming=links.filter(l=>l.to===node.id).reduce((n,l)=>n+l.n,0n),outgoing=links.filter(l=>l.from===node.id).reduce((n,l)=>n+l.n,0n);totals.set(node.id,incoming>outgoing?incoming:outgoing);}for(const x of [60,440,820]){const sum=nodes.filter(n=>n.x===x).reduce((v,n)=>v+(totals.get(n.id)??0n),0n);if(sum>maxTotal)maxTotal=sum;}
  const factor=(n:bigint)=>Number(n*30000n/maxTotal)/100;
  for(const x of [60,440,820]){let y=40;for(const node of nodes.filter(n=>n.x===x)){node.y=y;node.height=Math.max(4,factor(totals.get(node.id)??0n));y+=node.height+28;}}
  const offsets=new Map<string,number>();const paths=links.flatMap(l=>{const a=nodes.find(n=>n.id===l.from),b=nodes.find(n=>n.id===l.to);if(!a||!b)return[];const h=Math.max(1,factor(l.n)),ay=a.y+(offsets.get(`${a.id}:out`)??0)+h/2,by=b.y+(offsets.get(`${b.id}:in`)??0)+h/2;offsets.set(`${a.id}:out`,(offsets.get(`${a.id}:out`)??0)+h);offsets.set(`${b.id}:in`,(offsets.get(`${b.id}:in`)??0)+h);return[{...l,h,d:`M ${a.x+14} ${ay} C ${a.x+180} ${ay}, ${b.x-180} ${by}, ${b.x} ${by}`}];});return{nodes,paths,height:Math.max(420,...nodes.map(n=>n.y+n.height+40))};
 }
</script>
<div class="money-toolbar"><label>币种<select bind:value={asset}>{#each ASSETS as a}<option value={a.code}>{a.code}</option>{/each}</select></label>{#if mode==='graph'&&!rootId}<label>资产<select bind:value={rootId}><option value="">选择起点</option>{#each snapshot.entities.filter(e=>e.privacy!=='SECRET') as e}<option value={e.id}>{e.name}</option>{/each}</select></label>{/if}</div>
{#if mode==='graph'}
 {#if rootId}<ExploreCanvas snapshot={graph} {rootId} moneyData={decorations} onPick={id=>selected=id} onOpen={id=>{selected=id;}} />{/if}
 {#if selected}<aside class="money-detail"><div class="section-heading"><h3>{snapshot.entities.find(e=>e.id===selected)?.name}</h3><button class="secondary" on:click={()=>onOpen(selected)}>编辑资产</button></div>{#if project}<p>收入 {project.income.filter(m=>m.asset===asset).map(formatMoney).join(' · ')||'—'} / 成本 {total([...project.direct,...project.allocated]).filter(m=>m.asset===asset).map(formatMoney).join(' · ')||'—'} / 利润 {project.profit.filter(m=>m.asset===asset).map(formatMoney).join(' · ')||'—'}</p>{/if}{#each recent as t}<div class="money-row"><span>{t.occurredAt} · {t.note||t.payee||t.kind}</span><strong>{total(t.legs.filter(l=>l.money.asset===asset&&units(l.money)>0n).map(l=>l.money)).map(formatMoney).join(' · ')}</strong></div>{:else}<p class="muted">本月没有关联流水</p>{/each}</aside>{/if}
{:else}
 <div class="flow" on:keydown={e=>{if(e.key==="ArrowRight")e.currentTarget.scrollLeft+=80;if(e.key==="ArrowLeft")e.currentTarget.scrollLeft-=80;}} role="region" aria-label={`${month} ${asset} 钱流图`} tabindex="0"><svg viewBox={`0 0 1000 ${flows.height}`} role="img" aria-label="收入、项目与成本流向"><text x="60" y="20">收入</text><text x="440" y="20">项目</text><text x="820" y="20">成本</text>{#each flows.paths as p}<path d={p.d} fill="none" stroke="var(--accent)" opacity=".23" stroke-width={p.h}><title>{formatMoney(fromUnits(p.n,asset))}</title></path>{/each}{#each flows.nodes as n}<rect x={n.x} y={n.y} width="14" height={n.height} fill={n.id==='p:idle'?'#aaa':'var(--accent)'} /><text x={n.x+20} y={n.y+12}>{n.label}</text>{/each}</svg></div>
 {#if !flows.nodes.length}<p class="muted">本月没有 {asset} 收支流水</p>{/if}
{/if}
<style>.money-toolbar{display:flex;gap:1rem;margin:1rem 0}.money-detail{padding:1rem 0}.money-row{display:flex;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--border);padding:.8rem 0}.flow{width:100%;overflow:auto;margin:1rem 0}.flow svg{width:100%;min-width:700px}text{font-size:12px;fill:var(--text)}</style>
