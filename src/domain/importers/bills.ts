import type { VaultSnapshot } from "../../lib/types";
import { expenseCategory, resolveLedgerAccount } from "../finance-capture";
import { makeEntry, type FinanceAction, type LedgerAccount } from "../ledger";
import { money, units } from "../money";
import { parseCsv } from "./csv";
import { norm, privateEntity } from "./assets";
import type {
  BillColumn,
  BillPreview,
  BillRow,
  ColumnMapping,
  SubscriptionCandidate,
} from "./types";

const aliases: Record<BillColumn, string[]> = {
  date: [
    "交易时间",
    "交易日期",
    "日期",
    "时间",
    "date",
    "posted date",
    "transaction date",
    "datetime",
  ],
  amount: ["金额(元)", "金额", "交易金额", "amount", "value", "total"],
  direction: [
    "收/支",
    "收支类型",
    "收支",
    "类型",
    "direction",
    "type",
    "transaction type",
    "debit/credit",
  ],
  payee: [
    "交易对方",
    "交易对象",
    "商户",
    "对方",
    "payee",
    "imported payee",
    "merchant",
    "name",
  ],
  note: [
    "商品说明",
    "商品",
    "备注",
    "说明",
    "描述",
    "note",
    "notes",
    "memo",
    "description",
  ],
  category: ["交易分类", "分类", "类别", "交易类型", "category"],
  account: [
    "收/付款方式",
    "支付方式",
    "账户",
    "账户1",
    "account",
    "account name",
  ],
  asset: ["币种", "货币", "asset", "currency", "currency code"],
};
const key = (s: string) => norm(s).replace(/[ \t]/g, "");
const hash = (s: string) => {
  let h = 14695981039346656037n;
  for (let i = 0; i < s.length; i++)
    h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * 1099511628211n);
  return h.toString(36);
};
const signedAmount = (raw: string) =>
  raw
    .trim()
    .normalize("NFKC")
    .replace(/^\(([^()]+)\)$/, "-$1")
    .replace(/^([+-]?)[¥$£€]\s*/, "$1");
function decimal(raw: string) {
  const text = signedAmount(raw);
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text))
    throw new Error("金额格式无效");
  return text
    .replace(/,/g, "")
    .replace(/^[+-]/, "")
    .replace(/^0+(?=\d)/, "");
}
export interface BillOptions {
  currency?: string;
  dateOrder?: "auto" | "mdy" | "dmy";
  positiveExpense?: boolean;
}
function billDate(text: string, order: BillOptions["dateOrder"]) {
  const western = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (western) {
    const [, a, b, year] = western;
    if ((!order || order === "auto") && +a <= 12 && +b <= 12 && a !== b)
      throw new Error("日期存在日/月歧义，请改用 YYYY-MM-DD");
    text =
      order === "dmy" || ((!order || order === "auto") && +a > 12)
        ? year + "/" + b + "/" + a
        : year + "/" + a + "/" + b;
  }
  const m = text
    .trim()
    .match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:$|[ T])/);
  if (!m) throw new Error("需要年、月、日明确的日期");
  const day = [m[1], m[2].padStart(2, "0"), m[3].padStart(2, "0")].join("-");
  if (
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new Error("日期无效");
  return day;
}
const known =
  /apple(?:\.com)?|icloud|openai|chatgpt|claude|anthropic|github|cloudflare|google\s*one|netflix|spotify|youtube|microsoft\s*365|cursor|notion|\bvps\b|服务器|话费|宽带|中国(?:移动|联通|电信)/i;
