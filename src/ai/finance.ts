import { z } from "zod";
import type { ProviderConfig, Transport } from "./provider";
import { chatTransport } from "./provider";
import { cloudResult } from "./cloud-client";
import { assertNoSecrets, cloudInputSchema } from "./cloud-contract";
import type { VaultSnapshot } from "../lib/types";
import { ASSETS, moneySchema } from "../domain/money";
import { dateToday, makeEntry } from "../domain/ledger";
import {
  emptyProposal,
  expenseCategory,
  ledgerAccountOptions,
  materializeFinanceAccounts,
  numberIssues,
  resolveLedgerAccount,
} from "../domain/finance-capture";
import {
  parseModelJson,
  proposalSchema,
  type Proposal,
} from "../domain/proposal";
import type { LedgerQuery } from "../domain/reports";

const optionalId = z.string().max(200).default("");
export const financeExtractionSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        kind: z.enum(["SPEND", "INCOME", "TRANSFER"]),
        amount: moneySchema,
        accountId: optionalId,
        counterId: optionalId,
        accountName: z.string().max(200).default(""),
        categoryName: z.string().max(200).default(""),
        occurredAt: z
          .string()
          .regex(/^(?:\d{4}-\d{2}(?:-\d{2})?)?$/)
          .default(""),
        projectId: optionalId,
        resourceId: optionalId,
        orderId: optionalId,
        note: z.string().max(1000),
        evidence: z.string().min(1).max(10000),
      }),
    )
    .max(20),
  uncertainty: z.array(z.string().max(1000)).max(30),
});
export const ledgerQuerySchema = z.strictObject({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  projectId: optionalId,
  accountId: optionalId,
  search: z.string().max(500),
  metric: z.enum(["income", "expense", "profit", "all"]),
  groupBy: z.enum(["day", "account", "project"]),
});
export function financeContext(s: VaultSnapshot, text = "") {
  return {
    accounts: ledgerAccountOptions(s)
      .filter(
        (a) =>
          !text ||
          text.includes(a.name) ||
          !["ASSET", "LIABILITY"].includes(a.kind) ||
          a.name === "未指定账户",
      )
      .map((a) => ({ id: a.id, name: a.name, kind: a.kind, asset: a.asset })),
    entities: s.entities
      .filter(
        (e) =>
          e.privacy !== "SECRET" &&
          ["Project", "Order", "Subscription", "Server", "Domain"].includes(
            e.category,
          ),
      )
      .slice(0, 12)
      .map((e) => ({
        id: e.id,
        name: e.name,
        type: e.category,
        status: e.status,
        fieldKeys: [],
      })),
  };
}
export function financeOutput(
  raw: unknown,
  text: string,
  s: VaultSnapshot,
): Proposal {
  const output = financeExtractionSchema.parse(raw),
    p = emptyProposal();
  p.financeActions = [];
  p.uncertainty = [
    ...new Set(
      output.uncertainty.filter(
        (item) =>
          /金额|币种|模糊|不精确|转账|方向/.test(item) ||
          !/账户|accountId|counterId|日期|occurredAt|分类|category|计划|打算|交易买卖/i.test(
            item,
          ),
      ),
    ),
  ];
  const context = financeContext(s);
  const entityIds = new Set(context.entities.map((e) => e.id));
  for (const entry of output.entries) {
    const options = ledgerAccountOptions(s, entry.amount.asset);
    if (
      [entry.accountId, entry.counterId].some(
        (id) => id && !options.some((a) => a.id === id),
      )
    )
      throw new Error("模型引用了不存在的账户");
    if (entry.kind === "TRANSFER" && (!entry.accountId || !entry.counterId)) {
      p.uncertainty.push("转账需要选择转出和转入账户");
      continue;
    }
    if (
      [entry.projectId, entry.resourceId, entry.orderId].some(
        (id) => id && !entityIds.has(id),
      )
    )
      throw new Error("模型引用了不存在的项目、资源或订单");
    if (!text.includes(entry.evidence)) throw new Error("金额提案缺少原文依据");
    if (entry.accountName && !text.includes(entry.accountName))
      throw new Error("账户名称未在原文中找到");
    const account = resolveLedgerAccount(
      s,
      p.financeActions,
      entry.accountId || entry.accountName,
      "ASSET",
      entry.amount.asset,
      "未指定账户",
    );
    const counter = resolveLedgerAccount(
      s,
      p.financeActions,
      entry.counterId || entry.categoryName,
      entry.kind === "TRANSFER"
        ? "ASSET"
        : entry.kind === "INCOME"
          ? "INCOME"
          : "EXPENSE",
      entry.amount.asset,
      entry.kind === "INCOME" ? "其他收入" : expenseCategory(entry.evidence),
    );
    const t = makeEntry({
      ...entry,
      accountId: account.id,
      counterId: counter.id,
      date:
        entry.occurredAt.length === 7
          ? entry.occurredAt + "-01"
          : entry.occurredAt || dateToday(),
    });
    if (entry.occurredAt.length === 7) t.precision = "month";
    p.financeActions.push({
      type: "ledger.add",
      transaction: t,
      evidence: entry.evidence,
    });
  }
  p.uncertainty.push(...numberIssues(p.financeActions, text));
  return p;
}
export async function parseFinance(
  config: ProviderConfig,
  text: string,
  s: VaultSnapshot,
  transport: Transport = chatTransport,
  now = new Date().toISOString(),
): Promise<Proposal> {
  assertNoSecrets(text);
  const context = financeContext(s, text);
  if (config.kind === "cloud") {
    const result = await cloudResult({
      kind: "ledger",
      text,
      now,
      entities: cloudInputSchema.shape.entities.parse(context.entities),
      ledgerAccounts: context.accounts,
      relations: [],
      events: [],
    });
    const p = proposalSchema.parse(result);
    p.financeActions = materializeFinanceAccounts(s, p.financeActions ?? []);
    p.numbersReviewed = false;
    p.uncertainty.push(...numberIssues(p.financeActions ?? [], text));
    return p;
  }
  const schema = z.toJSONSchema(financeExtractionSchema);
  const output = await transport({
    config,
    schema,
    messages: [
      {
        role: "system",
        content: `提取已发生的每笔收支，供用户编辑后保存。amount.amount 是十进制字符串，asset 为币种。中文日常记账未写币种用 CNY；未写日期用 now 当天。早餐、午餐、晚餐分类为餐饮；打车、车费分类为出行；多次分别生成 entries，不合并。付款或收款账户可不填写，缺少 ID 留空，仍保留流水；原话写了新的账户名称则填写 accountName。categoryName 使用简短明确的中文分类。已有账户或分类只用上下文 ID。SPEND 是支出、INCOME 是收入，TRANSFER 必须明确转出和转入账户。原话明确的项目、资源、订单才关联。只提取实际发生的记录，未来计划、否定和闲聊忽略，不生成提示。缺少账户、分类或日期不写 uncertainty；仅无法确定的金额或转账方向需确认。不编造买卖数量、成交价和盈亏。日期保留原文日/月精度；evidence 必须逐字来自原话。支持币种：${ASSETS.map((a) => a.code).join(",")}。只输出 schema 对应 JSON。\nJSON Schema: ${JSON.stringify(schema)}`,
      },
      { role: "user", content: JSON.stringify({ text, now, ...context }) },
    ],
  });
  return financeOutput(parseModelJson(output), text, s);
}
export async function parseFinanceQuery(
  config: ProviderConfig,
  text: string,
  s: VaultSnapshot,
  transport: Transport = chatTransport,
  now = new Date().toISOString(),
): Promise<LedgerQuery> {
  assertNoSecrets(text);
  const context = financeContext(s, text);
  const schema = z.toJSONSchema(ledgerQuerySchema);
  let raw: unknown;
  if (config.kind === "cloud")
    raw = await cloudResult({
      kind: "ledger-query",
      text,
      now,
      entities: cloudInputSchema.shape.entities.parse(context.entities),
      ledgerAccounts: context.accounts,
      relations: [],
      events: [],
    });
  else
    raw = parseModelJson(
      await transport({
        config,
        schema,
        messages: [
          {
            role: "system",
            content: `将问题转换为账本筛选条件 JSON，不回答问题，不生成金额或 SQL。from/to 为包含端点的日期 YYYY-MM-DD；按 now 理解本月/上月。只使用给出的账户和项目 ID，未指定用空串。search 仅保留明确的商户或备注词；利润 metric=profit，支出=expense，收入=income。groupBy 为 day/account/project。\nJSON Schema: ${JSON.stringify(schema)}`,
          },
          { role: "user", content: JSON.stringify({ text, now, ...context }) },
        ],
      }),
    );
  const q = ledgerQuerySchema.parse(raw);
  if (
    q.from > q.to ||
    (q.projectId &&
      !context.entities.some(
        (e) => e.id === q.projectId && e.type === "Project",
      )) ||
    (q.accountId && !context.accounts.some((a) => a.id === q.accountId))
  )
    throw new Error("查询条件无效");
  return q;
}
