import type { Entity,VaultSnapshot } from '../lib/types';
import { money, moneySchema, units, fromUnits, total, scale, subtract, negate, type Money } from './money';
import { allocate } from './allocation';
import type { Transaction } from './ledger';
export const field=(e:Entity,key:string)=>e.fields.find(f=>f.key===key)?.value;
export function costOf(e:Entity):Money|undefined { const v=field(e,'fee'); if(v===undefined)return;return moneySchema.parse(v); }
export function monthlyCosts(s:VaultSnapshot,date:string){
 const rows=s.entities.filter(e=>!['INACTIVE','ARCHIVED'].includes(e.status)&&e.privacy!=='SECRET').flatMap(entity=>{const fee=costOf(entity);if(!fee)return[];const period=String(field(entity,'billing_period')??'monthly');const usage=period==='usage';const monthly=period==='yearly'?scale(fee,1n,12n):period==='quarterly'?scale(fee,1n,3n):fee;return[{entity,fee,monthly,usage,allocation:allocate(s,entity.id,date,monthly)}];});
 return {rows,totals:total(rows.filter(r=>!r.usage).map(r=>r.monthly)),idle:total(rows.filter(r=>!r.usage).map(r=>r.allocation.idle))};
}
export interface ProjectReport {id:string;name:string;income:Money[];direct:Money[];allocated:Money[];profit:Money[];avoidable:Money[];ruleIds:string[]}
export function periodReport(s:VaultSnapshot,from:string,to:string){
 const accounts=new Map(s.ledgerAccounts?.map(a=>[a.id,a]));
 const sums=new Map<string,bigint>();const add=(key:string,m:Money,sign=1n)=>sums.set(`${key}\0${m.asset}`,(sums.get(`${key}\0${m.asset}`)??0n)+units(m)*sign);
 const ruleIds=new Map<string,Set<string>>(); const transactions=(s.transactions??[]).filter(t=>t.occurredAt>=from&&t.occurredAt<=to);
 for(const t of transactions)for(const l of t.legs){const kind=accounts.get(l.accountId)?.kind;
  if(kind==='INCOME'){add('income',l.money,-1n);if(l.projectId)add(`${l.projectId}:income`,l.money,-1n);}
  if(kind==='EXPENSE'){add('expense',l.money);if(l.projectId)add(`${l.projectId}:direct`,l.money);else if(l.resourceId){const allocation=allocate(s,l.resourceId,t.occurredAt,l.money);add('idle',allocation.idle);for(const share of allocation.shares){add(`${share.projectId}:allocated`,share.amount);if(allocation.ruleId){const set=ruleIds.get(share.projectId)??new Set();set.add(allocation.ruleId);ruleIds.set(share.projectId,set);}}}}
 }
 const get=(key:string)=>[...sums].filter(([k])=>k.startsWith(`${key}\0`)).map(([k,n])=>fromUnits(n,k.split('\0')[1]));
 const projects:ProjectReport[]=s.entities.filter(e=>e.category==='Project'&&e.privacy!=='SECRET').map(e=>{const income=get(`${e.id}:income`),direct=get(`${e.id}:direct`),allocated=get(`${e.id}:allocated`);const avoidable=monthlyCosts(s,from).rows.filter(r=>!r.usage&&field(r.entity,'avoidable_project')===e.id).map(r=>r.monthly);return{id:e.id,name:e.name,income,direct,allocated,profit:total([...income,...direct.map(negate),...allocated.map(negate)]),avoidable:total(avoidable),ruleIds:[...(ruleIds.get(e.id)??[])]};});
 return {income:get('income'),expense:get('expense'),idle:get('idle'),projects,transactions};
}
export function orderReport(s:VaultSnapshot,order:Entity){const quote=field(order,'quote');if(!quote)return;const amount=moneySchema.parse(quote);const incomes=new Set(s.ledgerAccounts?.filter(a=>a.kind==='INCOME').map(a=>a.id));const received=total((s.transactions??[]).filter(t=>t.refs?.orderId===order.id).flatMap(t=>t.legs.filter(l=>incomes.has(l.accountId)).map(l=>negate(l.money))));const paid=received.find(m=>m.asset===amount.asset)??money('0',amount.asset);return{quote:amount,paid,due:subtract(amount,paid),otherCurrencies:received.filter(m=>m.asset!==amount.asset)};}
export function expectedPayments(s:VaultSnapshot,month:string){
 const expenses=new Set(s.ledgerAccounts?.filter(a=>a.kind==='EXPENSE').map(a=>a.id));const entities=new Map(s.entities.map(e=>[e.id,e]));
 return s.events.filter(e=>['RENEWAL','PAYMENT_DUE'].includes(e.type)&&e.status==='UPCOMING'&&e.dueAt).flatMap(ev=>{let due=ev.dueAt!;if(ev.recurrence==='monthly'&&due.slice(0,7)<=month)due=month+due.slice(7);if(ev.recurrence==='yearly'&&due.slice(0,4)<=month.slice(0,4))due=month.slice(0,4)+due.slice(4);if(!due.startsWith(month))return[];const entity=entities.get(ev.entityId);if(!entity)return[];const fee=costOf(entity);if(!fee)return[];const matched=(s.transactions??[]).filter(t=>t.occurredAt.startsWith(month)&&(t.refs?.subscriptionId===entity.id||t.legs.some(l=>l.resourceId===entity.id)));const actual=total(matched.flatMap(t=>t.legs.filter(l=>expenses.has(l.accountId)&&l.money.asset===fee.asset).map(l=>l.money))).find(m=>m.asset===fee.asset);return[{id:ev.id,entity,due,expected:fee,actual,difference:actual?subtract(actual,fee):undefined}];});
}
export interface LedgerQuery {from:string;to:string;projectId?:string;accountId?:string;search:string;metric:'income'|'expense'|'profit'|'all';groupBy:'day'|'account'|'project'}
export function queryLedger(s:VaultSnapshot,q:LedgerQuery):Transaction[]{return(s.transactions??[]).filter(t=>t.privacy!=='SECRET'&&t.occurredAt>=q.from&&t.occurredAt<=q.to&&(!q.projectId||t.legs.some(l=>l.projectId===q.projectId))&&(!q.accountId||t.legs.some(l=>l.accountId===q.accountId))&&`${t.payee??''} ${t.note??''}`.toLowerCase().includes(q.search.toLowerCase()));}
