import { units, money, moneySchema, type Money } from "./money";
import {
  makeEntry,
  reverseTransaction,
  validateLedger,
  dateToday,
  accountSchema,
  type LedgerAccount,
  type FinanceAction,
} from "./ledger";
import { newId, nowIso, type VaultSnapshot } from "../lib/types";
import type { Proposal, TextCapture } from "./proposal";
const digits: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
export function normalizeNumber(input: string): string {
  let text = input.normalize("NFKC").replaceAll(",", "").toLowerCase();
  let multiplier = 1n;
  const suffix = text.match(/([kmw万千])$/);
  if (suffix && /\d/.test(text)) {
    multiplier = { k: 1000n, m: 1000000n, w: 10000n, 万: 10000n, 千: 1000n }[
      suffix[1]
    ]!;
    text = text.slice(0, -1);
  }
  if (/^[零〇一二两三四五六七八九十百千万亿点]+$/.test(text)) {
    const [integer, fraction] = text.split("点");
    let sum = 0n,
      section = 0n,
      current = 0n;
    if (!/[十百千万亿]/.test(integer)) {
      text = [...integer].map((c) => digits[c]).join("");
    } else {
      for (const c of integer) {
        if (c in digits) current = BigInt(digits[c]);
        else {
          const unit = {
            十: 10n,
            百: 100n,
            千: 1000n,
            万: 10000n,
            亿: 100000000n,
          }[c]!;
          if (unit < 10000n) {
            section += (current || 1n) * unit;
            current = 0n;
          } else {
            sum += (section + current || 1n) * unit;
            section = 0n;
            current = 0n;
          }
        }
      }
      text = (sum + section + current).toString();
    }
    if (fraction !== undefined) {
      if (!fraction || [...fraction].some((c) => !(c in digits)))
        throw new Error("中文小数无效");
      text += "." + [...fraction].map((c) => digits[c]).join("");
    }
  }
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("金额写法无效");
  const [whole, fraction = ""] = text.split(".");
  let scaled = BigInt(whole + fraction) * multiplier;
  let out = scaled.toString().padStart(fraction.length + 1, "0");
  if (fraction.length)
    out = out.slice(0, -fraction.length) + "." + out.slice(-fraction.length);
  return out
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "")
    .replace(/^0+(?=\d)/, "");
}
const numberPattern =
  /\d+(?:,\d{3})*(?:\.\d+)?[kKmMwW万千]?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?/g;
