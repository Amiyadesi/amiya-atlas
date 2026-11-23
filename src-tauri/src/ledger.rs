use crate::domain::{self, Result, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Money {
    pub amount: String,
    pub asset: String,
}
pub fn precision(asset: &str) -> Result<u32> {
    match asset {
        "JPY" | "KRW" => Ok(0),
        "BTC" => Ok(8),
        "ETH" => Ok(18),
        "USDT" => Ok(6),
        "CNY" | "USD" | "HKD" | "TWD" | "EUR" | "GBP" | "SGD" | "AUD" | "CAD" => Ok(2),
        _ => Err("未知币种".into()),
    }
}
pub fn units(m: &Money) -> Result<i128> {
    let d = precision(&m.asset)?;
    let text = m.amount.strip_prefix('-').unwrap_or(&m.amount);
    let mut parts = text.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    if parts.next().is_some()
        || whole.is_empty()
        || whole.len() > 18
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || (whole.len() > 1 && whole.starts_with('0'))
        || fraction.is_some_and(|f| {
            f.is_empty() || f.len() > d as usize || !f.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err("金额必须是符合币种精度的十进制字符串".into());
    }
    let fraction = fraction.unwrap_or("");
    let n = format!(
        "{whole}{fraction}{}",
        "0".repeat(d as usize - fraction.len())
    )
    .parse::<i128>()
    .map_err(|_| "金额超限")?;
    Ok(if m.amount.starts_with('-') { -n } else { n })
}
pub fn from_units(n: i128, asset: &str) -> Result<Money> {
    let d = precision(asset)? as usize;
    let digits = format!("{:0width$}", n.abs(), width = d + 1);
    Ok(Money {
        asset: asset.into(),
        amount: format!(
            "{}{}",
            if n < 0 { "-" } else { "" },
            if d == 0 {
                digits
            } else {
                format!(
                    "{}.{}",
                    &digits[..digits.len() - d],
                    &digits[digits.len() - d..]
                )
            }
        ),
    })
}
pub fn money_value(v: &Value) -> Result<()> {
    units(&serde_json::from_value::<Money>(v.clone()).map_err(|_| "金额格式无效")?).map(|_| ())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub privacy: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Leg {
    pub account_id: String,
    pub money: Money,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Refs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transaction {
    pub id: String,
    pub occurred_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision: Option<String>,
    pub kind: String,
    pub legs: Vec<Leg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payee: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refs: Option<Refs>,
    pub source: Source,
    pub idempotency_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reversal_of: Option<String>,
    pub created_at: String,
    pub privacy: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Share {
    pub project_id: String,
    pub weight: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Allocation {
    pub id: String,
    pub resource_id: String,
    pub effective_from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_to: Option<String>,
    pub shares: Vec<Share>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Action {
    #[serde(rename = "account.add")]
    AccountAdd { account: Account },
    #[serde(rename = "ledger.add")]
    LedgerAdd {
        transaction: Transaction,
        evidence: String,
    },
    #[serde(rename = "ledger.reverse", rename_all = "camelCase")]
    LedgerReverse {
        transaction_id: String,
        id: String,
        idempotency_key: String,
        occurred_at: String,
    },
}
fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err("账本字段缺失或过长".into());
    }
    domain::reject_credential(value)
}
fn privacy(v: &str) -> Result<()> {
    if ["PUBLIC", "PRIVATE", "SECRET"].contains(&v) {
        Ok(())
    } else {
        Err("隐私级别无效".into())
    }
}
fn day(value: &str) -> Result<()> {
    if value.len() != 10 {
        return Err("账本日期需要明确到日".into());
    }
    domain::date(value)
}
fn validate_trades(s: &Snapshot) -> Result<()> {
    let accounts: HashMap<_, _> = s.ledger_accounts.iter().map(|a| (&a.id, a)).collect();
    let reversed: HashSet<_> = s
        .transactions
        .iter()
        .filter_map(|t| t.reversal_of.as_ref())
        .collect();
    let mut trades: Vec<_> = s
        .transactions
        .iter()
        .filter(|t| t.kind == "TRADE" && t.reversal_of.is_none() && !reversed.contains(&t.id))
        .collect();
    trades.sort_by(|a, b| {
        (&a.occurred_at, &a.created_at, &a.id).cmp(&(&b.occurred_at, &b.created_at, &b.id))
    });
    let mut holdings: HashMap<(&String, &String), i128> = HashMap::new();
    let mut quotes = HashMap::new();
    for t in trades {
        let held = &t.legs[0];
        let clearing: Vec<_> = t
            .legs
            .iter()
            .filter(|l| {
                accounts
                    .get(&l.account_id)
                    .is_some_and(|a| a.kind == "EQUITY")
            })
            .collect();
        if accounts
            .get(&held.account_id)
            .is_none_or(|a| a.kind != "ASSET")
            || clearing.len() != 2
            || !clearing.iter().any(|c| {
                c.money.asset == held.money.asset
                    && units(&c.money).ok() == units(&held.money).ok().map(|n| -n)
            })
            || !clearing.iter().any(|c| c.money.asset != held.money.asset)
        {
            return Err("交易必须包含持仓、资金及逐币种清算分录".into());
        }
        let key = (&held.account_id, &held.money.asset);
        let quote = &t.legs[3].money.asset;
        if quotes.insert(key, quote).is_some_and(|old| old != quote) {
            return Err("同一持仓账户需使用同一计价币种，请另建账户".into());
        }
        let balance = holdings.entry(key).or_default();
        *balance = balance.checked_add(units(&held.money)?).ok_or("持仓超限")?;
        if *balance < 0 {
            return Err("交易历史存在超卖，请检查日期或冲正".into());
        }
    }
    Ok(())
}
fn validate_entry_accounts(t: &Transaction, accounts: &HashMap<&String, &Account>) -> Result<()> {
    let kind = |i: usize| accounts[&t.legs[i].account_id].kind.as_str();
    let fund = |i| matches!(kind(i), "ASSET" | "LIABILITY");
    if matches!(t.kind.as_str(), "SPEND" | "INCOME" | "TRANSFER" | "OPENING") {
        let counter = match t.kind.as_str() {
            "SPEND" => kind(1) == "EXPENSE",
            "INCOME" => kind(1) == "INCOME",
            "OPENING" => kind(1) == "EQUITY",
            _ => fund(1),
        };
        if !fund(0) || !counter || t.legs[0].account_id == t.legs[1].account_id {
            return Err("付款/收款账户与分类不匹配".into());
        }
        if t.kind != "OPENING"
            && (units(&t.legs[0].money)?.signum() != if t.kind == "INCOME" { 1 } else { -1 }
                || units(&t.legs[1].money)? != -units(&t.legs[0].money)?)
        {
            return Err("收支金额方向无效".into());
        }
    }
    if t.kind == "TRADE" {
        if ![4, 6].contains(&t.legs.len()) {
            return Err("交易分录数量无效".into());
        }
        if kind(0) != "ASSET"
            || kind(2) != "ASSET"
            || kind(1) != "EQUITY"
            || t.legs[1].account_id != t.legs[3].account_id
            || t.legs[0].account_id == t.legs[2].account_id
            || t.legs[0].money.asset == t.legs[2].money.asset
            || units(&t.legs[0].money)? == 0
            || units(&t.legs[0].money)?.signum() != units(&t.legs[3].money)?.signum()
            || units(&t.legs[2].money)? != -units(&t.legs[3].money)?
        {
            return Err("交易的持仓、资金和清算分录无效".into());
        }
        if t.legs.len() == 6
            && (t.legs[4].account_id != t.legs[2].account_id
                || kind(5) != "EXPENSE"
                || t.legs[5].money.asset != t.legs[2].money.asset
                || units(&t.legs[5].money)? <= 0
                || units(&t.legs[4].money)? != -units(&t.legs[5].money)?)
        {
            return Err("交易手续费分录无效".into());
        }
    }
    Ok(())
}
fn reference(s: &Snapshot, id: Option<&String>, category: Option<&str>) -> Result<()> {
    if let Some(id) = id {
        if !s
            .entities
            .iter()
            .any(|e| &e.id == id && category.is_none_or(|c| e.category == c))
        {
            return Err("账本引用的实体、项目或订单不存在".into());
        }
    }
    Ok(())
}
fn weight(w: f64) -> Result<u64> {
    if !w.is_finite() || !(0.0..=1.0).contains(&w) || (w * 1e6 - (w * 1e6).round()).abs() > 0.00001
    {
        return Err("比例无效，最多六位小数".into());
    }
    Ok((w * 1e6).round() as u64)
}
pub fn validate(s: &Snapshot) -> Result<()> {
    if s.transactions.len() > 100000
        || s.ledger_accounts.len() > 10000
        || s.finance_records.len() > 10000
        || s.allocation_rules.len() > 10000
    {
        return Err("账本容量超过限制".into());
    }
    let mut ids = HashSet::new();
    let mut unique = |id: &str| -> Result<()> {
        text(id, 200)?;
        if !ids.insert(id.to_string()) {
            return Err("重复账本记录 ID".into());
        }
        Ok(())
    };
    let accounts: HashMap<_, _> = s.ledger_accounts.iter().map(|a| (&a.id, a)).collect();
    for a in &s.ledger_accounts {
        unique(&a.id)?;
        text(&a.name, 800)?;
        privacy(&a.privacy)?;
        if !["ASSET", "LIABILITY", "INCOME", "EXPENSE", "EQUITY"].contains(&a.kind.as_str()) {
            return Err("账户类型无效".into());
        }
        if let Some(asset) = &a.asset {
            precision(asset)?;
        }
        reference(s, a.entity_ref.as_ref(), None)?;
        let mut seen = HashSet::from([&a.id]);
        let mut parent = a.parent_id.as_ref();
        while let Some(p) = parent {
            if !seen.insert(p) {
                return Err("账户不能循环引用".into());
            }
            parent = accounts.get(p).ok_or("上级账户不存在")?.parent_id.as_ref();
        }
    }
    let txs: HashMap<_, _> = s.transactions.iter().map(|t| (&t.id, t)).collect();
    let mut keys = HashSet::new();
    let mut reversed = HashSet::new();
    for t in &s.transactions {
        unique(&t.id)?;
        text(&t.idempotency_key, 200)?;
        if !keys.insert(&t.idempotency_key) {
            return Err("重复幂等键".into());
        }
        day(&t.occurred_at)?;
        domain::date(&t.created_at)?;
        privacy(&t.privacy)?;
        if !["SPEND", "INCOME", "TRANSFER", "TRADE", "ADJUST", "OPENING"].contains(&t.kind.as_str())
            || t.legs.len() < 2
            || t.legs.len() > 30
            || t.precision
                .as_ref()
                .is_some_and(|p| p != "day" && p != "month")
        {
            return Err("流水类型或分录无效".into());
        }
        for value in [&t.note, &t.payee, &t.source.import].into_iter().flatten() {
            if value.len() > 20000 {
                return Err("流水备注过长".into());
            }
            domain::reject_credential(value)?;
        }
        if let Some(r) = &t.refs {
            reference(s, r.order_id.as_ref(), Some("Order"))?;
            reference(s, r.subscription_id.as_ref(), None)?;
        }
        let mut totals: HashMap<&str, i128> = HashMap::new();
        let mut nonzero = false;
        for l in &t.legs {
            let a = accounts.get(&l.account_id).ok_or("流水账户不存在")?;
            if a.asset
                .as_ref()
                .is_some_and(|asset| asset != &l.money.asset)
            {
                return Err("账户币种不匹配".into());
            }
            reference(s, l.project_id.as_ref(), Some("Project"))?;
            reference(s, l.resource_id.as_ref(), None)?;
            let n = units(&l.money)?;
            nonzero |= n != 0;
            let sum = totals.entry(&l.money.asset).or_default();
            *sum = sum.checked_add(n).ok_or("金额超限")?;
        }
        if !nonzero || totals.values().any(|n| *n != 0) {
            return Err("每种资产的分录必须分别平衡".into());
        }
        if t.reversal_of.is_none() {
            validate_entry_accounts(t, &accounts)?;
        }
        if let Some(old_id) = &t.reversal_of {
            let old = txs.get(old_id).ok_or("冲正对象不存在")?;
            if old.reversal_of.is_some()
                || !reversed.insert(old_id)
                || t.occurred_at < old.occurred_at
                || old.legs.len() != t.legs.len()
                || old.kind != t.kind
                || old.refs != t.refs
            {
                return Err("重复或无效冲正".into());
            }
            for (a, b) in t.legs.iter().zip(&old.legs) {
                if a.account_id != b.account_id
                    || a.project_id != b.project_id
                    || a.resource_id != b.resource_id
                    || a.money.asset != b.money.asset
                    || units(&a.money)? != -units(&b.money)?
                {
                    return Err("冲正必须完整抵消原流水".into());
                }
            }
        }
    }
    for a in &s.allocation_rules {
        unique(&a.id)?;
        reference(s, Some(&a.resource_id), None)?;
        day(&a.effective_from)?;
        if let Some(to) = &a.effective_to {
            day(to)?;
            if to <= &a.effective_from {
                return Err("分摊日期无效".into());
            }
        }
        let mut projects = HashSet::new();
        let mut sum = 0;
        for share in &a.shares {
            reference(s, Some(&share.project_id), Some("Project"))?;
            if !projects.insert(&share.project_id) {
                return Err("重复分摊项目".into());
            }
            sum += weight(share.weight)?;
        }
        if sum > 1000000 {
            return Err("分摊总和超过 100%".into());
        }
        if s.allocation_rules.iter().any(|b| {
            b.id != a.id
                && b.resource_id == a.resource_id
                && b.effective_from.as_str() < a.effective_to.as_deref().unwrap_or("9999")
                && a.effective_from.as_str() < b.effective_to.as_deref().unwrap_or("9999")
        }) {
            return Err("分摊生效期重叠".into());
        }
    }
    let mut preferences = 0;
    for r in &s.finance_records {
        let id = r["id"].as_str().ok_or("财务记录缺少 ID")?;
        unique(id)?;
        let kind = r["type"].as_str().ok_or("财务记录缺少类型")?;
        let allowed: &[&str] = match kind {
            "price" | "rate" => &["id", "type", "asset", "value", "date"],
            "budget" => &["id", "type", "month", "value", "projectId"],
            "reconciliation" => &["id", "type", "accountId", "date", "balance", "createdAt"],
            "plan" => &[
                "id",
                "type",
                "asset",
                "quantity",
                "entry",
                "target",
                "stop",
                "status",
                "cooldownDays",
                "cooldownUntil",
                "reviewDue",
                "review",
                "date",
            ],
            "preferences" => &[
                "id",
                "type",
                "lotMethod",
                "showEntries",
                "taxRate",
                "reserveAccountId",
            ],
            _ => return Err("未知财务记录类型".into()),
        };
        if r.as_object()
            .ok_or("财务记录无效")?
            .keys()
            .any(|k| !allowed.contains(&k.as_str()))
        {
            return Err("财务记录含未知字段".into());
        }
        let get = |key: &str| -> Result<&str> {
            r[key].as_str().ok_or_else(|| format!("财务记录缺少 {key}"))
        };
        let amount = |key: &str| -> Result<Money> {
            let m: Money = serde_json::from_value(r[key].clone()).map_err(|_| "金额结构无效")?;
            units(&m)?;
            Ok(m)
        };
        match kind {
            "price" | "rate" => {
                let m = amount("value")?;
                precision(get("asset")?)?;
                day(get("date")?)?;
                if units(&m)? <= 0 || get("asset")? == m.asset {
                    return Err("价格或汇率无效".into());
                }
            }
            "budget" => {
                let month = get("month")?;
                if month.len() != 7 {
                    return Err("预算月份无效".into());
                }
                day(&format!("{month}-01"))?;
                if units(&amount("value")?)? < 0 {
                    return Err("预算不能为负".into());
                }
                reference(
                    s,
                    r["projectId"].as_str().map(str::to_string).as_ref(),
                    Some("Project"),
                )?;
            }
            "reconciliation" => {
                let a = accounts
                    .get(&get("accountId")?.to_string())
                    .ok_or("对账账户不存在")?;
                let m = amount("balance")?;
                if a.asset.as_deref() != Some(&m.asset) {
                    return Err("对账币种不匹配".into());
                }
                day(get("date")?)?;
                domain::date(get("createdAt")?)?;
            }
            "preferences" => {
                preferences += 1;
                if !["FIFO", "LIFO"].contains(&get("lotMethod")?) || !r["showEntries"].is_boolean()
                {
                    return Err("账本设置无效".into());
                }
                weight(r["taxRate"].as_f64().ok_or("预留比例无效")?)?;
                if let Some(id) = r["reserveAccountId"].as_str() {
                    if !accounts.contains_key(&id.to_string()) {
                        return Err("预留账户不存在".into());
                    }
                }
            }
            "plan" => {
                let q = amount("quantity")?;
                let e = amount("entry")?;
                let target = amount("target")?;
                let stop = amount("stop")?;
                if q.asset != get("asset")?
                    || units(&q)? <= 0
                    || e.asset != target.asset
                    || e.asset != stop.asset
                    || units(&stop)? <= 0
                    || units(&stop)? >= units(&e)?
                    || units(&target)? <= units(&e)?
                    || !r["cooldownDays"].as_u64().is_some_and(|n| n <= 365)
                    || !["PLANNED", "OPEN", "CLOSED", "STOPPED"].contains(&get("status")?)
                {
                    return Err("交易计划价格、数量或状态无效".into());
                }
                day(get("date")?)?;
                for key in ["cooldownUntil", "reviewDue"] {
                    if let Some(v) = r[key].as_str() {
                        day(v)?;
                    }
                }
                if get("review")?.len() > 20000 {
                    return Err("复盘过长".into());
                }
                domain::reject_credential(get("review")?)?;
            }
            _ => unreachable!(),
        }
    }
    if preferences > 1 {
        return Err("重复账本设置".into());
    }
    for r in &s.finance_records {
        if r["type"] == "preferences" {
            if let Some(id) = r["reserveAccountId"].as_str() {
                if accounts
                    .get(&id.to_string())
                    .is_none_or(|a| a.kind != "ASSET")
                {
                    return Err("预留账户必须是资产账户".into());
                }
            }
        }
    }
    validate_trades(s)?;
    let mut opaque_ids = HashSet::new();
    for record in &s.opaque_records {
        let kind = record["kind"].as_str().ok_or("未知记录缺少类型")?;
        let id = record["data"]["id"].as_str().ok_or("未知记录缺少 ID")?;
        text(id, 200)?;
        if known_record(kind)
            || !opaque_ids.insert((kind, id))
            || serde_json::to_vec(record)
                .map_err(|_| "未知记录编码失败")?
                .len()
                > 1024 * 1024
        {
            return Err("未知记录无效或重复".into());
        }
    }
    Ok(())
}
pub fn known_record(kind: &str) -> bool {
    [
        "Entity",
        "Relation",
        "Event",
        "Capture",
        "Proposal",
        "AiConfig",
        "CloudSession",
        "LedgerAccount",
        "Transaction",
        "AllocationRule",
        "FinanceRecord",
    ]
    .contains(&kind)
}
pub fn deduplicate(transactions: &mut Vec<Transaction>) -> Result<()> {
    transactions.sort_by(|a, b| a.id.cmp(&b.id));
    let mut seen: HashMap<String, Transaction> = HashMap::new();
    let mut remap = HashMap::new();
    for t in transactions.iter() {
        if let Some(old) = seen.get(&t.idempotency_key) {
            let mut compare = t.clone();
            compare.id = old.id.clone();
            compare.created_at = old.created_at.clone();
            if compare != *old {
                return Err("同一幂等键包含不同流水，不能自动合并".into());
            }
            remap.insert(t.id.clone(), old.id.clone());
        } else {
            seen.insert(t.idempotency_key.clone(), t.clone());
        }
    }
    transactions.retain(|t| !remap.contains_key(&t.id));
    for t in transactions {
        if let Some(old) = &t.reversal_of {
            if let Some(id) = remap.get(old) {
                t.reversal_of = Some(id.clone());
            }
        }
    }
    Ok(())
}
pub fn merge_finance(current: &Snapshot, imported: &Snapshot) -> Result<Snapshot> {
    let mut out = serde_json::to_value(current).map_err(|_| "导入编码失败")?;
    let input = serde_json::to_value(imported).map_err(|_| "导入编码失败")?;
    for key in [
        "ledgerAccounts",
        "transactions",
        "allocationRules",
        "financeRecords",
        "opaqueRecords",
    ] {
        let mut items = out[key].as_array().cloned().unwrap_or_default();
        for item in input[key].as_array().into_iter().flatten() {
            let found = items.iter().find(|v| {
                if key == "opaqueRecords" {
                    v["kind"] == item["kind"] && v["data"]["id"] == item["data"]["id"]
                } else {
                    v["id"] == item["id"]
                }
            });
            if let Some(found) = found {
                if found != item {
                    return Err("导入财务 ID 冲突".into());
                }
            } else {
                items.push(item.clone());
            }
        }
        out[key] = Value::Array(items);
    }
    let mut merged: Snapshot = serde_json::from_value(out).map_err(|_| "导入财务结构无效")?;
    deduplicate(&mut merged.transactions)?;
    merged.cloud_session = current.cloud_session.clone();
    Ok(merged)
}
pub fn immutable(previous: &Snapshot, next: &Snapshot) -> Result<()> {
    let txs: HashMap<_, _> = next.transactions.iter().map(|t| (&t.id, t)).collect();
    for t in &previous.transactions {
        if txs.get(&t.id).copied() != Some(t) {
            return Err("流水不可修改或删除，请冲正".into());
        }
    }
    let used: HashSet<_> = previous
        .transactions
        .iter()
        .flat_map(|t| t.legs.iter().map(|l| &l.account_id))
        .collect();
    for a in &previous.ledger_accounts {
        if used.contains(&a.id)
            && next
                .ledger_accounts
                .iter()
                .find(|b| b.id == a.id)
                .is_none_or(|b| b.kind != a.kind || b.asset != a.asset)
        {
            return Err("已有流水的账户不能改变类型或币种".into());
        }
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    for a in &previous.allocation_rules {
        let b = next
            .allocation_rules
            .iter()
            .find(|b| b.id == a.id)
            .ok_or("历史分摊不能删除")?;
        let mut same = b.clone();
        same.effective_to = a.effective_to.clone();
        if &same != a
            || b.effective_to != a.effective_to
                && b.effective_to.as_ref().is_none_or(|to| to < &today)
        {
            return Err("历史分摊不能改写，请创建新生效版本".into());
        }
    }
    Ok(())
}
pub fn reverse(t: &Transaction, id: String, key: String, date: String) -> Result<Transaction> {
    if t.reversal_of.is_some() {
        return Err("不能冲正冲正记录".into());
    }
    let mut out = t.clone();
    out.id = id;
    out.idempotency_key = key;
    out.occurred_at = date;
    out.reversal_of = Some(t.id.clone());
    out.created_at = domain::now();
    out.source = Source::default();
    out.note = Some(format!("冲正：{}", t.note.as_deref().unwrap_or("")));
    for l in &mut out.legs {
        l.money = from_units(-units(&l.money)?, &l.money.asset)?;
    }
    Ok(out)
}
pub fn apply(
    s: &mut Snapshot,
    actions: &[Action],
    capture: &crate::capture::Capture,
) -> Result<()> {
    if actions.len() > 30 {
        return Err("一次最多 30 个账本动作".into());
    }
    for a in actions {
        match a {
            Action::AccountAdd { account } => s.ledger_accounts.push(account.clone()),
            Action::LedgerAdd {
                transaction,
                evidence,
            } => {
                if !capture.raw_text.contains(evidence) || evidence.trim().is_empty() {
                    return Err("流水缺少原文依据".into());
                }
                let mut t = transaction.clone();
                t.source.capture_id = Some(capture.id.clone());
                s.transactions.push(t);
            }
            Action::LedgerReverse {
                transaction_id,
                id,
                idempotency_key,
                occurred_at,
            } => {
                let t = s
                    .transactions
                    .iter()
                    .find(|t| &t.id == transaction_id)
                    .ok_or("原流水不存在")?;
                s.transactions.push(reverse(
                    t,
                    id.clone(),
                    idempotency_key.clone(),
                    occurred_at.clone(),
                )?);
            }
        }
    }
    validate(s)
}
pub fn confirm_numbers(
    current: &Snapshot,
    capture: &crate::capture::Capture,
    proposal: &crate::capture::Proposal,
) -> Result<()> {
    if proposal.finance_actions.is_empty() {
        return Ok(());
    }
    if !proposal.uncertainty.is_empty() {
        return Err("请先处理金额或账户待确认项".into());
    }
    let reviewed = proposal.numbers_reviewed;
    if capture.input_type != "text" && !reviewed {
        return Err("请核对语音或剪贴板中的金额".into());
    }
    for a in &proposal.finance_actions {
        match a {
            Action::LedgerAdd { transaction, .. } => {
                if !reviewed {
                    for l in &transaction.legs {
                        if units(&l.money)? != 0
                            && !number_supported(&l.money.amount, &capture.raw_text)
                        {
                            return Err("金额不在原文中，请手动核对".into());
                        }
                    }
                    if [
                        "左右",
                        "大概",
                        "约",
                        "差不多",
                        "多元",
                        "多块",
                        "几百",
                        "几十",
                        "不到",
                        "超过",
                    ]
                    .iter()
                    .any(|v| capture.raw_text.contains(v))
                    {
                        return Err("原文金额不精确，请手动核对".into());
                    }
                }
                for l in &transaction.legs {
                    if current
                        .ledger_accounts
                        .iter()
                        .any(|a| a.id == l.account_id && a.privacy == "SECRET")
                    {
                        return Err("提案不可使用秘密账户".into());
                    }
                }
            }
            Action::LedgerReverse { transaction_id, .. } => {
                if current
                    .transactions
                    .iter()
                    .any(|t| t.id == *transaction_id && t.privacy == "SECRET")
                {
                    return Err("提案不可访问秘密流水".into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn canonical(s: &str) -> Option<String> {
    let mut text = s.to_lowercase().replace(',', "");
    let mut multiplier = 1i128;
    if text.chars().any(|c| c.is_ascii_digit()) {
        if let Some(last) = text.chars().last() {
            multiplier = match last {
                'k' | '千' => 1000,
                'm' => 1000000,
                'w' | '万' => 10000,
                _ => 1,
            };
            if multiplier != 1 {
                text.pop();
            }
        }
    } else {
        let digits = |c| match c {
            '零' | '〇' => Some(0),
            '一' => Some(1),
            '二' | '两' => Some(2),
            '三' => Some(3),
            '四' => Some(4),
            '五' => Some(5),
            '六' => Some(6),
            '七' => Some(7),
            '八' => Some(8),
            '九' => Some(9),
            _ => None,
        };
        let chinese = text.clone();
        let parts: Vec<_> = chinese.split('点').collect();
        if parts.len() > 2 {
            return None;
        }
        let integer = parts[0];
        let value = if integer.chars().any(|c| "十百千万亿".contains(c)) {
            let (mut sum, mut section, mut cur) = (0i128, 0i128, 0i128);
            for c in integer.chars() {
                if let Some(d) = digits(c) {
                    cur = d;
                } else {
                    let unit = match c {
                        '十' => 10,
                        '百' => 100,
                        '千' => 1000,
                        '万' => 10000,
                        '亿' => 100000000,
                        _ => return None,
                    };
                    if unit < 10000 {
                        section += if cur == 0 { unit } else { cur * unit };
                        cur = 0;
                    } else {
                        sum += (section + cur).max(1) * unit;
                        section = 0;
                        cur = 0;
                    }
                }
            }
            (sum + section + cur).to_string()
        } else {
            integer
                .chars()
                .map(|c| digits(c).map(|d| d.to_string()))
                .collect::<Option<Vec<_>>>()?
                .join("")
        };
        text = value;
        if parts.len() == 2 {
            text.push('.');
            text.push_str(
                &parts[1]
                    .chars()
                    .map(|c| digits(c).map(|d| d.to_string()))
                    .collect::<Option<Vec<_>>>()?
                    .join(""),
            );
        }
    }
    let parts: Vec<_> = text.split('.').collect();
    if parts.len() > 2
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let decimals = parts.get(1).map_or(0, |p| p.len());
    let n = parts
        .join("")
        .parse::<i128>()
        .ok()?
        .checked_mul(multiplier)?;
    let mut value = format!("{:0width$}", n, width = decimals + 1);
    if decimals > 0 {
        value.insert(value.len() - decimals, '.');
        while value.ends_with('0') {
            value.pop();
        }
        if value.ends_with('.') {
            value.pop();
        }
    }
    Some(value)
}
pub fn number_supported(amount: &str, raw: &str) -> bool {
    let expected = canonical(amount.trim_start_matches('-'));
    let mut token = String::new();
    for c in raw.chars().chain(std::iter::once(' ')) {
        let c = if ('０'..='９').contains(&c) {
            char::from_u32(c as u32 - '０' as u32 + '0' as u32).unwrap()
        } else {
            c
        };
        if c.is_ascii_digit() || ".,kKmMwW零〇一二两三四五六七八九十百千万亿点".contains(c)
        {
            token.push(c);
        } else {
            if !token.is_empty() && canonical(&token) == expected {
                return true;
            }
            token.clear();
        }
    }
    false
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn fixture() -> Snapshot {
        serde_json::from_value(serde_json::json!({"entities":[],"relations":[],"events":[],"ledgerAccounts":[{"id":"cash","name":"synthetic cash","kind":"ASSET","asset":"CNY","privacy":"PRIVATE"},{"id":"expense","name":"synthetic expense","kind":"EXPENSE","privacy":"PRIVATE"}],"transactions":[{"id":"tx-a","occurredAt":"2026-10-15","kind":"SPEND","legs":[{"accountId":"cash","money":{"amount":"-8.00","asset":"CNY"}},{"accountId":"expense","money":{"amount":"8.00","asset":"CNY"}}],"source":{},"idempotencyKey":"key-a","createdAt":"2026-10-15T00:00:00Z","privacy":"PRIVATE"}]})).unwrap()
    }
    #[test]
    fn exact_amounts_and_guard() {
        assert_eq!(
            units(&Money {
                amount: "0.00061700".into(),
                asset: "BTC".into()
            })
            .unwrap(),
            61700
        );
        assert!(units(&Money {
            amount: "1.1".into(),
            asset: "JPY".into()
        })
        .is_err());
        assert_eq!(from_units(30, "USD").unwrap().amount, "0.30");
        for (a, s) in [
            ("8.00", "八块"),
            ("1200.00", "1.2k 美元"),
            ("13.50", "十三点五元"),
            ("0.01", "零点零一元"),
        ] {
            assert!(number_supported(a, s), "{a}: {s}");
        }
        assert!(!number_supported("100", "10 元"));
    }
    #[test]
    fn ledger_append_only_balanced_and_reversal() {
        let original = fixture();
        validate(&original).unwrap();
        let mut next = original.clone();
        next.transactions.push(
            reverse(
                &original.transactions[0],
                "reverse".into(),
                "reverse-key".into(),
                "2026-10-15".into(),
            )
            .unwrap(),
        );
        validate(&next).unwrap();
        immutable(&original, &next).unwrap();
        assert_eq!(
            next.transactions
                .iter()
                .map(|t| units(&t.legs[0].money).unwrap())
                .sum::<i128>(),
            0
        );
        next.ledger_accounts[0].kind = "LIABILITY".into();
        assert!(immutable(&original, &next).is_err());
        next = original.clone();
        next.transactions.clear();
        assert!(immutable(&original, &next).is_err());
        next = original.clone();
        next.transactions[0].legs[0].money.amount = "-9.00".into();
        assert!(validate(&next).is_err());
    }
    #[test]
    fn ledger_dedup_rejects_different_payloads() {
        let mut s = fixture();
        let mut copy = s.transactions[0].clone();
        copy.id = "tx-b".into();
        s.transactions.push(copy);
        deduplicate(&mut s.transactions).unwrap();
        assert_eq!(s.transactions.len(), 1);
        let mut bad = s.transactions[0].clone();
        bad.id = "tx-c".into();
        bad.note = Some("different".into());
        s.transactions.push(bad);
        assert!(deduplicate(&mut s.transactions).is_err());
    }
}
