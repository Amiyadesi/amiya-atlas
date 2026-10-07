import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../src/lib/demo";
import {
  applyBrowserProposal,
  matchEntities,
  proposalSchema,
  validateProposal,
} from "../src/domain/proposal";
import type { Proposal } from "../src/domain/proposal";
import {
  deletionTargets,
  proposalDiff,
  undoBrowserProposal,
} from "../src/domain/changes";
import { createProvider, DEFAULT_PROVIDER } from "../src/ai/provider";
import type { VaultSnapshot } from "../src/lib/types";

const empty = (): Proposal => ({
  entitiesToCreate: [],
  entitiesToUpdate: [],
  relationsToCreate: [],
  eventsToCreate: [],
  uncertainty: [],
});
function fixture() {
  const snapshot = demoSnapshot();
  const sim = snapshot.entities.find((e) => e.id === "sim-saily")!;
  sim.fields.push({
    id: "monthly",
    entityId: sim.id,
    key: "monthly_cost",
    value: 6,
    valueType: "number",
    privacy: "PRIVATE",
    searchable: true,
  });
  snapshot.relations.push({
    id: "recover",
    sourceId: "service-reddit",
    targetId: sim.id,
    type: "RECOVERS_WITH",
    privacy: "PRIVATE",
    createdAt: sim.createdAt,
  });
  return { snapshot, sim };
}
function staged(snapshot: VaultSnapshot, input: string, proposal: Proposal) {
  snapshot.captures = [
    {
      id: "capture",
      inputType: "voice",
      rawText: input,
      timestamp: new Date().toISOString(),
      status: "PENDING",
    },
  ];
  snapshot.proposals = [
    {
      id: "proposal",
      captureId: "capture",
      content: structuredClone(proposal),
      status: "PENDING",
      provider: "test",
      createdAt: new Date().toISOString(),
      entityIds: [],
      baseRevision: snapshot.revision,
    },
  ];
  return snapshot;
}