function discover(rows: BillRow[], s: VaultSnapshot) {
  const groups = new Map<string, BillRow[]>(),
    candidates: SubscriptionCandidate[] = [];
  for (const row of rows) {
    if (row.transaction.kind !== "SPEND" || row.excluded) continue;
    const name = row.transaction.payee || row.transaction.note;
    if (!name) continue;
    const k = norm(name) + "|" + row.value.asset,
      group = groups.get(k) ?? [];
    group.push(row);
    groups.set(k, group);
  }
  // A monthly pattern may straddle two export files.
  const reversed = new Set(s.transactions?.map((t) => t.reversalOf));
  const history = new Map<string, Set<number>>();
  for (const t of s.transactions ?? []) {
    if (
      t.kind !== "SPEND" ||
      t.privacy === "SECRET" ||
      t.reversalOf ||
      reversed.has(t.id) ||
      !t.payee
    )
      continue;
    const m = t.legs[0].money,
      key = JSON.stringify([norm(t.payee), m.asset, units(m).toString()]);
    const days = history.get(key) ?? new Set<number>();
    days.add(Date.parse(t.occurredAt) / 86400000);
    history.set(key, days);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      b.transaction.occurredAt.localeCompare(a.transaction.occurredAt),
    );
    const latest = group[0],
      name = latest.transaction.payee || latest.transaction.note!;
    const repeated = group.some((r, i) => {
      const older = group[i + 1];
      if (!older || r.value.amount !== older.value.amount) return false;
      const days =
        (Date.parse(r.transaction.occurredAt) -
          Date.parse(older.transaction.occurredAt)) /
        86400000;
      return days >= 26 && days <= 33;
    });
    const prior = group.some((r) => {
      const days = history.get(
        JSON.stringify([
          norm(name),
          r.value.asset,
          (-units(r.value)).toString(),
        ]),
      );
      const day = Date.parse(r.transaction.occurredAt) / 86400000;
      for (let lag = 26; days && lag <= 33; lag++)
        if (days.has(day - lag) || days.has(day + lag)) return true;
      return false;
    });
    if (
      !repeated &&
      !prior &&
      !group.some((r) => known.test(name + " " + (r.transaction.note ?? "")))
    )
      continue;
    if (
      s.entities.some(
        (e) =>
          e.privacy !== "SECRET" &&
          e.category === "Subscription" &&
          norm(e.name) === norm(name),
      )
    )
      continue;
    if (candidates.some((c) => norm(c.entity.name) === norm(name))) continue;
    candidates.push({
      entity: privateEntity("Subscription", name, {
        fee: latest.value,
        billing_period: "monthly",
      }),
      rowIds: group.map((r) => r.id),
      fee: latest.value,
    });
  }
  return candidates;
}
export function parseBills(
  text: string,
  snapshot: VaultSnapshot,
  custom: ColumnMapping = {},
  options: BillOptions = {},
): BillPreview {
  const platformHeader =
    /^(?=[^\r\n]*交易对方)(?=[^\r\n]*交易时间)(?=[^\r\n]*(?:交易单号|交易订单号|收\/付款方式|支付方式))[^\r\n]+/m.exec(
      text,
    );
  const body = platformHeader
    ? text
        .slice(platformHeader.index)
        .split(/[\r\n]+[-=]{3,}\s*(?:支付宝|结束|以下|共计)/)[0]
    : text;
  const [head = [], ...data] = parseCsv(body);
  const headers = head.map((h) => h.trim()),
    keys = headers.map(key);
  if (!headers.some(Boolean)) throw new Error("文件没有表头");
  if (keys.some((k) => /^(login_?)?password$|^密码$|^otpauth$/.test(k)))
    throw new Error("密码管理器文件请使用「账号与密码管理器」导入");
  const col = (...names: string[]) =>
    keys.findIndex((v) => names.map(key).includes(v));
  const format =
    col("交易订单号") >= 0 || (platformHeader && col("收/付款方式") >= 0)
      ? "alipay"
      : col("交易单号") >= 0 || platformHeader
        ? "wechat"
        : "generic";
  const mapping: ColumnMapping = {};
  for (const k of Object.keys(aliases) as BillColumn[]) {
    const found = aliases[k].map((a) => col(a)).find((i) => i >= 0);
    if (found !== undefined) mapping[k] = headers[found];
  }
  Object.assign(mapping, custom);
  const at = (k: BillColumn) =>
    mapping[k] ? headers.indexOf(mapping[k]!) : -1;
  const debit = col("outflow", "debit", "支出金额"),
    credit = col("inflow", "credit", "收入金额");
  const warnings: string[] = [],
    rows: BillRow[] = [],
    additions: FinanceAction[] = [];
  const preview: BillPreview = {
    kind: "bills",
    revision: snapshot.revision,
    format,
    headers,
    mapping,
    rows,
    accounts: [],
    duplicateCount: 0,
    subscriptions: [],
    warnings,
  };
  if (at("date") < 0 || (at("amount") < 0 && debit < 0 && credit < 0)) {
    warnings.push("请选择日期与金额列后预览");
    return preview;
  }
  const occurrences = new Map<string, number>(),
    savedKeys = new Set(snapshot.transactions?.map((t) => t.idempotencyKey)),
    first = new Map<string, BillRow>();
  const destinationCol = col(
    "账户2",
    "转入账户",
    "destination account",
    "to account",
  );
  const statusCol = col("当前状态", "交易状态", "状态", "status"),
    orderCol = col("交易单号", "交易订单号", "transaction id", "order id");
  const cache = new Map<string, LedgerAccount>();
  const accountFor = (
    name: string,
    kind: LedgerAccount["kind"],
    asset: string,
  ) => {
    const k = JSON.stringify([name, kind, asset]);
    let a = cache.get(k);
    if (!a) {
      a = resolveLedgerAccount(snapshot, additions, name, kind, asset, name);
      cache.set(k, a);
    }
    return a;
  };
  for (const [i, line] of data.entries()) {
    if (line.every((v) => !v.trim())) continue;
    if (
      format !== "generic" &&
      /^(?:[-=]{3,}|共计|合计|收入合计|支出合计|导出时间)/.test(
        line.find((v) => v.trim())?.trim() ?? "",
      )
    )
      break;
    const get = (k: BillColumn) => (line[at(k)] ?? "").trim();
    try {
      if (line.length !== head.length) throw new Error("列数与表头不符");
      const date = billDate(get("date"), options.dateOrder),
        direction = norm(get("direction")),
        asset = (get("asset") || options.currency || "CNY").toUpperCase(),
        payee = get("payee"),
        note = get("note"),
        status = line[statusCol]?.trim() ?? "",
        rawCategory = get("category"),
        dual = at("amount") < 0,
        inflow =
          dual &&
          !!line[credit]?.trim() &&
          units(money(decimal(line[credit]), asset)) > 0n;
      if (
        inflow &&
        line[debit]?.trim() &&
        units(money(decimal(line[debit]), asset)) !== 0n
      )
        throw new Error("收入和支出列同时非零");
      const raw = signedAmount(
        dual ? (line[inflow ? credit : debit] ?? "") : get("amount"),
      );
      const value = money(decimal(raw), asset);
      if (!units(value)) throw new Error("零金额不入账");
      const transfer =
        /内部转账|内部划转|提现|转入余额|信用卡还款|transfer/i.test(
          direction + " " + rawCategory,
        ) ||
        /^(转账|划转)$/.test(direction) ||
        rawCategory === "转账";
      const refund = /退款|退费|refund/i.test(
        direction + " " + rawCategory + " " + status,
      );
      const neutral = /不计收支|不计入|中性|^\/$/.test(direction);
      const failed =
        /失败|关闭|撤销|取消|未成功|未支付|待支付|failed|closed/i.test(status);
      const income =
        /^(收入|收|入账|转入|贷方|income|inflow|credit|cr|deposit)$/i.test(
          direction,
        );
      const spend =
        /^(支出|支|出账|转出|借方|expense|spend|outflow|debit|dr|withdrawal)$/i.test(
          direction,
        );
      const kind = transfer
        ? "TRANSFER"
        : income ||
            (!spend &&
              (refund ||
                inflow ||
                (!direction &&
                  !dual &&
                  (options.positiveExpense
                    ? raw.startsWith("-")
                    : !raw.startsWith("-")))))
          ? "INCOME"
          : "SPEND";
      const destination = line[destinationCol]?.trim();
      const mappedCategory =
        format === "wechat" &&
        /^(商户消费|扫二维码付款|二维码收款)$/.test(rawCategory)
          ? ""
          : rawCategory;
      const category =
        kind === "TRANSFER"
          ? destination || "待选择转入账户"
          : mappedCategory ||
            (kind === "INCOME"
              ? "其他收入"
              : known.test(payee + " " + note)
                ? "账单"
                : expenseCategory(payee + note));
      const account =
        get("account") ||
        { wechat: "微信", alipay: "支付宝", generic: "未指定账户" }[format];
      const a = accountFor(account, "ASSET", asset),
        c = accountFor(
          category,
          kind === "TRANSFER"
            ? "ASSET"
            : kind === "SPEND"
              ? "EXPENSE"
              : "INCOME",
          asset,
        );
      const t = makeEntry({
        kind,
        amount: value,
        accountId: a.id,
        counterId: c.id,
        date,
        payee,
        note,
      });
      const order = line[orderCol]?.trim(),
        signature = JSON.stringify([
          format,
          get("date"),
          value,
          kind,
          norm(payee),
          norm(account),
          norm(note),
        ]);
      const n = (occurrences.get(signature) ?? 0) + 1;
      occurrences.set(signature, n);
      t.idempotencyKey =
        "import:" +
        format +
        ":" +
        (order
          ? format === "generic"
            ? "id:" + hash(JSON.stringify([norm(account), asset, order]))
            : order
          : "row:" + hash(signature) + ":" + n);
      if (
        t.idempotencyKey.length > 200 ||
        payee.length > 500 ||
        note.length > 5000
      )
        throw new Error("订单号、对方或备注过长");
      t.source = { import: format };
      const prior = first.get(t.idempotencyKey);
      const excluded = failed
        ? status
        : transfer
          ? "内部划转"
          : refund
            ? "退款"
            : neutral
              ? "不计收支"
              : direction && !income && !spend
                ? "收支方向待核对"
                : "";
      const row: BillRow = {
        id: t.id,
        transaction: t,
        value,
        category,
        account,
        duplicate: savedKeys.has(t.idempotencyKey) || !!prior,
        excluded,
        status,
        needsDestination: kind === "TRANSFER" && !destination,
      };
      if (prior?.excluded && !excluded && !savedKeys.has(t.idempotencyKey)) {
        prior.duplicate = true;
        row.duplicate = false;
      }
      if (!row.duplicate) first.set(t.idempotencyKey, row);
      rows.push(row);
    } catch (e) {
      warnings.push(
        "第 " +
          (i + 2) +
          " 行：" +
          (e instanceof Error && !e.message.startsWith("[")
            ? e.message
            : "金额、币种或字段无效"),
      );
    }
  }
  preview.duplicateCount = rows.filter((r) => r.duplicate).length;
  preview.accounts = additions.flatMap((a) =>
    a.type === "account.add" ? [a.account] : [],
  );
  preview.subscriptions = discover(rows, snapshot);
  return preview;
}

