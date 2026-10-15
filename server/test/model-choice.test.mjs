import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "relakeep-model-choice-"));
Object.assign(process.env, {
  NODE_ENV: "test", RELAKEEP_NO_LISTEN: "true",
  PUBLIC_ORIGIN: "http://localhost:4190", DATA_DIR: directory,
  BETTER_AUTH_SECRET: "fixture-auth-secret-at-least-32-characters",
  CACHE_KEY: "77".repeat(32), PROXY_SECRET: "fixture-proxy-secret-at-least-32-characters",
  CLOUD_ENABLED: "true", BILLING_ENABLED: "false", QWEN_API_KEY: "fixture-only",
  QWEN_BASE_URL: "https://model.example.invalid/v1",
  CLOUD_MODELS: JSON.stringify([
    { id: "default", name: "Default", upstream: "default-route" },
    { id: "subscriber", name: "Subscriber", upstream: "subscriber-route" },
  ]),
});
const originalFetch = globalThis.fetch;
const { app, ledger } = await import("../dist/app.js");
const db = ledger.db, user = randomUUID(), token = randomUUID(), now = Date.now();
db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(user, "Fixture", "fixture@example.invalid", 1, now, now);
db.prepare("INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(randomUUID(), token, user, now + 60000, now, now);
const calls = [];
let upstreamFails = false;
globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://model.example.invalid/v1/chat/completions");
  calls.push(JSON.parse(init.body).model);
  return upstreamFails
    ? new Response("{}", { status: 503 })
    : Response.json({ choices: [{ message: { content: JSON.stringify({ search: "", region: "JP" }) } }] });
};
const call = (path, body) => app.request("http://localhost:4190/api/account/" + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + token, "x-relakeep-proxy": process.env.PROXY_SECRET },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const input = (kind = "query") => ({ requestId: randomUUID(), kind, text: "查找日本的电话卡", now: new Date().toISOString(), entities: [], relations: [], events: [] });

test("account model choices enforce paid periods and cannot grant owner privileges", async () => {
  for (const kind of ["capture", "query"]) {
    const response = await call("ai", input(kind));
    assert.equal(response.status, 402);
    assert.equal((await response.json()).code, "NO_CREDITS");
  }
  assert.equal(calls.length, 0);
  assert.equal((await call("model", { model: "subscriber" })).status, 402);
  assert.equal((await call("model", { model: "default", unlimited: true, internal_usd_cents: 99999999900 })).status, 400);
  assert.equal(ledger.balance(user).unlimited, false);
  ledger.grant("topup", user, "topup", 2, null, "pi_fixture_topup");
  assert.equal((await call("model", { model: "subscriber" })).status, 402);
  assert.equal((await call("model", { model: "default" })).status, 200);
  ledger.grant("month", user, "monthly", 2, now + 60000, "pi_fixture_month");
  assert.equal((await call("model", { model: "missing" })).status, 400);
  const selected = await call("model", { model: "subscriber" });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).selectedModel, "subscriber");
  const request = input();
  assert.equal((await call("ai", request)).status, 200);
  assert.equal((await call("ai", request)).status, 200);
  assert.deepEqual(calls, ["subscriber-route"]);
  assert.equal(ledger.balance(user).monthly, 1);
  upstreamFails = true;
  assert.equal((await call("ai", input())).status, 502);
  assert.equal(ledger.balance(user).monthly, 1);
  ledger.revoke(null, "pi_fixture_month");
  const count = calls.length;
  assert.equal((await call("ai", request)).status, 200);
  assert.equal((await call("ai", input())).status, 402);
  assert.equal(calls.length, count);
  assert.equal(ledger.balance(user).topup, 2);
  db.prepare("UPDATE cloud_preferences SET model='retired' WHERE user_id=?").run(user);
  assert.equal((await call("ai", request)).status, 200);
  assert.equal((await call("model", { model: "default" })).status, 200);
  upstreamFails = false;
  assert.equal((await call("ai", input())).status, 200);
  assert.equal(calls.at(-1), "default-route");
  assert.equal(ledger.balance(user).topup, 1);
  db.prepare("INSERT INTO cloud_preferences(user_id,unlimited,internal_usd_cents) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET unlimited=1,internal_usd_cents=excluded.internal_usd_cents").run(user, 99999999900);
  assert.equal((await call("model", { model: "subscriber" })).status, 200);
  assert.equal((await call("ai", input())).status, 200);
  assert.equal(ledger.balance(user).topup, 1);
  const balance = await (await call("balance")).json();
  assert.equal(balance.internalBalanceUsd, 999999999);
  assert.equal(balance.unlimited, true);
  assert.equal(JSON.stringify(balance).includes("subscriber-route"), false);
  assert.equal((await (await call("purchases")).json()).some(p => p.id.startsWith("owner:")), false);
});
test.after(() => { globalThis.fetch = originalFetch; db.close(); rmSync(directory, { recursive: true, force: true }); });
