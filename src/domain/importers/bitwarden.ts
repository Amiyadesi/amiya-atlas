import type { VaultSnapshot } from "../../lib/types";
import { assetPreview, type LoginItem } from "./assets";
import { parseCsv } from "./csv";
import { passwordRows } from "./passwords";

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const count = (o: Record<string, unknown>, keys: string[]) =>
  keys.filter((k) => o[k] != null && o[k] !== "").length;
export function parseBitwarden(text: string, snapshot: VaultSnapshot) {
  if (!text.trimStart().startsWith("{"))
    return passwordRows(parseCsv(text), snapshot, true);
  let raw: unknown;
  try {
    raw = JSON.parse(text.trimStart());
  } catch {
    throw new Error("Bitwarden JSON 格式无效");
  }
  const doc = object(raw);
  if (doc.encrypted || !Array.isArray(doc.items))
    throw new Error("请选择未加密的 Bitwarden JSON 导出");
  const folders = new Map(
    (Array.isArray(doc.folders) ? doc.folders : []).map((f) => [
      str(object(f).id),
      str(object(f).name),
    ]),
  );
  const items: LoginItem[] = [],
    warnings: string[] = [];
  let stripped = 0,
    skipped = 0;
  for (const rawItem of doc.items) {
    const item = object(rawItem),
      login = object(item.login),
      card = object(item.card);
    stripped +=
      count(item, ["notes", "sshKey"]) +
      count(login, ["password", "totp"]) +
      count(card, ["number", "code"]) +
      (Array.isArray(item.fields)
        ? item.fields.filter((f) => count(object(f), ["value"])).length
        : 0);
    const base = {
      name: str(item.name),
      folder: folders.get(str(item.folderId)),
      favorite: item.favorite === true,
    };
    if (item.type === 1)
      items.push({
        ...base,
        username: str(login.username),
        url: Array.isArray(login.uris)
          ? (login.uris
              .map((v) => str(object(v).uri))
              .find((v) => /^https?:\/\//i.test(v)) ??
            str(object(login.uris[0]).uri))
          : "",
      });
    else if (item.type === 3) {
      const last4 =
        str(card.number)
          .replace(/[\s-]/g, "")
          .match(/^\d*(\d{4})$/)?.[1] ?? "";
      const mask = (s: string) =>
        s.replace(
          /(?:\d[ -]?){12,18}\d/g,
          (digits) => "•••• " + digits.replace(/\D/g, "").slice(-4),
        );
      items.push({
        ...base,
        name: mask(base.name),
        card: { brand: mask(str(card.brand)), last4 },
      });
    } else skipped++;
  }
  if (skipped) warnings.push("已跳过 " + skipped + " 个非登录、非银行卡项目");
  return assetPreview(snapshot, items, "Bitwarden JSON", stripped, warnings);
}
