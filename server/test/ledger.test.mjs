import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Ledger } from "../dist/ledger.js";
const request = "request_1234567890";
function fixture() {
  let now = 100000;
  const db = new Database(":memory:");
  const ledger = new Ledger(db, Buffer.alloc(32, 7), () => now);
  const attempts = new Map(),
    reserve = ledger.reserve.bind(ledger),
    complete = ledger.complete.bind(ledger),
    fail = ledger.fail.bind(ledger);
  ledger.reserve = (user, id, input) => {
    const result = reserve(user, id, input);
    if (result.attempt) attempts.set(user + id, result.attempt);
    return result;
  };
  ledger.complete = (user, id, result, attempt = attempts.get(user + id)) =>
    complete(user, id, result, attempt);
  ledger.fail = (user, id, error, attempt = attempts.get(user + id)) =>
    fail(user, id, error, attempt);
  return {
    db,
    ledger,
    advance: (ms) => {
      now += ms;
    },
  };
}
test("monthly is spent before top-up, expires at billing boundary", () => {
  const { ledger, advance } = fixture();
  ledger.grant("topup", "u", "topup", 300, null);
  ledger.grant("month", "u", "monthly", 300, 200000);
  ledger.reserve("u", request, { text: "sample" });
  ledger.complete("u", request, { ok: true });
  assert.deepEqual(
    [ledger.balance("u").monthly, ledger.balance("u").topup],
    [299, 300],
  );
  advance(100001);
  assert.equal(ledger.balance("u").total, 300);
});
test("duplicate requests replay encrypted result without another debit", () => {
  const { ledger, db } = fixture();
  ledger.grant("pack", "u", "topup", 300, null);
  ledger.reserve("u", request, { text: "sample" });
  ledger.complete("u", request, { name: "private-secret-name" });
  assert.deepEqual(ledger.reserve("u", request, { text: "sample" }), {
    cached: { name: "private-secret-name" },
  });
  assert.equal(ledger.balance("u").total, 299);
  const row = db.prepare("SELECT result FROM cloud_requests").get();
  assert.equal(row.result.includes(Buffer.from("private-secret-name")), false);
  assert.throws(
    () => ledger.reserve("u", request, { text: "changed" }),
    /REQUEST_ID_REUSED/,
  );
});
test("failure and interrupted process release reservation exactly once", () => {
  const { ledger, advance } = fixture();
  ledger.grant("pack", "u", "topup", 2, null);
  ledger.reserve("u", request, {});
  ledger.fail("u", request, "MODEL_FAILED");
  ledger.fail("u", request, "MODEL_FAILED");
  assert.equal(ledger.balance("u").total, 2);
  ledger.reserve("u", request, {});
  advance(180001);
  ledger.recover();
  assert.equal(ledger.balance("u").total, 2);
  assert.throws(
    () => ledger.complete("u", request, {}),
    /REQUEST_NO_LONGER_PENDING/,
  );
});
test("concurrent reservations cannot overspend final credit", () => {
  const { ledger } = fixture();
  ledger.grant("pack", "u", "topup", 1, null);
  ledger.reserve("u", request, {});
  assert.throws(
    () => ledger.reserve("u", "another_1234567890", {}),
    /NO_CREDITS/,
  );
  ledger.complete("u", request, {});
  assert.equal(ledger.balance("u").total, 0);
});
test("webhook transaction rollback and replay are atomic", () => {
  const { ledger } = fixture();
  assert.throws(() =>
    ledger.event("evt", "invoice.paid", () => {
      ledger.grant("invoice", "u", "monthly", 300, 200000);
      throw new Error("failed");
    }),
  );
  assert.equal(ledger.balance("u").total, 0);
  assert.equal(
    ledger.event("evt", "invoice.paid", () =>
      ledger.grant("invoice", "u", "monthly", 300, 200000),
    ),
    true,
  );
  assert.equal(
    ledger.event("evt", "invoice.paid", () =>
      ledger.grant("another", "u", "monthly", 300, 200000),
    ),
    false,
  );
  assert.equal(ledger.balance("u").total, 300);
});
test("refunded purchase revokes its own grant and cannot be completed", () => {
  const { ledger } = fixture();
  ledger.grant("a", "u", "topup", 300, null, "pi_1");
  ledger.grant("b", "u", "topup", 300, null, "pi_2");
  ledger.reserve("u", request, {});
  ledger.revoke(null, "pi_1");
  assert.throws(() => ledger.complete("u", request, {}), /CREDITS_REVOKED/);
  ledger.fail("u", request, "REFUNDED");
  assert.equal(ledger.balance("u").total, 300);
});
test("expired cache is removed; prior completed request cannot debit again", () => {
  const { ledger, db, advance } = fixture();
  ledger.grant("pack", "u", "topup", 300, null);
  ledger.reserve("u", request, {});
  ledger.complete("u", request, { result: 1 });
  advance(3600001);
  assert.throws(() => ledger.reserve("u", request, {}), /RESULT_EXPIRED/);
  assert.equal(ledger.balance("u").total, 299);
  assert.equal(
    db.prepare("SELECT result FROM cloud_requests").get().result,
    null,
  );
});
test("AEAD tampering fails; request IDs are user scoped", () => {
  const { ledger } = fixture();
  const encrypted = ledger.encrypt({ value: "x" });
  encrypted[15] ^= 1;
  assert.throws(() => ledger.decrypt(encrypted));
  ledger.grant("a", "u", "topup", 1, null);
  ledger.grant("b", "v", "topup", 1, null);
  ledger.reserve("u", request, {});
  ledger.reserve("v", request, {});
  assert.equal(ledger.balance("v").total, 0);
});
test("refund before grant cannot resurrect credits; period grants are unique", () => {
  const { ledger } = fixture();
  ledger.revoke("ch_future", "pi_future");
  ledger.grant("future", "u", "topup", 300, null, "pi_future");
  assert.equal(ledger.balance("u").total, 0);
  ledger.grant(
    "a",
    "u",
    "monthly",
    300,
    200000,
    "pi_a",
    null,
    "sub:100000",
    100000,
  );
  ledger.grant(
    "b",
    "u",
    "monthly",
    300,
    200000,
    "pi_b",
    null,
    "sub:100000",
    100000,
  );
  assert.equal(ledger.balance("u").total, 300);
});
test("stale process cannot finish or release a new retry reservation", () => {
  const { ledger, advance } = fixture();
  ledger.grant("pack", "u", "topup", 5, null);
  const first = ledger.reserve("u", request, {});
  advance(180001);
  ledger.recover();
  const second = ledger.reserve("u", request, {});
  ledger.fail("u", request, "OLD_PROCESS", first.attempt);
  assert.equal(ledger.balance("u").total, 4);
  assert.throws(
    () => ledger.complete("u", request, {}, first.attempt),
    /NO_LONGER_PENDING/,
  );
  ledger.complete("u", request, {}, second.attempt);
});

