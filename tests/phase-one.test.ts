import { afterEach, expect, test, vi } from "vitest";
import { get } from "svelte/store";
import {
  initTheme,
  resolvedTheme,
  setTheme,
  themePreference,
} from "../src/lib/theme";
import {
  activeDialog,
  cancelDialogs,
  confirmDialog,
  finishDialog,
  promptDialog,
} from "../src/lib/dialog";
import { demoSnapshot } from "../src/lib/demo";
import { memoryIndex, sortMemory } from "../src/lib/memory";
import {
  findCommands,
  quickPreview,
  vaultCommands,
} from "../src/features/command/search";
import { graphData } from "../src/features/graph/layout";

afterEach(() => {
  vi.unstubAllGlobals();
  cancelDialogs();
});

test("system follows the OS; a saved override survives OS changes and reload", () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  const values = new Map([["relakeep:theme", "invalid"]]);
  const root = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
  };
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { matchMedia: () => media }),
  );
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k),
    setItem: (k: string, v: string) => values.set(k, v),
  });
  const stop = initTheme();
  expect([
    get(themePreference),
    root.dataset.theme,
    root.style.colorScheme,
  ]).toEqual(["system", "dark", "dark"]);
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(get(resolvedTheme)).toBe("light");
  setTheme("dark");
  media.dispatchEvent(new Event("change"));
  stop();
  const stopAgain = initTheme();
  expect([get(themePreference), get(resolvedTheme)]).toEqual(["dark", "dark"]);
  setTheme("system");
  stopAgain();
});

test("dialogs resolve in order; locking cancels even queued sensitive prompts", async () => {
  const first = confirmDialog({ title: "Replace?" });
  const second = promptDialog({
    title: "Password",
    input: { type: "password", label: "Password" },
  });
  expect(get(activeDialog)?.title).toBe("Replace?");
  finishDialog("");
  expect(await first).toBe(true);
  expect(get(activeDialog)?.input?.type).toBe("password");
  const third = confirmDialog({ title: "Delete?" });
  cancelDialogs();
  expect(await second).toBe(null);
  expect(await third).toBe(false);
  expect(get(activeDialog)).toBe(null);
});

test("opt-in graph filter and memory counts ignore secret links, endpoints and fields", () => {
  const s = demoSnapshot();
  const [a, b, c] = s.entities;
  s.entities = [a, b, { ...c, privacy: "SECRET" }];
  s.relations = [
    { ...s.relations[0], sourceId: a.id, targetId: b.id, type: "USES" },
    { ...s.relations[1], sourceId: a.id, targetId: c.id },
    { ...s.relations[2], sourceId: a.id, targetId: b.id, privacy: "SECRET" },
  ];
  a.fields.forEach((f) => (f.privacy = "SECRET"));
  b.tags = ["⭐ 收藏"];
  b.fields.push(
    {
      ...b.fields[0],
      key: "fee",
      valueType: "money",
      value: { amount: "120", asset: "CNY" },
    },
    { ...b.fields[0], key: "billing_period", value: "yearly" },
  );
  const index = memoryIndex(s);
  expect(index.has(c.id)).toBe(false);
  expect(index.get(a.id)).toMatchObject({ count: 1, summary: "" });
  expect(index.get(b.id)?.cost).toEqual({ amount: "10.00", asset: "CNY" });
  for (const order of ["favorite", "cost"] as const)
    expect(sortMemory([a, b], order, index)[0]).toBe(b);
  expect(graphData(s, ["PAID_BY"]).nodes).toHaveLength(2);
  expect(graphData(s, ["PAID_BY"], true).nodes).toHaveLength(0);
  expect(graphData(s, ["USES"], true).nodes).toHaveLength(2);
});

test("command matching ranks exact names before fuzzy hits; quick capture only previews", () => {
  const cmds = ["Google Main", "Gmail", "gm"].map((label) => ({
    label,
    group: "记忆",
    run: () => {},
  }));
  expect(findCommands(cmds, "GM").map((c) => c.label)).toEqual([
    "gm",
    "Gmail",
    "Google Main",
  ]);
  const s = demoSnapshot(),
    before = structuredClone(s);
  expect(quickPreview("午饭 25", s)).toMatchObject({
    detail: "CNY 25.00",
    proposal: { financeActions: expect.any(Array) },
  });
  expect(quickPreview("午饭 1.234", s).error).toBeTruthy();
  expect(quickPreview("别记午饭 25", s).proposal).toBeUndefined();
  expect(s).toEqual(before);
});

test("palette indexes neither SECRET fields nor SECRET objects, and keeps account destinations distinct", () => {
  const snapshot = demoSnapshot();
  const e = snapshot.entities[0];
  e.fields.push({
    ...e.fields[0],
    key: "private-id",
    value: "hidden-needle",
    privacy: "SECRET",
  });
  snapshot.entities.push({
    ...e,
    id: "secret",
    name: "hidden-needle",
    privacy: "SECRET",
  });
  snapshot.ledgerAccounts = [
    {
      id: "wallet",
      name: "Visible wallet",
      asset: "CNY",
      kind: "ASSET",
      privacy: "PRIVATE",
    },
    {
      id: "vault",
      name: "hidden-needle",
      asset: "USD",
      kind: "ASSET",
      privacy: "SECRET",
    },
  ];
  const open = vi.fn(),
    graph = vi.fn(),
    account = vi.fn();
  const commands = vaultCommands(snapshot, open, graph, account);
  expect(findCommands(commands, "hidden-needle")).toEqual([]);
  findCommands(commands, "visible wallet")[0].run();
  findCommands(commands, e.name)[0].graph?.();
  expect(account).toHaveBeenCalledWith("wallet");
  expect(graph).toHaveBeenCalledWith(e.id);
  expect(open).not.toHaveBeenCalled();
});
