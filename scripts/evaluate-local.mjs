import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const vite = await createServer({ server: { middlewareMode: true } });
try {
  const { createProvider, DEFAULT_PROVIDER, chatTransport } =
    await vite.ssrLoadModule("/src/ai/provider.ts");
  const { matchEntities } = await vite.ssrLoadModule("/src/domain/proposal.ts");
  const { emptySnapshot } = await vite.ssrLoadModule("/src/lib/types.ts");
  let requestNumber = 0;
  await mkdir("qa-artifacts", { recursive: true });
  const provider = createProvider(DEFAULT_PROVIDER, async (request) => {
    const output = await chatTransport(request);
    await writeFile(
      `qa-artifacts/evaluation-response-${++requestNumber}.txt`,
      output,
    );
    return output;
  });
  const existing = emptySnapshot();
  existing.entities.push({
    id: "00000000-0000-4000-8000-000000000001",
    name: "Saily",
    category: "SIM",
    status: "ACTIVE",
    privacy: "PRIVATE",
    tags: [],
    fields: [
      {
        id: "carrier",
        entityId: "00000000-0000-4000-8000-000000000001",
        key: "carrier",
        value: "Saily",
        valueType: "text",
        searchable: true,
        privacy: "PRIVATE",
      },
    ],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  const samples = [
    {
      id: "saily",
      text: "Saily 是我唯一一个美国 +1 号码，一个月六块多，主要备用和收藏，目前先保留。",
    },
    { id: "grok", text: "SuperGrok 已经付到 2026 年 12 月，以后不续。" },
    {
      id: "cloudflare",
      text: "我有三个 Cloudflare 账号，主号是 atlas-test@example.invalid，sayori.org 在里面。",
    },
    {
      id: "gmail",
      text: "我的 Gmail 主邮箱是 atlas-mail@example.invalid，地区日本，用来注册账号。",
    },
    { id: "hsbc", text: "我有一个 HSBC 银行账户，在香港，平时用来收款。" },
    { id: "server", text: "阿里云杭州服务器是我的博客服务器，暂时保留。" },
    {
      id: "update",
      text: "把 Saily 月费改成七元，其他信息保持。",
      snapshot: existing,
    },
  ];
  const report = [];
  for (const sample of samples) {
    if (process.argv[2] && sample.id !== process.argv[2]) continue;
    const start = performance.now();
    const output = await provider.parseCapture(sample.text, {
      snapshot: sample.snapshot ?? emptySnapshot(),
      now: "2026-10-02T12:00:00Z",
    });
    await mkdir("qa-artifacts", { recursive: true });
    await writeFile(
      `qa-artifacts/${sample.id}-output.json`,
      JSON.stringify(output, null, 2),
    );
    const proposal = matchEntities(
      output,
      sample.snapshot ?? emptySnapshot(),
      sample.text,
    );
    await mkdir("qa-artifacts", { recursive: true });
    await writeFile(
      `qa-artifacts/${sample.id}-proposal.json`,
      JSON.stringify(proposal, null, 2),
    );
    if (sample.id === "saily") {
      const sim = proposal.entitiesToCreate.find(
        (e) => e.type === "Phone / SIM",
      );
      assert.ok(sim, "Saily should be a phone/SIM");
      assert.equal(sim.attributes.region ?? sim.attributes.country, "US");
      assert.equal(sim.attributes.monthly_cost, 6);
      assert.equal(sim.attributes.currency, "CNY");
      assert.equal(sim.status, "ACTIVE");
      assert.ok(
        sim.attributes.roles?.includes("备用") &&
          sim.attributes.roles?.includes("收藏"),
      );
      assert.equal(sim.attributes.decision, "Keep");
      assert.equal(sim.attributes.monthly_cost_approximate, true);
      assert.ok(
        sim.notes.includes("约") || sim.notes.includes("多"),
        "Approximation must remain visible",
      );
      assert.equal(
        proposal.relationsToCreate.length,
        0,
        "No invented payment card",
      );
    }
    if (sample.id === "grok") {
      const event = proposal.eventsToCreate.find((e) => e.type === "EXPIRY");
      assert.ok(event, "Grok needs an expiry event");
      assert.equal(event.dueAt, "2026-12");
      assert.equal(event.precision, "month");
      assert.equal(event.policy, "DO_NOT_RENEW");
    }
    if (sample.id === "cloudflare") {
      assert.ok(
        proposal.entitiesToCreate.some(
          (e) => e.type === "Domain" && e.name === "sayori.org",
        ),
      );
      assert.ok(proposal.entitiesToCreate.some((e) => e.type === "Email"));
      assert.ok(
        proposal.relationsToCreate.length >= 2,
        "Email/account/domain should be connected",
      );
      assert.ok(
        proposal.entitiesToCreate.filter((e) => e.type === "Account").length <=
          1,
        "Do not invent unnamed accounts",
      );
    }
    if (sample.id === "gmail") {
      const email = proposal.entitiesToCreate.find(
        (e) => e.type === "Email" && e.name === "atlas-mail@example.invalid",
      );
      assert.ok(email);
      assert.equal(email.attributes.region, "JP");
    }
    if (sample.id === "hsbc") {
      const bank = proposal.entitiesToCreate.find(
        (e) => e.type === "Bank Account",
      );
      assert.ok(bank);
      assert.equal(bank.attributes.region, "HK");
      assert.ok(
        !("balance" in bank.attributes),
        "Do not invent a bank balance",
      );
    }
    if (sample.id === "server") {
      const server = proposal.entitiesToCreate.find((e) => e.type === "Server");
      assert.ok(server);
      assert.ok(JSON.stringify(server).includes("杭州"));
      assert.ok(!("ip" in server.attributes), "Do not invent an IP address");
    }
    if (sample.id === "update") {
      assert.equal(proposal.entitiesToCreate.length, 0);
      assert.equal(proposal.entitiesToUpdate.length, 1);
      assert.equal(proposal.entitiesToUpdate[0].id, existing.entities[0].id);
      assert.equal(proposal.entitiesToUpdate[0].attributes.monthly_cost, 7);
      assert.ok(!("carrier" in proposal.entitiesToUpdate[0].attributes));
    }
    const entry = {
      sample: sample.id,
      seconds: Math.round((performance.now() - start) / 100) / 10,
      entities: proposal.entitiesToCreate.length,
      updates: proposal.entitiesToUpdate.length,
      relations: proposal.relationsToCreate.length,
      events: proposal.eventsToCreate.length,
      uncertainty: proposal.uncertainty,
    };
    report.push(entry);
    console.log(JSON.stringify(entry));
  }
  for (const [query, expected] of [
    ["我有哪些日本的东西？", { search: "", region: "JP" }],
    ["日本的 Google 账号", { search: "Google", region: "JP" }],
  ]) {
    const start = performance.now();
    const parsed = await provider.parseQuery(query);
    assert.deepEqual(parsed, expected);
    const entry = {
      query,
      parsed,
      seconds: Math.round((performance.now() - start) / 100) / 10,
    };
    report.push(entry);
    console.log(JSON.stringify(entry));
  }
  await mkdir("qa-artifacts", { recursive: true });
  await writeFile(
    "qa-artifacts/local-model-evaluation.json",
    JSON.stringify(report, null, 2),
  );
} finally {
  await vite.close();
}
