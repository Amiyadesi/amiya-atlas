import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginTextCapture,
  confirmProposal,
  initializeVault,
  loadSnapshot,
  stageProposal,
} from "../src/lib/api";
import {
  createProvider,
  DEFAULT_PROVIDER,
  matchingContext,
} from "../src/ai/provider";
import {
  applyBrowserProposal,
  matchEntities,
  oneHop,
  parseModelJson,
  searchEntities,
  validateProposal,
} from "../src/domain/proposal";
import type { Proposal } from "../src/domain/proposal";
import { emptySnapshot } from "../src/lib/types";
import { demoSnapshot } from "../src/lib/demo";

const raw =
  "Saily 是我唯一一个美国 +1 号码，一个月六块多，主要备用和收藏，目前先保留。";
const proposal = (): Proposal => ({
  entitiesToCreate: [
    {
      ref: "saily",
      name: "Saily +1",
      type: "Phone / SIM",
      status: "ACTIVE",
      attributes: {
        region: "US",
        monthly_cost: 6,
        currency: "CNY",
        roles: ["Backup", "Collection"],
        decision: "Keep",
      },
      notes: "月费约六元，唯一的美国 +1 号码",
      evidence: raw,
    },
  ],
  entitiesToUpdate: [],
  relationsToCreate: [],
  eventsToCreate: [],
  uncertainty: [],
});

describe("capture → review → remember", () => {
  beforeEach(async () => {
    await initializeVault("preview test password");
  });
  it("persists the original and proposal without creating entities until confirmation; duplicate confirmation is harmless", async () => {
    let snapshot = await beginTextCapture(raw);
    expect(snapshot.entities).toHaveLength(0);
    expect(snapshot.captures?.[0].rawText).toBe(raw);
    snapshot = await stageProposal(
      snapshot.captures![0].id,
      proposal(),
      "test-model",
    );
    expect(snapshot.entities).toHaveLength(0);
    const id = snapshot.proposals![0].id;
    snapshot = await confirmProposal(id, proposal());
    expect(snapshot.entities).toHaveLength(1);
    expect(searchEntities(snapshot, "美国").map((e) => e.name)).toEqual([
      "Saily +1",
    ]);
    expect(snapshot.captures![0].status).toBe("CONFIRMED");
    expect(snapshot.proposals![0].entityIds).toEqual([snapshot.entities[0].id]);
    expect((await confirmProposal(id, proposal())).entities).toHaveLength(1);
    expect((await loadSnapshot()).entities).toHaveLength(1);
  });
  it("bad relation endpoints fail before confirmation and preserve the original", async () => {
    const snapshot = await beginTextCapture(raw);
    const p = proposal();
    p.relationsToCreate.push({
      from: "saily",
      to: "made-up-card",
      type: "PAID_BY",
      note: "",
      evidence: "Saily",
    });
    await expect(
      stageProposal(snapshot.captures![0].id, p, "test"),
    ).rejects.toThrow("关系");
    expect((await loadSnapshot()).entities).toHaveLength(0);
    expect((await loadSnapshot()).captures![0].rawText).toBe(raw);
  });
  it("exact matching reuses a legacy SIM record and keeps attributes not mentioned in the update", () => {
    const snapshot = demoSnapshot();
    const existing = snapshot.entities.find((e) => e.category === "SIM")!;
    const p = proposal();
    p.entitiesToCreate[0].name = existing.name;
    const matched = matchEntities(p, snapshot, raw);
    expect(matched.entitiesToCreate).toHaveLength(0);
    expect(matched.entitiesToUpdate[0].id).toBe(existing.id);
    snapshot.captures = [
      {
        id: "c",
        rawText: raw,
        status: "PENDING",
        timestamp: new Date().toISOString(),
        inputType: "text",
      },
    ];
    snapshot.proposals = [
      {
        id: "p",
        captureId: "c",
        content: matched,
        status: "PENDING",
        provider: "test",
        createdAt: new Date().toISOString(),
        entityIds: [],
      },
    ];
    const next = applyBrowserProposal(snapshot, "p", matched);
    expect(
      next.entities
        .find((e) => e.id === existing.id)!
        .fields.find((f) => f.key === "carrier")?.value,
    ).toBe("Saily");
    expect(next.entities.find((e) => e.id === existing.id)!.category).toBe(
      "SIM",
    );
    snapshot.entities.find((e) => e.id === existing.id)!.updatedAt =
      "2099-01-01T00:00:00Z";
    expect(() => applyBrowserProposal(snapshot, "p", matched)).toThrow(
      "记忆已变化",
    );
  });
  it("does not merge different types or ambiguous accounts", () => {
    const snapshot = demoSnapshot();
    const p = proposal();
    p.entitiesToCreate[0].name = snapshot.entities[0].name;
    expect(matchEntities(p, snapshot, raw).entitiesToCreate).toHaveLength(1);
  });
  it("keeps month precision and rejects invalid dates or missing evidence", () => {
    const p = proposal();
    p.eventsToCreate.push({
      entityRef: "saily",
      type: "EXPIRY",
      dueAt: "2026-12",
      precision: "month",
      policy: "DO_NOT_RENEW",
      note: "",
      evidence: "Saily",
    });
    expect(() => validateProposal(p, emptySnapshot(), raw)).not.toThrow();
    p.eventsToCreate[0].dueAt = "2026-13";
    expect(() => validateProposal(p, emptySnapshot(), raw)).toThrow("日期");
    const bad = proposal();
    bad.entitiesToCreate[0].evidence = "invented";
    expect(() => validateProposal(bad, emptySnapshot(), raw)).toThrow(
      "原文依据",
    );
  });
});