export function numberTokens(raw: string): string[] {
  return [...raw.normalize("NFKC").matchAll(numberPattern)].map((m) =>
    normalizeNumber(m[0]),
  );
}
export function amountSupported(value: Money, raw: string): boolean {
  return numberTokens(raw).includes(
    normalizeNumber(value.amount.replace(/^-/, " ").trim()),
  );
}
export function numberIssues(actions: FinanceAction[], raw: string): string[] {
  const result: string[] = [];
  const tokens = new Set(numberTokens(raw));
  for (const a of actions)
    if (a.type === "ledger.add")
      for (const leg of a.transaction.legs) {
        if (
          units(leg.money) !== 0n &&
          !tokens.has(normalizeNumber(leg.money.amount.replace("-", "")))
        )
          result.push(`${leg.money.asset} ${leg.money.amount} 未在原文中找到`);
      }
  if (
    /左右|大概|约|差不多|多(?:元|块|美元)|几(?:百|十|千|元|块)|不到|超过/.test(
      raw,
    )
  )
    result.push("原文金额不精确");
  return [...new Set(result)];
}
export function emptyProposal(): Proposal {
  return {
    entitiesToCreate: [],
    entitiesToUpdate: [],
    relationsToCreate: [],
    eventsToCreate: [],
    uncertainty: [],
  };
}
export const expenseCategories = [
  "餐饮",
  "出行",
  "购物",
  "居住",
  "账单",
  "医疗",
  "娱乐",
  "学习",
  "其他支出",
];
export const incomeCategories = ["工资", "投资收益", "其他收入"];
export function expenseCategory(text: string): string {
  if (/早餐|午餐|晚餐|早饭|午饭|晚饭|吃饭|餐饮|外卖|咖啡|奶茶|餐厅/.test(text))
    return "餐饮";
  if (/打车|出租车|滴滴|地铁|公交|车费|高铁|机票|出行/.test(text))
    return "出行";
  if (/房租|物业|居住/.test(text)) return "居住";
  if (/订阅|续费|话费|水费|电费|网费|账单/.test(text)) return "账单";
  if (/看病|挂号|药费|医院|医疗/.test(text)) return "医疗";
  if (/电影|游戏|娱乐/.test(text)) return "娱乐";
  if (/学费|课程|买书|学习/.test(text)) return "学习";
  if (/买了|购物|淘宝|京东/.test(text)) return "购物";
  return "其他支出";
}
export function ledgerAccountOptions(
  s: VaultSnapshot,
  asset = "CNY",
): LedgerAccount[] {
  const accounts = (s.ledgerAccounts ?? []).filter(
    (a) => a.privacy !== "SECRET" && !a.archived,
  );
  const options = [...accounts];
  for (const e of s.entities) {
    if (e.privacy === "SECRET" || ["ARCHIVED", "INACTIVE"].includes(e.status))
      continue;
    const wallet =
      ["Account", "Website Account", "Generic", "Wallet"].includes(
        e.category,
      ) &&
      /支付宝|微信|alipay|wechat|weixin|paypal|钱包|wallet/i.test(
        e.name +
          " " +
          e.fields
            .filter(
              (f) =>
                f.privacy !== "SECRET" &&
                ["platform", "provider", "service"].includes(f.key),
            )
            .map((f) => f.value)
            .join(" "),
      );
    if (!["Payment Card", "Bank Account"].includes(e.category) && !wallet)
      continue;
    const currency = e.fields.find(
      (f) => f.key === "currency" && f.privacy !== "SECRET",
    )?.value;
    if (
      typeof currency === "string" &&
      /^[A-Z]{3,4}$/.test(currency) &&
      currency !== asset
    )
      continue;
    if (
      s.ledgerAccounts?.some(
        (a) =>
          (a.entityRef === e.id || a.name === e.name) &&
          a.asset === asset &&
          ["ASSET", "LIABILITY"].includes(a.kind),
      )
    )
      continue;
    options.push({
      id: `asset-account:${e.id}:${asset}`,
      name: e.name,
      kind: /信用卡|credit card/i.test(e.name) ? "LIABILITY" : "ASSET",
      asset,
      entityRef: e.id,
      privacy: "PRIVATE",
    });
  }
  const defaults: LedgerAccount[] = [
    {
      id: `unassigned:${asset}`,
      name: "未指定账户",
      kind: "ASSET",
      asset,
      privacy: "PRIVATE",
    },
    ...expenseCategories.map((name, i) => ({
      id: `expense:${i}`,
      name,
      kind: "EXPENSE" as const,
      privacy: "PRIVATE" as const,
    })),
    ...incomeCategories.map((name, i) => ({
      id: `income:${i}`,
      name,
      kind: "INCOME" as const,
      privacy: "PRIVATE" as const,
    })),
    {
      id: "opening-equity",
      name: "期初与调整",
      kind: "EQUITY",
      privacy: "PRIVATE",
    },
  ];
  for (const a of defaults)
    if (
      !options.some(
        (v) => v.kind === a.kind && v.name === a.name && v.asset === a.asset,
      )
    )
      options.push(a);
  return options;
}
export function resolveLedgerAccount(
  s: VaultSnapshot,
  actions: FinanceAction[],
  value: string,
  kind: LedgerAccount["kind"],
  asset: string,
  fallback: string,
): LedgerAccount {
  const pending = actions.flatMap((a) =>
    a.type === "account.add" ? [a.account] : [],
  );
  const all = [...pending, ...ledgerAccountOptions(s, asset)];
  const options = all.filter(
    (a) =>
      (kind === "ASSET"
        ? ["ASSET", "LIABILITY"].includes(a.kind)
        : a.kind === kind) &&
      (!a.asset || a.asset === asset),
  );
  const name = value.trim() || fallback;
  if (all.some((a) => a.id === name) && !options.some((a) => a.id === name))
    throw new Error("账户或分类不匹配");
  const byId = options.find((a) => a.id === name);
  const byName = options.filter((a) => a.name === name);
  const concrete = byName.filter((a) =>
    [...pending, ...(s.ledgerAccounts ?? [])].some((v) => v.id === a.id),
  );
  const matches = byId ? [byId] : concrete.length ? concrete : byName;
  if (matches.length > 1 && new Set(matches.map((a) => a.id)).size > 1)
    throw new Error(`请选择具体账户：${name}`);
  const selected =
    matches[0] ??
    accountSchema.parse({
      id: newId("account"),
      name,
      kind,
      asset: ["ASSET", "LIABILITY"].includes(kind) ? asset : undefined,
      privacy: "PRIVATE",
    });
  const equivalent = [...pending, ...(s.ledgerAccounts ?? [])].find(
    (a) =>
      a.privacy !== "SECRET" &&
      !a.archived &&
      a.kind === selected.kind &&
      a.asset === selected.asset &&
      (selected.entityRef
        ? a.entityRef === selected.entityRef
        : a.name === selected.name),
  );
  // Asset-derived choice IDs stay in the preview; persisted account IDs reveal no links.
  const account =
    equivalent ??
    (s.ledgerAccounts?.some((a) => a.id === selected.id) ||
    pending.some((a) => a.id === selected.id)
      ? selected
      : { ...selected, id: newId("account") });
  if (
    !s.ledgerAccounts?.some((a) => a.id === account.id) &&
    !pending.some((a) => a.id === account.id)
  )
    actions.push({ type: "account.add", account });
  return account;
}
export function materializeFinanceAccounts(
  s: VaultSnapshot,
  actions: FinanceAction[],
): FinanceAction[] {
  actions = structuredClone(actions);
  const additions: FinanceAction[] = [];
  const mapped = new Map<string, string>();
  const reused = new Set<string>();
  for (const a of actions)
    if (a.type === "account.add") {
      const current = s.ledgerAccounts?.find((v) => v.id === a.account.id);
      if (
        current &&
        JSON.stringify(accountSchema.parse(current)) !==
          JSON.stringify(accountSchema.parse(a.account))
      )
        throw new Error(`账户已更新，请重新选择：${current.name}`);
      const existing =
        current ??
        s.ledgerAccounts?.find(
          (v) =>
            v.privacy === a.account.privacy &&
            !v.archived &&
            v.kind === a.account.kind &&
            v.asset === a.account.asset &&
            v.entityRef === a.account.entityRef &&
            (a.account.entityRef || v.name === a.account.name),
        );
      if (existing) {
        mapped.set(a.account.id, existing.id);
        reused.add(a.account.id);
      }
    }
  const known = new Set([
    ...(s.ledgerAccounts ?? []).map((a) => a.id),
    ...actions.flatMap((a) => (a.type === "account.add" ? [a.account.id] : [])),
  ]);
  for (const action of actions)
    if (action.type === "ledger.add")
      for (const leg of action.transaction.legs) {
        const replacement = mapped.get(leg.accountId);
        if (replacement) leg.accountId = replacement;
        if (known.has(leg.accountId)) continue;
        const choice = ledgerAccountOptions(
          { ...s, ledgerAccounts: [] },
          leg.money.asset,
        ).find((a) => a.id === leg.accountId);
        if (!choice) throw new Error("流水引用了不存在的账户");
        const existing = s.ledgerAccounts?.find(
          (a) =>
            !a.archived &&
            a.privacy !== "SECRET" &&
            a.kind === choice.kind &&
            a.asset === choice.asset &&
            (choice.entityRef
              ? a.entityRef === choice.entityRef
              : a.name === choice.name),
        );
        const account = resolveLedgerAccount(
          s,
          additions,
          existing?.id ?? choice.id,
          choice.kind,
          leg.money.asset,
          choice.name,
        );
        mapped.set(leg.accountId, account.id);
        leg.accountId = account.id;
        known.add(account.id);
      }
  const used = new Set(
    actions.flatMap((a) =>
      a.type === "ledger.add" ? a.transaction.legs.map((l) => l.accountId) : [],
    ),
  );
  return [
    ...additions,
    ...actions.filter(
      (a) =>
        a.type !== "account.add" ||
        (!reused.has(a.account.id) && used.has(a.account.id)),
    ),
  ];
}
export function applyFinanceActions(
  s: VaultSnapshot,
  actions: FinanceAction[],
  capture?: TextCapture,
): VaultSnapshot {
  const next = structuredClone(s);
  next.ledgerAccounts ??= [];
  next.transactions ??= [];
  for (const a of actions) {
    if (a.type === "account.add")
      next.ledgerAccounts.push(accountSchema.parse(a.account));
    else if (a.type === "ledger.add") {
      if (
        next.transactions.some(
          (t) => t.idempotencyKey === a.transaction.idempotencyKey,
        )
      )
        throw new Error("这笔流水已存在");
      next.transactions.push({
        ...structuredClone(a.transaction),
        source: {
          ...a.transaction.source,
          ...(capture ? { captureId: capture.id } : {}),
        },
      });
    } else {
      const t = next.transactions.find((t) => t.id === a.transactionId);
      if (!t) throw new Error("找不到原流水");
      next.transactions.push(
        reverseTransaction(t, a.occurredAt, a.id, a.idempotencyKey),
      );
    }
  }
  validateLedger(next);
  return next;
}
const currencyAliases: Record<string, string> = {
  USD: "USD",
  美元: "USD",
  美金: "USD",
  $: "USD",
  CNY: "CNY",
  人民币: "CNY",
  元: "CNY",
  块: "CNY",
  "¥": "CNY",
  "￥": "CNY",
  HKD: "HKD",
  港币: "HKD",
  港元: "HKD",
  JPY: "JPY",
  日元: "JPY",
  EUR: "EUR",
  欧元: "EUR",
  BTC: "BTC",
  比特币: "BTC",
  ETH: "ETH",
  USDT: "USDT",
  TWD: "TWD",
  台币: "TWD",
  SGD: "SGD",
  新币: "SGD",
  GBP: "GBP",
  英镑: "GBP",
  AUD: "AUD",
  澳元: "AUD",
  CAD: "CAD",
  加元: "CAD",
  KRW: "KRW",
  韩元: "KRW",
};
export function extractAmounts(raw: string): Money[] {
  const found: Money[] = [];
  const text = raw.normalize("NFKC");
  for (const match of text.matchAll(numberPattern)) {
    const end = match.index! + match[0].length,
      after = text.slice(end).trimStart(),
      before = text.slice(0, match.index).trimEnd();
    const alias = Object.keys(currencyAliases)
      .sort((a, b) => b.length - a.length)
      .find(
        (a) =>
          after.toUpperCase().startsWith(a) || before.toUpperCase().endsWith(a),
      );
    if (alias) {
      try {
        found.push(money(normalizeNumber(match[0]), currencyAliases[alias]));
      } catch {
        /* Invalid precision stays unresolved in the preview. */
      }
    }
  }
  return found;
}
export function localLedgerProposal(
  raw: string,
  s: VaultSnapshot,
  date = dateToday(),
): Proposal | null {
  if (
    !/记账|花了|支出|付了|支付|续费|收入|收款|收到|转账|转入|转出|(?:没|未)付|撤销刚才|冲正|早餐|午餐|晚餐|早饭|午饭|晚饭|打车|车费/.test(
      raw,
    )
  )
    return null;
  const p = emptyProposal();
  p.financeActions = [];
  if (/撤销刚才|冲正/.test(raw) && !/不要|别|不撤销|不冲正/.test(raw)) {
    const reversed = new Set(s.transactions?.map((t) => t.reversalOf));
    const t = [...(s.transactions ?? [])]
      .reverse()
      .find(
        (t) => !t.reversalOf && !reversed.has(t.id) && t.privacy !== "SECRET",
      );
    if (t)
      p.financeActions.push({
        type: "ledger.reverse",
        transactionId: t.id,
        id: newId("tx"),
        idempotencyKey: newId("reverse"),
        occurredAt: date,
      });
    else p.uncertainty.push("没有可冲正的流水");
    return p;
  }
  const clauses = raw.split(/[，。；;\n]|,(?!\d{3}(?:\D|$))/).filter(Boolean);
  let context = "";
  for (const clause of clauses) {
    if (
      /没(?:有)?(?:付|花|转|收到)|不要|别记|取消记|未(?:付|收)|打算|计划|准备/.test(
        clause,
      )
    ) {
      continue;
    }
    if (
      /交易|买入|卖出|涨到|跌到/.test(clause) &&
      !/花了|付了|支出|收入/.test(clause)
    )
      continue;
    if (/打车[^\d]*次\s*$/.test(clause)) {
      context = "打车";
      continue;
    }
    const repeated = /^\s*第[一二两三四五六七八九十\d]+次/.test(clause);
    const note = repeated ? `${context} ${clause}` : clause;
    if (!repeated) context = expenseCategory(clause) === "出行" ? "打车" : "";
    const amounts = extractAmounts(clause);
    if (
      !amounts.length &&
      !/\b(?:USD|HKD|JPY|EUR|BTC|ETH|USDT|TWD|SGD|GBP|AUD|CAD|KRW)\b/i.test(
        clause,
      )
    ) {
      const bare =
        clause
          .replace(/第[一二两三四五六七八九十\d]+次/g, "")
          .replace(/\d{4}-\d{2}(?:-\d{2})?/g, "")
          .match(/\d+(?:\.\d+)?/g) ?? [];
      if (bare.length === 1) amounts.push(money(bare[0], "CNY"));
    }
    if (amounts.length !== 1) {
      if (!amounts.length && !/\d/.test(clause)) continue;
      p.uncertainty.push(
        amounts.length
          ? "一句有多笔金额，请拆开或用表单核对"
          : "请补充金额与币种",
      );
      continue;
    }
    const amount = amounts[0];
    const kind = /收入|收款|收到/.test(clause)
      ? "INCOME"
      : /转账|转入|转出/.test(clause)
        ? "TRANSFER"
        : "SPEND";
    const accounts = ledgerAccountOptions(s, amount.asset).filter(
      (a) =>
        a.privacy !== "SECRET" &&
        !a.archived &&
        (!a.asset || a.asset === amount.asset),
    );
    const named = accounts.filter((a) => clause.includes(a.name));
    const funds = named
      .filter((a) => ["ASSET", "LIABILITY"].includes(a.kind))
      .filter(
        (a) =>
          !named.some(
            (other) => other.name !== a.name && other.name.includes(a.name),
          ),
      );
    let fund = funds[0];
    let counter =
      named.find(
        (a) => a.kind === (kind === "INCOME" ? "INCOME" : "EXPENSE"),
      ) ??
      accounts.find(
        (a) =>
          a.name === (kind === "INCOME" ? "其他收入" : expenseCategory(note)),
      );
    if (kind === "TRANSFER") {
      const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const directions = funds.flatMap((source) =>
        funds
          .filter(
            (target) =>
              target.id !== source.id &&
              new RegExp(
                `${escape(source.name)}[^。；;]*?转(?:账|出)?[^。；;]*?(?:到|至|入|给)\\s*${escape(target.name)}`,
              ).test(clause),
          )
          .map((target) => ({ source, target })),
      );
      if (funds.length !== 2 || directions.length !== 1) {
        p.uncertainty.push("请明确从哪个账户转到哪个账户");
        continue;
      }
      fund = directions[0].source;
      counter = directions[0].target;
    } else {
      if (funds.length > 1) {
        p.uncertainty.push("这笔用了多个账户，请在预览中选择");
        continue;
      }
      const explicit = clause.match(/支付宝|微信|现金/)?.[0] ?? "";
      fund = resolveLedgerAccount(
        s,
        p.financeActions,
        fund?.id || explicit,
        "ASSET",
        amount.asset,
        "未指定账户",
      );
      counter = resolveLedgerAccount(
        s,
        p.financeActions,
        counter?.id ?? "",
        kind === "INCOME" ? "INCOME" : "EXPENSE",
        amount.asset,
        kind === "INCOME" ? "其他收入" : expenseCategory(note),
      );
    }
    if (!fund || !counter) throw new Error("流水缺少账户");
    for (const account of [fund, counter])
      if (
        !s.ledgerAccounts?.some((a) => a.id === account.id) &&
        !p.financeActions.some(
          (a) => a.type === "account.add" && a.account.id === account.id,
        )
      )
        p.financeActions.push({ type: "account.add", account });
    const projects = s.entities.filter(
      (e) =>
        e.privacy !== "SECRET" &&
        e.category === "Project" &&
        clause.includes(e.name),
    );
    const resources = s.entities.filter(
      (e) =>
        e.privacy !== "SECRET" &&
        ["Subscription", "Server", "Domain", "AI Provider Account"].includes(
          e.category,
        ) &&
        clause.includes(e.name),
    );
    let occurredAt = clause.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? date;
    if (clause.includes("昨天")) {
      const d = new Date(`${date}T12:00:00`);
      d.setDate(d.getDate() - 1);
      occurredAt = d.toLocaleDateString("sv-SE");
    }
    if (projects.length > 1 || resources.length > 1) {
      p.uncertainty.push("项目或资源不唯一，请拆开录入");
      continue;
    }
    p.financeActions.push({
      type: "ledger.add",
      transaction: makeEntry({
        kind,
        amount,
        accountId: fund.id,
        counterId: counter.id,
        date: occurredAt,
        note,
        projectId: projects[0]?.id,
        resourceId: resources[0]?.id,
      }),
      evidence: clause,
    });
  }
  p.uncertainty.push(...numberIssues(p.financeActions, raw));
  return p;
}
export function legacyCosts(
  s: VaultSnapshot,
): Array<{ entityId: string; text: string; proposal: Proposal }> {
  return s.entities
    .filter(
      (e) => e.privacy !== "SECRET" && !e.fields.some((f) => f.key === "fee"),
    )
    .flatMap((e) => {
      const cost = e.fields.find(
        (f) =>
          f.key === "cost" &&
          f.privacy !== "SECRET" &&
          typeof f.value === "string",
      );
      if (!cost) return [];
      const text = String(cost.value),
        values = extractAmounts(text);
      if (values.length !== 1 || /约|左右|多|大概/.test(text)) return [];
      const p = emptyProposal();
      p.entitiesToUpdate = [
        {
          id: e.id,
          name: e.name,
          type: (["Subscription", "Server", "Domain"].includes(e.category)
            ? e.category
            : "Account") as "Subscription",
          status: e.status as "ACTIVE",
          attributes: {
            fee: values[0],
            billing_period: /年|year/i.test(text)
              ? "yearly"
              : /月|month/i.test(text)
                ? "monthly"
                : "usage",
          },
          notes: "",
          evidence: text,
          expectedUpdatedAt: e.updatedAt,
        },
      ];
      return [{ entityId: e.id, text, proposal: p }];
    });
}
