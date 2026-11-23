import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "relakeep-finance-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  RELAKEEP_NO_LISTEN: "true",
  PUBLIC_ORIGIN: "http://localhost:4190",
  DATA_DIR: directory,
  BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
  CACHE_KEY: "77".repeat(32),
  PROXY_SECRET: "synthetic-proxy-secret-at-least-32-characters",
  CLOUD_ENABLED: "true",
  BILLING_ENABLED: "false",
  QWEN_API_KEY: "synthetic",
  QWEN_BASE_URL: "https://model.example.invalid/v1",
});
const originalFetch = globalThis.fetch;
const { app, ledger } = await import("../dist/app.js");
const db = ledger.db,
  user = randomUUID(),
  token = randomUUID(),
  now = Date.now();
db.prepare(
  "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
).run(user, "Fixture", "finance@example.invalid", 1, now, now);
db.prepare(
  "INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
).run(randomUUID(), token, user, now + 60000, now, now);
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            entries: [
              {
                kind: "SPEND",
                amount: { amount: "8.00", asset: "CNY" },
                accountId: "cash",
                counterId: "expense",
                occurredAt: "2026-10-15",
                projectId: "",
                resourceId: "",
                orderId: "",
                note: "synthetic",
                evidence: "现金付了八块",
              },
            ],
            uncertainty: [],
          }),
        },
      },
    ],
  });
};
const input = (kind) => ({
  requestId: randomUUID(),
  kind,
  text: "现金付了八块",
  now: new Date().toISOString(),
  entities: [],
  relations: [],
  events: [],
  ledgerAccounts: [
    { id: "cash", name: "现金", kind: "ASSET", asset: "CNY" },
    { id: "expense", name: "其他支出", kind: "EXPENSE" },
  ],
});
const call = (body) =>
  app.request("http://localhost:4190/api/account/ai", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
      "x-relakeep-proxy": process.env.PROXY_SECRET,
    },
    body: JSON.stringify(body),
  });
test("finance uses the existing paid reservation and replay path", async () => {
  for (const kind of ["ledger", "ledger-query"])
    assert.equal((await call(input(kind))).status, 402);
  assert.equal(calls, 0);
  ledger.grant("synthetic-paid", user, "topup", 2, null, "synthetic-payment");
  const request = input("ledger"),
    response = await call(request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(
    result.result.financeActions[0].transaction.legs[0].money.amount,
    "-8.00",
  );
  assert.equal((await call(request)).status, 200);
  assert.equal(calls, 1);
  assert.equal(ledger.balance(user).topup, 1);
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}", { status: 503 });
  };
  assert.equal((await call(input("ledger"))).status, 502);
  assert.equal(ledger.balance(user).topup, 1);
});
test.after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