test("model selection needs a current paid monthly period, not top-ups or refunded grants", () => {
  const { ledger, advance } = fixture();
  ledger.grant("pack", "u", "topup", 300, null, "pi_pack");
  assert.equal(ledger.balance("u").canChooseModels, false);
  ledger.grant("unpaid", "u", "monthly", 300, 200000);
  assert.equal(ledger.balance("u").canChooseModels, false);
  ledger.grant("future", "u", "monthly", 300, 300000, "pi_future", null, null, 200000);
  assert.equal(ledger.balance("u").canChooseModels, false);
  ledger.grant("paid", "u", "monthly", 1, 150000, "pi_paid");
  ledger.reserve("u", request, {});
  ledger.complete("u", request, {});
  assert.equal(ledger.balance("u").canChooseModels, true);
  ledger.revoke(null, "pi_paid");
  assert.equal(ledger.balance("u").canChooseModels, false);
  advance(100000);
  assert.equal(ledger.balance("u").canChooseModels, true);
  advance(100000);
  assert.equal(ledger.balance("u").canChooseModels, false);
});

test("owner entitlement never spends paid credits or grows on failure; revoking it restores the paywall", () => {
  const { db, ledger, advance } = fixture();
  db.prepare("INSERT INTO cloud_preferences(user_id,unlimited,internal_usd_cents) VALUES(?,1,?)").run("u", 99999999900);
  assert.equal(ledger.balance("u").unlimited, true);
  assert.equal(ledger.balance("u").internalBalanceUsd, 999999999);
  assert.equal(ledger.balance("u").canChooseModels, true);
  ledger.reserve("u", request, {});
  ledger.complete("u", request, { ok: true });
  assert.deepEqual(ledger.reserve("u", request, {}), { cached: { ok: true } });
  ledger.reserve("u", "another_1234567890", {});
  ledger.fail("u", "another_1234567890", "MODEL_FAILED");
  ledger.reserve("u", "interrupted_12345", {});
  advance(180001);
  ledger.recover();
  assert.equal(db.prepare("SELECT remaining FROM cloud_grants WHERE id='owner:u'").get().remaining, 1);
  assert.equal(ledger.balance("u").topup, 0);
  ledger.grant("paid", "u", "topup", 1, null, "pi_paid");
  ledger.reserve("u", "unlimited_1234567", {});
  ledger.complete("u", "unlimited_1234567", {});
  assert.equal(ledger.balance("u").topup, 1);
  db.prepare("UPDATE cloud_preferences SET unlimited=0 WHERE user_id='u'").run();
  ledger.reserve("u", "paid_request_1234", {});
  ledger.complete("u", "paid_request_1234", {});
  assert.throws(() => ledger.reserve("u", "unpaid_request_1234", {}), /NO_CREDITS/);
  assert.equal(ledger.balance("u").total, 0);
  assert.equal(ledger.balance("u").canChooseModels, false);
});