// Reclassify an unchecked bank row without changing its source identity.
export function reviseBillRow(
  snapshot: VaultSnapshot,
  p: BillPreview,
  id: string,
  kind: "SPEND" | "INCOME" | "TRANSFER",
  account: string,
  category: string,
): BillPreview {
  const row = p.rows.find((r) => r.id === id);
  if (!row || row.duplicate) throw new Error("已导入的记录不可修改");
  if (!account.trim() || !category.trim())
    throw new Error("请填写账户与分类或转入账户");
  const actions: FinanceAction[] = p.accounts.map((account) => ({
    type: "account.add",
    account,
  }));
  const asset = row.value.asset,
    a = resolveLedgerAccount(
      snapshot,
      actions,
      account,
      "ASSET",
      asset,
      account,
    ),
    c = resolveLedgerAccount(
      snapshot,
      actions,
      category,
      kind === "TRANSFER" ? "ASSET" : kind === "INCOME" ? "INCOME" : "EXPENSE",
      asset,
      category,
    );
  const entry = makeEntry({
    kind,
    amount: row.value,
    accountId: a.id,
    counterId: c.id,
    date: row.transaction.occurredAt,
  });
  const rows = p.rows.map((r) =>
    r.id !== id
      ? r
      : {
          ...r,
          account: a.name,
          category: c.name,
          needsDestination: false,
          transaction: { ...r.transaction, kind, legs: entry.legs },
        },
  );
  return {
    ...p,
    rows,
    subscriptions: p.subscriptions.filter((c) =>
      c.rowIds.some((id) =>
        rows.some((r) => r.id === id && r.transaction.kind === "SPEND"),
      ),
    ),
    accounts: actions.flatMap((a) =>
      a.type === "account.add" ? [a.account] : [],
    ),
  };
}
