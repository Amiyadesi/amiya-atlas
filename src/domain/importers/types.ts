import type { Entity, Relation, VaultSnapshot } from "../../lib/types";
import type { Money } from "../money";
import type { Transaction, LedgerAccount } from "../ledger";
export type ImportTab = "assets" | "bills";
export interface AssetRow {
  id: string;
  entity: Entity;
  existing: boolean;
  duplicate: boolean;
  hub?: Entity;
  relation?: Relation;
  folder: string;
  favorite: boolean;
  login: string;
  enrichment?: { fields: Entity["fields"]; updatedAt: string };
}
export interface AssetPreview {
  kind: "assets";
  format: string;
  rows: AssetRow[];
  stripped: number;
  warnings: string[];
  revision: number;
}
export type BillColumn =
  | "date"
  | "amount"
  | "direction"
  | "payee"
  | "note"
  | "category"
  | "account"
  | "asset";
export type ColumnMapping = Partial<Record<BillColumn, string>>;
export interface BillRow {
  id: string;
  transaction: Transaction;
  value: Money;
  account: string;
  category: string;
  duplicate: boolean;
  excluded: string;
  status: string;
  needsDestination: boolean;
}
export interface SubscriptionCandidate {
  entity: Entity;
  rowIds: string[];
  fee: Money;
}
export interface BillPreview {
  kind: "bills";
  format: "wechat" | "alipay" | "generic";
  headers: string[];
  mapping: ColumnMapping;
  rows: BillRow[];
  accounts: LedgerAccount[];
  duplicateCount: number;
  subscriptions: SubscriptionCandidate[];
  warnings: string[];
  revision: number;
}
export interface ImportSelection {
  rows: ReadonlySet<string>;
  subscriptions?: ReadonlySet<string>;
}
export type ImportResult = VaultSnapshot;