describe("reviewable additions, removals and undo", () => {
  it("shows exact database values and preserves unmentioned attributes when retiring an existing number", () => {
    const { snapshot, sim } = fixture();
    const text = "Saily 不用了，改用 3HK 备用号码。";
    const proposal = empty();
    proposal.entitiesToUpdate.push({
      id: sim.id,
      name: sim.name,
      type: "Phone / SIM",
      status: "INACTIVE",
      attributes: {},
      notes: "",
      evidence: text,
    });
    proposal.entitiesToCreate.push({
      ref: "new",
      name: "3HK",
      type: "Phone / SIM",
      status: "ACTIVE",
      attributes: { roles: ["备用"] },
      notes: "",
      evidence: text,
    });
    const matched = matchEntities(proposal, snapshot, text);
    const diff = proposalDiff(matched, snapshot);
    expect(diff.find((c) => c.id === sim.id)?.rows).toEqual([
      { key: "status", before: "使用中", after: "已停用" },
    ]);
    const next = applyBrowserProposal(
      staged(snapshot, text, matched),
      "proposal",
      matched,
    );
    expect(next.entities.find((e) => e.id === sim.id)?.fields).toEqual(
      sim.fields,
    );
    expect(next.relations).toEqual(snapshot.relations);
    expect(next.entities.find((e) => e.name === "3HK")?.status).toBe("ACTIVE");
  });
  it("deletes an entity, its disclosed incident edges and events atomically, and restores original IDs and values with undo", () => {
    const { snapshot, sim } = fixture();
    const text = "从 Atlas 删除 Saily，并新增 3HK 香港备用号码。";
    const proposal = empty();
    proposal.entitiesToDelete = [{ id: sim.id, evidence: text }];
    proposal.entitiesToCreate.push({
      ref: "new",
      name: "3HK",
      type: "Phone / SIM",
      status: "ACTIVE",
      attributes: { region: "HK" },
      notes: "",
      evidence: text,
    });
    const matched = matchEntities(proposal, snapshot, text);
    const before = staged(snapshot, text, matched);
    const diff = proposalDiff(matched, before);
    expect(
      diff
        .filter((c) => c.kind === "remove")
        .map((c) => c.category)
        .sort(),
    ).toEqual(["关联", "生命周期", "记忆"].sort());
    expect(diff.find((c) => c.id === sim.id)?.rows).toContainEqual({
      key: "attribute:monthly_cost",
      before: "6",
      after: undefined,
    });
    const next = applyBrowserProposal(before, "proposal", matched);
    expect(before.entities.some((e) => e.id === sim.id)).toBe(true);
    expect(next.entities.some((e) => e.id === sim.id)).toBe(false);
    expect(next.relations.some((r) => r.id === "recover")).toBe(false);
    expect(next.events.some((e) => e.entityId === sim.id)).toBe(false);
    expect(next.proposals![0].undo?.before.entities[0]).toEqual(sim);
    const restored = undoBrowserProposal(next, "proposal");
    expect(restored.entities.find((e) => e.id === sim.id)).toEqual(sim);
    expect(restored.relations.find((r) => r.id === "recover")).toEqual(
      before.relations.find((r) => r.id === "recover"),
    );
    expect(restored.events.find((e) => e.entityId === sim.id)).toEqual(
      before.events.find((e) => e.entityId === sim.id),
    );
    expect(restored.entities.some((e) => e.name === "3HK")).toBe(false);
    expect(restored.captures![0].rawText).toBe(text);
    expect(restored.proposals![0].status).toBe("PENDING");
    expect(() =>
      applyBrowserProposal(
        restored,
        "proposal",
        restored.proposals![0].content,
      ),
    ).not.toThrow();
  });
  it("removes an explicit field without clearing other values, and shows the actual old field value", () => {
    const { snapshot, sim } = fixture();
    const text = "删除 Saily 的月费属性，其他保留。";
    const proposal = empty();
    proposal.entitiesToUpdate.push({
      id: sim.id,
      name: sim.name,
      type: "Phone / SIM",
      status: "ACTIVE",
      attributes: {},
      attributesToRemove: ["monthly_cost"],
      notes: "",
      evidence: text,
    });
    const matched = matchEntities(proposal, snapshot, text);
    expect(proposalDiff(matched, snapshot)[0].rows).toEqual([
      { key: "attribute:monthly_cost", before: "6", after: undefined },
    ]);
    const next = applyBrowserProposal(
      staged(snapshot, text, matched),
      "proposal",
      matched,
    );
    expect(
      next.entities
        .find((e) => e.id === sim.id)
        ?.fields.some((f) => f.key === "monthly_cost"),
    ).toBe(false);
    expect(
      next.entities
        .find((e) => e.id === sim.id)
        ?.fields.find((f) => f.key === "carrier")?.value,
    ).toBe("Saily");
  });
  it("unlinking a recovery method does not delete either endpoint or their other relationships", () => {
    const { snapshot } = fixture();
    const text = "解除 Reddit 和 Saily 的找回关联。";
    const proposal = empty();
    proposal.relationsToDelete = [{ id: "recover", evidence: text }];
    const next = applyBrowserProposal(
      staged(snapshot, text, proposal),
      "proposal",
      proposal,
    );
    expect(next.entities).toEqual(snapshot.entities);
    expect(next.relations).toHaveLength(snapshot.relations.length - 1);
    expect(proposalDiff(proposal, snapshot)[0].category).toBe("关联");
  });
  it("rejects an abandoned number being interpreted as deletion, a negated deletion and an unknown target", () => {
    const { snapshot, sim } = fixture();
    for (const text of [
      "Saily 不用了",
      "不要删除 Saily，删除 SuperGrok",
      "删除 Saily 的月费属性",
      "移除 Saily 的复查提醒",
      "请勿删除 Saily",
      "别移除 Saily",
      "Don’t delete Saily",
    ]) {
      const proposal = empty();
      proposal.entitiesToDelete = [{ id: sim.id, evidence: text }];
      expect(() => matchEntities(proposal, snapshot, text)).toThrow();
    }
    const proposal = empty();
    proposal.entitiesToDelete = [{ id: "unknown", evidence: "删除 Saily" }];
    expect(() => matchEntities(proposal, snapshot, "删除 Saily")).toThrow();
  });
  it("does not delete fields, events or links owned by an unmentioned target", () => {
    const { snapshot, sim } = fixture();
    const field = empty();
    field.entitiesToUpdate = [
      {
        id: sim.id,
        name: sim.name,
        type: "Phone / SIM",
        status: "ACTIVE",
        attributes: {},
        attributesToRemove: ["monthly_cost"],
        notes: "",
        evidence: "删除 SuperGrok 的月费属性",
      },
    ];
    expect(() =>
      matchEntities(field, snapshot, "删除 SuperGrok 的月费属性"),
    ).toThrow("对象不明确");
    const event = empty();
    event.eventsToDelete = [
      {
        id: snapshot.events.find((e) => e.entityId === sim.id)!.id,
        evidence: "取消 SuperGrok 的提醒",
      },
    ];
    expect(() =>
      validateProposal(event, snapshot, "取消 SuperGrok 的提醒"),
    ).toThrow("对象不明确");
    const relation = empty();
    relation.relationsToDelete = [
      { id: "recover", evidence: "解除 Cloudflare 的关联" },
    ];
    expect(() =>
      validateProposal(relation, snapshot, "解除 Cloudflare 的关联"),
    ).toThrow("对象不明确");
  });
  it("keeps ordinary fields named status distinct from the memory's own status", () => {
    const { snapshot, sim } = fixture();
    sim.fields.push({
      id: "custom-status",
      entityId: sim.id,
      key: "status",
      value: "provider-active",
      valueType: "text",
      privacy: "PRIVATE",
      searchable: true,
    });
    const proposal = empty();
    proposal.entitiesToUpdate = [
      {
        id: sim.id,
        name: sim.name,
        type: "Phone / SIM",
        status: "INACTIVE",
        attributes: { status: "provider-cancelled" },
        notes: "",
        evidence: "Saily 停用了",
      },
    ];
    expect(proposalDiff(proposal, snapshot)[0].rows).toEqual([
      { key: "status", before: "使用中", after: "已停用" },
      {
        key: "attribute:status",
        before: "provider-active",
        after: "provider-cancelled",
      },
    ]);
  });
  it("accepts a domain name containing dots as an explicit deletion target", () => {
    const snapshot = demoSnapshot();
    const proposal = empty();
    proposal.entitiesToDelete = [
      { id: "domain-sayori", evidence: "删掉 sayori.org" },
    ];
    expect(() =>
      matchEntities(proposal, snapshot, "删掉 sayori.org"),
    ).not.toThrow();
  });
  it("blocks hidden cascades and secret fields without disclosing private topology in the diff", () => {
    const { snapshot, sim } = fixture();
    const proposal = empty();
    proposal.entitiesToDelete = [{ id: sim.id, evidence: "删除 Saily" }];
    snapshot.relations.find((r) => r.id === "recover")!.privacy = "SECRET";
    expect(() => matchEntities(proposal, snapshot, "删除 Saily")).toThrow(
      "隐藏关联",
    );
    expect(
      proposalDiff(proposal, snapshot).some((c) => c.id === "recover"),
    ).toBe(false);
    snapshot.relations.find((r) => r.id === "recover")!.privacy = "PRIVATE";
    sim.fields[0].privacy = "SECRET";
    expect(() => matchEntities(proposal, snapshot, "删除 Saily")).toThrow(
      "秘密字段",
    );
  });
  it("stale graph changes cannot be silently cascaded and undo cannot overwrite a subsequent capture", () => {
    const { snapshot, sim } = fixture();
    const text = "删除 Saily";
    const proposal = empty();
    proposal.entitiesToDelete = [{ id: sim.id, evidence: text }];
    const matched = matchEntities(proposal, snapshot, text);
    staged(snapshot, text, matched);
    const next = applyBrowserProposal(snapshot, "proposal", matched);
    next.revision += 1;
    expect(() => undoBrowserProposal(next, "proposal")).toThrow("后续变更");
    snapshot.revision += 1;
    expect(() => applyBrowserProposal(snapshot, "proposal", matched)).toThrow(
      "记忆库已变化",
    );
    expect(snapshot.entities.some((e) => e.id === sim.id)).toBe(true);
  });
  it("canceling an entity deletion also cancels its derived relation/event removals", () => {
    const { snapshot, sim } = fixture();
    const proposal = empty();
    proposal.entitiesToDelete = [{ id: sim.id, evidence: "删除 Saily" }];
    expect(deletionTargets(proposal, snapshot).relations.has("recover")).toBe(
      true,
    );
    proposal.entitiesToDelete = [];
    expect(proposalDiff(proposal, snapshot)).toEqual([]);
  });
  it("old proposals remain valid without removal arrays and do not show unchanged fields", () => {
    const { snapshot, sim } = fixture();
    const proposal = empty();
    proposal.entitiesToUpdate.push({
      id: sim.id,
      name: sim.name,
      type: "Phone / SIM",
      status: "ACTIVE",
      attributes: { monthly_cost: 6 },
      notes: "",
      evidence: "Saily",
    });
    expect(proposalSchema.parse(proposal)).toEqual(proposal);
    expect(proposalDiff(proposal, snapshot)).toEqual([]);
  });
  it("gives the model bounded deletion metadata but no field values, then assigns provenance and resolves versions locally", async () => {
    const { snapshot, sim } = fixture();
    sim.fields.push({
      id: "private",
      entityId: sim.id,
      key: "personal_note",
      value: "do-not-send-values",
      valueType: "text",
      privacy: "PRIVATE",
      searchable: true,
    });
    const text = "删除 Saily";
    const proposal = empty();
    proposal.entitiesToDelete = [{ id: sim.id, evidence: "fake evidence" }];
    const transport = vi.fn(async () => JSON.stringify(proposal));
    const result = await createProvider(
      DEFAULT_PROVIDER,
      transport,
    ).parseCapture(text, { snapshot, now: "2026-10-07" });
    const prompt = JSON.stringify(transport.mock.calls[0][0]);
    expect(prompt).toContain("fieldKeys");
    expect(prompt).not.toContain("do-not-send-values");
    const schema = transport.mock.calls[0][0].schema;
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "entitiesToDelete",
        "relationsToDelete",
        "eventsToDelete",
      ]),
    );
    expect(JSON.stringify(schema)).not.toContain("expectedUpdatedAt");
    expect(result.entitiesToDelete![0].evidence).toBe(text);
    expect(
      matchEntities(result, snapshot, text).entitiesToDelete![0]
        .expectedUpdatedAt,
    ).toBe(sim.updatedAt);
  });
  it("omits deletion capability from the generation schema for an ordinary update", async () => {
    const { snapshot, sim } = fixture();
    const text = "把 Saily 月费改成七元";
    const proposal = empty();
    proposal.entitiesToUpdate = [
      {
        id: sim.id,
        name: sim.name,
        type: "Phone / SIM",
        status: "ACTIVE",
        attributes: { monthly_cost: 7 },
        notes: "",
        evidence: text,
      },
    ];
    const transport = vi.fn(async () => JSON.stringify(proposal));
    await createProvider(DEFAULT_PROVIDER, transport).parseCapture(text, {
      snapshot,
      now: "2026-10-07",
    });
    const schema = JSON.stringify(transport.mock.calls[0][0].schema);
    expect(schema).not.toContain("entitiesToDelete");
    expect(schema).not.toContain("attributesToRemove");
    expect(
      JSON.stringify(transport.mock.calls[0][0].messages[1]),
    ).not.toContain("fieldKeys");
  });
  it("treats an invented unknown field value as uncertainty and preserves the real stored value", async () => {
    const { snapshot, sim } = fixture();
    const text = "删除 Saily 的月费属性，其余保留。";
    const proposal = empty();
    proposal.entitiesToUpdate = [
      {
        id: sim.id,
        name: sim.name,
        type: "Phone / SIM",
        status: "ACTIVE",
        attributes: { carrier: "未知" },
        attributesToRemove: ["monthly_cost"],
        notes: "",
        evidence: text,
      },
    ];
    const parsed = await createProvider(DEFAULT_PROVIDER, async () =>
      JSON.stringify(proposal),
    ).parseCapture(text, { snapshot, now: "2026-10-07" });
    expect(parsed.entitiesToUpdate[0].attributes).toEqual({});
    expect(parsed.uncertainty.join(" ")).toContain("未提供");
    const matched = matchEntities(parsed, snapshot, text);
    const next = applyBrowserProposal(
      staged(snapshot, text, matched),
      "proposal",
      matched,
    );
    expect(
      next.entities
        .find((e) => e.id === sim.id)!
        .fields.find((f) => f.key === "carrier")!.value,
    ).toBe("Saily");
    const explicit = "Saily 运营商未知，删除 Saily 的月费属性";
    const result = await createProvider(DEFAULT_PROVIDER, async () =>
      JSON.stringify(proposal),
    ).parseCapture(explicit, { snapshot, now: "2026-10-07" });
    expect(result.entitiesToUpdate[0].attributes.carrier).toBe("未知");
  });
});
