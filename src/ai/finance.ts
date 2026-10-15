import {z} from 'zod';
import type {ProviderConfig,Transport} from './provider';
import {chatTransport} from './provider';
import {cloudResult} from './cloud-client';
import {assertNoSecrets,cloudInputSchema} from './cloud-contract';
import type {VaultSnapshot} from '../lib/types';
import {ASSETS,moneySchema,money} from '../domain/money';
import {makeEntry,type FinanceAction} from '../domain/ledger';
import {emptyProposal,numberIssues} from '../domain/finance-capture';
import {parseModelJson,proposalSchema,type Proposal} from '../domain/proposal';
import type {LedgerQuery} from '../domain/reports';

const optionalId=z.string().max(200).default('');
export const financeExtractionSchema=z.strictObject({entries:z.array(z.strictObject({kind:z.enum(['SPEND','INCOME','TRANSFER']),amount:moneySchema,accountId:optionalId,counterId:optionalId,occurredAt:z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/),projectId:optionalId,resourceId:optionalId,orderId:optionalId,note:z.string().max(1000),evidence:z.string().min(1).max(10000)})).max(20),uncertainty:z.array(z.string().max(1000)).max(30)});
export const ledgerQuerySchema=z.strictObject({from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),projectId:optionalId,accountId:optionalId,search:z.string().max(500),metric:z.enum(['income','expense','profit','all']),groupBy:z.enum(['day','account','project'])});
export function financeContext(s:VaultSnapshot){return{accounts:(s.ledgerAccounts??[]).filter(a=>a.privacy!=='SECRET'&&!a.archived).slice(0,40).map(a=>({id:a.id,name:a.name,kind:a.kind,asset:a.asset})),entities:s.entities.filter(e=>e.privacy!=='SECRET'&&['Project','Order','Subscription','Server','Domain'].includes(e.category)).slice(0,12).map(e=>({id:e.id,name:e.name,type:e.category,status:e.status,fieldKeys:[]}))};}
export function financeOutput(raw:unknown,text:string,s:VaultSnapshot):Proposal {
 const output=financeExtractionSchema.parse(raw),p=emptyProposal();p.financeActions=[];p.uncertainty=[...output.uncertainty];
 const context=financeContext(s);const accountIds=new Set(context.accounts.map(a=>a.id)),entityIds=new Set(context.entities.map(e=>e.id));
 for(const entry of output.entries){if(!accountIds.has(entry.accountId)||!accountIds.has(entry.counterId)){p.uncertainty.push('付款/收款账户或分类需要选择');continue;}if([entry.projectId,entry.resourceId,entry.orderId].some(id=>id&&!entityIds.has(id)))throw new Error('模型引用了不存在的项目、资源或订单');if(!text.includes(entry.evidence))throw new Error('金额提案缺少原文依据');const t=makeEntry({...entry,date:entry.occurredAt.length===7?entry.occurredAt+'-01':entry.occurredAt});if(entry.occurredAt.length===7)t.precision='month';p.financeActions.push({type:'ledger.add',transaction:t,evidence:entry.evidence});}
 p.uncertainty.push(...numberIssues(p.financeActions,text));return p;
}
export async function parseFinance(config:ProviderConfig,text:string,s:VaultSnapshot,transport:Transport=chatTransport,now=new Date().toISOString()):Promise<Proposal>{
 assertNoSecrets(text);const context=financeContext(s);
 if(config.kind==='cloud'){const result=await cloudResult({kind:'ledger',text,now,entities:cloudInputSchema.shape.entities.parse(context.entities),ledgerAccounts:context.accounts,relations:[],events:[]});const p=proposalSchema.parse(result);p.numbersReviewed=false;p.uncertainty.push(...numberIssues(p.financeActions??[],text));return p;}
 const schema=z.toJSONSchema(financeExtractionSchema);const output=await transport({config,schema,messages:[{role:'system',content:`把原话中已发生的收支转换为 JSON，不计算、不写库。金额 amount 必须是十进制字符串，中文元/块用 CNY，不猜币种、账户、日期或项目。否定、计划、模糊金额写入 uncertainty，不生成已发生流水。每笔独立 entries；只用给出的账户和实体 ID，缺少用空串并写 uncertainty。SPEND 为付款账户到支出分类；INCOME 为收款账户及收入分类；TRANSFER 为转出和转入账户。不要把交易买卖当普通收支。日期保留原文日/月精度；今天参考 now。evidence 必须逐字来自原话。支持币种：${ASSETS.map(a=>a.code).join(',')}。只输出 schema 对应 JSON。`},{role:'user',content:JSON.stringify({text,now,...context})}]});return financeOutput(parseModelJson(output),text,s);
}
export async function parseFinanceQuery(config:ProviderConfig,text:string,s:VaultSnapshot,transport:Transport=chatTransport,now=new Date().toISOString()):Promise<LedgerQuery>{
 assertNoSecrets(text);const context=financeContext(s);let raw:unknown;
 if(config.kind==='cloud')raw=await cloudResult({kind:'ledger-query',text,now,entities:cloudInputSchema.shape.entities.parse(context.entities),ledgerAccounts:context.accounts,relations:[],events:[]});
 else raw=parseModelJson(await transport({config,schema:z.toJSONSchema(ledgerQuerySchema),messages:[{role:'system',content:'将问题转换为账本筛选条件 JSON，不回答问题，不生成金额或 SQL。from/to 为包含端点的日期 YYYY-MM-DD；按 now 理解本月/上月。只使用给出的账户和项目 ID，未指定用空串。search 仅保留明确的商户或备注词；利润 metric=profit，支出=expense，收入=income。groupBy 为 day/account/project。'},{role:'user',content:JSON.stringify({text,now,...context})}]}));
 const q=ledgerQuerySchema.parse(raw);if(q.from>q.to||q.projectId&&!context.entities.some(e=>e.id===q.projectId&&e.type==='Project')||q.accountId&&!context.accounts.some(a=>a.id===q.accountId))throw new Error('查询条件无效');return q;
}
