import type { VaultSnapshot } from "../../lib/types";
import { assetPreview, type LoginItem } from "./assets";
import { parseCsv } from "./csv";
export function passwordRows(
  table: string[][],
  snapshot: VaultSnapshot,
  bitwarden = false,
) {
  const [head = [], ...data] = table,
    h = head.map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, ""),
    );
  const index = (...keys: string[]) => h.findIndex((v) => keys.includes(v));
  const n = index("name", "title", "account", "accountname", "名称", "标题"),
    u = index(
      "username",
      "loginusername",
      "loginname",
      "login",
      "user",
      "用户名",
    ),
    site = index(
      "url",
      "website",
      "loginuri",
      "loginurl",
      "loginurls",
      "websites",
      "网址",
    ),
    folder = index(
      "folder",
      "group",
      "groupname",
      "group/tree",
      "vault",
      "tags",
    ),
    fav = index("favorite", "favourite"),
    type = index("type");
  if (u < 0 || (n < 0 && site < 0))
    throw new Error(
      "未识别密码管理器列头；请选择包含名称或网址、用户名的 CSV 导出",
    );
  const format = bitwarden
    ? "Bitwarden CSV"
    : h.includes("otpauth")
      ? "Apple / 1Password CSV"
      : h.includes("httprealm")
        ? "Firefox CSV"
        : h.includes("loginname") || h.includes("group")
          ? "KeePass CSV"
          : h.includes("title")
            ? "1Password / KeePass CSV"
            : "浏览器 CSV";
  const items: LoginItem[] = [],
    warnings: string[] = [];
  let stripped = 0;
  for (const [i, row] of data.entries()) {
    if (row.every((v) => !v)) continue;
    if (row.length !== head.length) {
      warnings.push("第 " + (i + 2) + " 行列数不匹配，已跳过");
      continue;
    }
    // Only allowlisted metadata can leave this loop. Unknown/custom columns may contain secrets.
    for (const [j, key] of h.entries())
      if (
        row[j] &&
        /password|passphrase|totp|otp|notes?|comments?|extra|custom|fields|privatekey|recovery|cardcode|cardnumber|密码|备注/.test(
          key,
        ) &&
        !/passwordfield|timepasswordchanged/.test(key)
      )
        stripped++;
    if (bitwarden && row[type] && row[type].trim().toLowerCase() !== "login") {
      warnings.push("第 " + (i + 2) + " 行不是登录项目，已跳过");
      continue;
    }
    items.push({
      name: row[n] ?? "",
      url: (row[site] ?? "").split(/[\r\n,]/)[0],
      username: row[u],
      folder: row[folder],
      favorite: /^(1|true|yes)$/i.test(row[fav] ?? ""),
    });
  }
  return assetPreview(snapshot, items, format, stripped, warnings);
}
export function parsePasswords(text: string, snapshot: VaultSnapshot) {
  const table = parseCsv(text);
  return passwordRows(
    table,
    snapshot,
    table[0]?.some((s) => s.trim().toLowerCase() === "login_username"),
  );
}
