import { expect, test } from "vitest";
import {
  connectionGaps,
  connectionHints,
  connectionSlots,
  proposedConnectionGaps,
  slotRelations,
  fieldConnections,
} from "../src/domain/relationships";
import { emptySnapshot, type Entity, type Relation } from "../src/lib/types";
import {
  entityIcon,
  tagIcon,
  tagName,
  withTagIcon,
} from "../src/lib/record-tags";

const entity = (category: string): Entity => ({
  id: "asset",
  name: "示例",
  category,
  status: "ACTIVE",
  privacy: "PRIVATE",
  tags: [],
  fields: [],
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
});
const edge = (
  type: string,
  sourceId = "asset",
  targetId = "other",
): Relation => ({
  id: "edge",
  sourceId,
  targetId,
  type,
  privacy: "PRIVATE",
  createdAt: "2026-10-16T00:00:00Z",
});

test("an arbitrary edge does not replace an account login origin; explicit login/owned email does", () => {
  for (const category of [
    "Account",
    "Identity",
    "Website Account",
    "AI Provider Account",
  ]) {
    expect(
      connectionGaps(entity(category), { relations: [edge("PAID_BY")] }).map(
        (s) => s.key,
      ),
    ).toEqual(["login"]);
    for (const type of [
      "REGISTERED_WITH",
      "AUTHENTICATES_WITH",
      "OWNS_ADDRESS",
    ])
      expect(
        connectionGaps(entity(category), { relations: [edge(type)] }),
      ).toEqual([]);
  }
  expect(
    connectionGaps(
      { ...entity("Account"), status: "ARCHIVED" },
      { relations: [] },
    ),
  ).toEqual([]);
  expect(connectionGaps(entity("Provider"), { relations: [] })).toEqual([]);
});
test("carrier, issuer and registrar are real connections; known fields remain reviewable hints", () => {
  for (const category of [
    "SIM",
    "Phone / SIM",
    "Payment Card",
    "Bank Account",
    "Domain",
  ]) {
    const item = entity(category),
      slot = connectionSlots(category)[0];
    item.fields = [
      {
        id: "f",
        entityId: item.id,
        key: slot.fields[0],
        valueType: "text",
        value: "已知服务商",
        privacy: "PRIVATE",
        searchable: true,
      },
    ];
    const before = structuredClone(item);
    expect(connectionGaps(item, { relations: [] })).toHaveLength(1);
    expect(connectionHints(item, slot)).toEqual([
      { name: "已知服务商", category: "Provider" },
    ]);
    expect(item).toEqual(before);
    expect(connectionGaps(item, { relations: [edge(slot.type)] })).toEqual([]);
    item.fields[0].privacy = "SECRET";
    expect(connectionHints(item, slot)).toEqual([]);
  }
});
test("a service can retain domain, server, source and several upstreams; inverse HOSTS is recognized", () => {
  const slots = connectionSlots("Service"),
    relations = [
      edge("EXPOSED_AT"),
      edge("HOSTS", "server", "asset"),
      edge("SOURCE_IN"),
      edge("DEPENDS_ON"),
      { ...edge("DEPENDS_ON", "asset", "quota2"), id: "second" },
    ];
  expect(slots.map((s) => slotRelations(s, "asset", relations).length)).toEqual(
    [1, 1, 2, 1],
  );
});
test("proposal preview identifies unknown origins without inventing them; provider is supported", () => {
  const proposal = {
    entitiesToCreate: [
      {
        ref: "a",
        name: "账号",
        type: "Account" as const,
        status: "ACTIVE" as const,
        attributes: {},
        notes: "",
        evidence: "账号",
      },
      {
        ref: "p",
        name: "平台",
        type: "Provider" as const,
        status: "ACTIVE" as const,
        attributes: {},
        notes: "",
        evidence: "平台",
      },
    ],
    entitiesToUpdate: [],
    relationsToCreate: [],
    eventsToCreate: [],
    uncertainty: [],
  };
  expect(proposedConnectionGaps(proposal, emptySnapshot())).toMatchObject([
    { ref: "a", labels: ["注册 / 登录方式"] },
  ]);
  expect(proposal.relationsToCreate).toEqual([]);
});
test("custom tag symbols round-trip as encrypted ordinary tags", () => {
  expect(entityIcon(["工作", "收藏"])).toBe("⭐");
  expect(tagName("📌 长期保留")).toBe("长期保留");
  expect(tagIcon("📌 长期保留")).toBe("📌");
  expect(withTagIcon("📌 长期保留", "🔒")).toBe("🔒 长期保留");
  expect(withTagIcon("📌 长期保留", "")).toBe("长期保留");
  expect(entityIcon(["🦊 私人项目"])).toBe("🦊");
});

test("field completion reuses one provider, skips ambiguous/secret/unknown values and is idempotent", () => {
  const s = emptySnapshot(),
    a = entity("SIM"),
    b = { ...entity("SIM"), id: "b" };
  a.fields = [
    {
      id: "fa",
      entityId: a.id,
      key: "carrier",
      valueType: "text",
      value: "Acme",
      privacy: "PRIVATE",
      searchable: true,
    },
  ];
  b.fields = [{ ...a.fields[0], id: "fb", entityId: b.id }];
  s.entities = [a, b];
  const before = structuredClone(s),
    p = fieldConnections(s);
  expect(s).toEqual(before);
  expect(p.entities).toHaveLength(1);
  expect(p.relations).toHaveLength(2);
  const applied = {
    ...s,
    entities: [...s.entities, ...p.entities],
    relations: p.relations,
  };
  expect(fieldConnections(applied).relations).toEqual([]);
  applied.entities.push({ ...p.entities[0], id: "duplicate" });
  expect(fieldConnections(applied).ambiguous).toEqual(["asset", "b"]);
  a.fields[0].privacy = "SECRET";
  b.fields[0].value = "NEEDS_REVIEW";
  expect(fieldConnections(s).relations).toEqual([]);
});
