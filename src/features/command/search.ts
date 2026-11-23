import { categoryLabel } from "../../lib/record-labels";
import { localLedgerProposal } from "../../domain/finance-capture";
import { formatMoney } from "../../domain/money";
import type { VaultSnapshot } from "../../lib/types";

export interface Command {
  label: string;
  group: string;
  keywords?: string;
  detail?: string;
  run: () => void | Promise<void>;
  graph?: () => void;
  disabled?: boolean;
}

export function vaultCommands(
  snapshot: VaultSnapshot,
  open: (id: string) => void,
  explore: (id: string) => void,
  account: (id: string) => void,
): Command[] {
  return [
    ...snapshot.entities
      .filter((e) => e.privacy !== "SECRET")
      .map((e) => ({
        label: e.name,
        group: "记忆",
        detail: categoryLabel(e.category),
        keywords: [
          categoryLabel(e.category),
          ...e.tags,
          ...e.fields
            .filter(
              (f) =>
                f.privacy !== "SECRET" &&
                f.searchable &&
                typeof f.value === "string",
            )
            .map((f) => f.value),
        ].join(" "),
        run: () => open(e.id),
        graph: () => explore(e.id),
      })),
    ...(snapshot.ledgerAccounts ?? [])
      .filter((a) => a.privacy !== "SECRET")
      .map((a) => ({
        label: a.name,
        group: "账户",
        detail: a.asset ?? "账本账户",
        keywords: "账户 账本 " + (a.asset ?? ""),
        run: () => account(a.id),
      })),
  ];
}

function score(value: string, query: string) {
  const text = value.normalize("NFKC").toLowerCase();
  const at = text.indexOf(query);
  if (at >= 0) return (at === 0 ? 4 : 3) + 1 / (1 + at + text.length / 100);
  let start = -1,
    end = -1;
  for (const char of query) {
    end = text.indexOf(char, end + 1);
    if (end < 0) return 0;
    if (start < 0) start = end;
  }
  return 1 + 1 / (1 + end - start);
}
export function findCommands(commands: Command[], raw: string) {
  const q = raw.trim().normalize("NFKC").toLowerCase();
  if (!q)
    return commands.filter((c) => c.group === "操作" || c.group === "页面");
  return commands
    .map((c) => ({
      c,
      rank: Math.max(score(c.label, q), score(c.keywords ?? "", q) * 0.7),
    }))
    .filter((r) => r.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map((r) => r.c);
}

export function quickPreview(query: string, snapshot: VaultSnapshot) {
  try {
    const proposal = localLedgerProposal(query, snapshot);
    const entries =
      proposal?.financeActions?.flatMap((a) =>
        a.type === "ledger.add" ? [a.transaction] : [],
      ) ?? [];
    if (!proposal || !entries.length) return {};
    const amount = entries[0].legs.find(
      (l) => !l.money.amount.startsWith("-"),
    )!.money;
    return {
      proposal,
      detail:
        entries.length > 1 ? entries.length + " 笔流水" : formatMoney(amount),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
