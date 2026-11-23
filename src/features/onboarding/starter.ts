import type { Entity, VaultSnapshot } from "../../lib/types";
import {
  privateEntity,
  isEmail,
  norm,
  phoneNumber,
} from "../../domain/importers/assets";
import { resolveLedgerAccount } from "../../domain/finance-capture";
import { validateLedger, type FinanceAction } from "../../domain/ledger";

export function createStarterHubs(
  snapshot: VaultSnapshot,
  mail: string,
  phone: string,
  wallet: string,
  linkAccount: boolean,
) {
  const email = norm(mail),
    tel = phoneNumber(phone.trim()),
    name = wallet.trim();
  if (mail.trim() && !isEmail(email)) throw new Error("请核对主力邮箱");
  if (phone.trim() && !tel) throw new Error("请核对主力手机号");
  const next = structuredClone(snapshot);
  const add = (
    category: string,
    value: string,
    aliases: string[],
    fieldKeys: string[],
  ) => {
    const key = category === "Phone / SIM" ? phoneNumber : norm;
    const match = (e: Entity) =>
      [
        e.name,
        ...e.fields
          .filter((f) => f.privacy !== "SECRET" && fieldKeys.includes(f.key))
          .map((f) => String(f.value)),
      ].some((v) => key(v) === key(value));
    const existing = next.entities.find(
      (e) =>
        e.privacy !== "SECRET" &&
        [category, ...aliases].includes(e.category) &&
        match(e),
    );
    if (existing) return existing;
    const entity = privateEntity(
      category,
      value,
      fieldKeys.length ? { [fieldKeys[0]]: value } : {},
    );
    next.entities.push(entity);
    return entity;
  };
  if (email) add("Email", email, [], ["address", "email"]);
  if (tel)
    add("Phone / SIM", tel, ["SIM"], ["number", "phone", "phone_number"]);
  if (name) {
    const entity = add(
      "Wallet",
      name,
      ["Account", "Website Account", "Bank Account", "Payment Card"],
      [],
    );
    if (linkAccount) {
      const actions: FinanceAction[] = [];
      const account = resolveLedgerAccount(
        next,
        actions,
        name,
        "ASSET",
        "CNY",
        name,
      );
      if (actions.length)
        (next.ledgerAccounts ??= []).push({ ...account, entityRef: entity.id });
      else {
        const stored = next.ledgerAccounts!.find((a) => a.id === account.id)!;
        stored.entityRef ??= entity.id;
      }
    }
  }
  validateLedger(next, snapshot);
  return next;
}