describe("model boundary and factual exploration", () => {
  it("strips wrappers but refuses malformed or extra model commands", () => {
    expect(parseModelJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(() => parseModelJson("please run SQL")).toThrow("有效提案");
    const p = { ...proposal(), deleteAll: true };
    expect(() => matchEntities(p as Proposal, emptySnapshot(), raw)).toThrow();
  });
  it("sends bounded candidate metadata, never secret fields, API keys or original captures", async () => {
    const snapshot = demoSnapshot();
    snapshot.entities[0].fields.push({
      id: "secret",
      entityId: snapshot.entities[0].id,
      key: "secret_note",
      value: "do-not-send-me",
      valueType: "text",
      privacy: "SECRET",
      searchable: true,
    });
    snapshot.aiConfig = { ...DEFAULT_PROVIDER, apiKey: "do-not-send-api-key" };
    snapshot.captures = [
      {
        id: "c",
        inputType: "text",
        timestamp: new Date().toISOString(),
        status: "CONFIRMED",
        rawText: "do-not-send-raw-history",
      },
    ];
    expect(matchingContext("Google", snapshot).length).toBeLessThanOrEqual(12);
    const transport = vi.fn(async () => JSON.stringify(proposal()));
    await createProvider(DEFAULT_PROVIDER, transport).parseCapture(raw, {
      snapshot,
      now: "2026-10-02",
    });
    const prompt = JSON.stringify(transport.mock.calls[0][0]);
    expect(prompt).not.toContain("do-not-send-me");
    expect(prompt).not.toContain("do-not-send-api-key");
    expect(prompt).not.toContain("do-not-send-raw-history");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("assigns original-text provenance itself and retries one invalid model reference without committing", async () => {
    const malformed = proposal();
    malformed.eventsToCreate = [
      {
        entityRef: "not-a-real-ref",
        type: "EXPIRY",
        dueAt: "",
        precision: "unknown",
        policy: "REVIEW",
        note: "",
        evidence: "fabricated quotation",
      },
    ];
    const corrected = proposal();
    corrected.entitiesToCreate[0].evidence = "fabricated quotation";
    corrected.eventsToCreate = [
      {
        entityRef: "saily",
        type: "EXPIRY",
        dueAt: "2026-12",
        precision: "year",
        policy: "REVIEW",
        note: "",
        evidence: raw,
      },
    ];
    const transport = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(malformed))
      .mockResolvedValueOnce(JSON.stringify(corrected));
    const parsed = await createProvider(
      DEFAULT_PROVIDER,
      transport,
    ).parseCapture(raw, { snapshot: emptySnapshot(), now: "2026-10-02" });
    expect(parsed.entitiesToCreate[0].evidence).toBe(raw);
    expect(parsed.eventsToCreate[0].precision).toBe("month");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      transport.mock.calls[0][0].schema.properties.entitiesToCreate.items
        .properties,
    ).not.toHaveProperty("evidence");
    expect((await loadSnapshot()).entities).toHaveLength(0);
  });
  it("keeps identifiable memories while surfacing unresolved relation endpoints as uncertainty", async () => {
    const output = proposal();
    output.relationsToCreate.push({
      from: "saily",
      to: "unidentified-account",
      type: "REGISTERED_WITH",
      note: "",
      evidence: raw,
    });
    const transport = vi.fn(async () => JSON.stringify(output));
    const parsed = await createProvider(
      DEFAULT_PROVIDER,
      transport,
    ).parseCapture(raw, { snapshot: emptySnapshot(), now: "2026-10-02" });
    expect(parsed.entitiesToCreate).toHaveLength(1);
    expect(parsed.relationsToCreate).toHaveLength(0);
    expect(parsed.uncertainty.join(" ")).toContain("缺少可辨认的对象");
    expect((await loadSnapshot()).entities).toHaveLength(0);
  });
  it("one-hop expansion does not display every entity or hidden topology", () => {
    const snapshot = demoSnapshot();
    const graph = oneHop(snapshot, ["cloudflare-main"]);
    expect(graph.entities.map((e) => e.id).sort()).toEqual([
      "cloudflare-main",
      "domain-sayori",
    ]);
    snapshot.entities.find((e) => e.id === "domain-sayori")!.privacy = "SECRET";
    expect(oneHop(snapshot, ["cloudflare-main"]).entities).toHaveLength(1);
    expect(oneHop(snapshot, ["cloudflare-main"]).relations).toHaveLength(0);
    expect(
      searchEntities(snapshot, "sayori.org").map((e) => e.id),
    ).not.toContain("domain-sayori");
  });
  it("does not mistake user or usage for the US region alias", () => {
    const snapshot = demoSnapshot();
    snapshot.entities[0].name = "Useful user account";
    expect(searchEntities(snapshot, "美国").map((e) => e.id)).toEqual([
      "sim-saily",
    ]);
  });
  it("combines name and region filters instead of ignoring one condition", () => {
    const snapshot = demoSnapshot();
    expect(searchEntities(snapshot, "Google", "JP").map((e) => e.id)).toEqual([
      "id-google-jp",
    ]);
    expect(
      searchEntities(snapshot, "", "JP").every((e) =>
        e.fields.some((f) => f.key === "region" && f.value === "JP"),
      ),
    ).toBe(true);
  });
});
