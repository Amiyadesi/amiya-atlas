import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Ledger } from "../dist/ledger.js";
import { Billing } from "../dist/billing.js";
const prices = {
  monthly: { cny: "price_mc", hkd: "price_mh", usd: "price_mu" },
  topup: { cny: "price_tc", hkd: "price_th", usd: "price_tu" },
};
function fixture(stripe) {
  let now = 100000;
  const db = new Database(":memory:");
  const ledger = new Ledger(db, Buffer.alloc(32), () => now);
  db.prepare("INSERT INTO cloud_customers VALUES(?,?,0)").run("u", "cus_u");
  return {
    db,
    ledger,
    advance: (ms) => {
      now += ms;
    },
    billing: new Billing(
      stripe,
      ledger,
      prices,
      "https://atlas.sayori.org",
      "bpc_relakeep",
    ),
  };
}
const event = (type, id) => ({
  id: "evt_" + Math.random(),
  type,
  data: { object: { id } },
});
test("top-up checks payment status, price and ownership; replay never grants twice", async () => {
  const session = {
    id: "cs_paid",
    customer: "cus_u",
    client_reference_id: "u",
    metadata: { product: "relakeep", userId: "u", operation: "u:request" },
    mode: "payment",
    payment_status: "unpaid",
    status: "complete",
    currency: "cny",
    amount_total: 2000,
    payment_intent: "pi_x",
    line_items: { data: [{ price: "price_tc", quantity: 1 }] },
  };
  const { ledger, billing } = fixture({
    checkout: { sessions: { retrieve: async () => session } },
  });
  (await billing.prepare(event("checkout.session.completed", session.id)))();
  assert.equal(ledger.balance("u").total, 0);
  session.payment_status = "paid";
  const apply = await billing.prepare(
    event("checkout.session.async_payment_succeeded", session.id),
  );
  apply();
  apply();
  assert.equal(ledger.balance("u").total, 300);
  session.amount_total = 1;
  await assert.rejects(
    billing.prepare(event("checkout.session.completed", session.id)),
    /PRICE_MISMATCH/,
  );
});
test("paid recurring invoice grants once per period; proration does not add a cycle", async () => {
  const invoice = {
    id: "in_a",
    customer: "cus_u",
    parent: { subscription_details: { subscription: "sub_1" } },
    billing_reason: "subscription_cycle",
    status: "paid",
    currency: "usd",
    amount_paid: 299,
    payments: {
      data: [{ status: "paid", payment: { payment_intent: "pi_i" } }],
    },
  };
  const sub = {
    id: "sub_1",
    metadata: { product: "relakeep", userId: "u" },
    customer: "cus_u",
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ current_period_end: 200000 }] },
  };
  const line = {
    pricing: { price_details: { price: "price_mu" } },
    quantity: 1,
    amount: 299,
    period: { start: 0, end: 200000 },
    parent: { subscription_item_details: { proration: false } },
  };
  const { ledger, billing } = fixture({
    invoices: {
      retrieve: async () => invoice,
      listLineItems: async () => ({ data: [line] }),
    },
    subscriptions: { retrieve: async () => sub },
  });
  (await billing.prepare(event("invoice.paid", "in_a")))();
  invoice.id = "in_b";
  (await billing.prepare(event("invoice.paid", "in_b")))();
  assert.equal(ledger.balance("u").total, 300);
  invoice.billing_reason = "subscription_update";
  (await billing.prepare(event("invoice.paid", "in_b")))();
  assert.equal(ledger.balance("u").total, 300);
});
test("out-of-order subscription event uses current cancellation state", async () => {
  const sub = {
    id: "sub_1",
    metadata: { product: "relakeep", userId: "u" },
    customer: "cus_u",
    status: "active",
    cancel_at_period_end: true,
    items: { data: [{ current_period_end: 200000 }] },
  };
  const { ledger, billing } = fixture({
    subscriptions: { retrieve: async () => sub },
  });
  (await billing.prepare(event("customer.subscription.updated", "sub_1")))();
  (await billing.prepare(event("customer.subscription.created", "sub_1")))();
  assert.equal(ledger.balance("u").subscription.cancels, 1);
});
test("concurrent subscription checkout locks; active subscription is refused", async () => {
  let unlock;
  const subscriptions = {
    list: () =>
      new Promise((resolve) => {
        unlock = resolve;
      }),
  };
  const { billing } = fixture({
    subscriptions,
    checkout: {
      sessions: {
        create: async () => ({
          id: "cs",
          url: "https://checkout.stripe.com/demo",
        }),
      },
    },
  });
  const first = billing.checkout(
    { id: "u", email: "demo@example.invalid" },
    "monthly",
    "cny",
    "request_1234567890",
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    billing.checkout(
      { id: "u", email: "demo@example.invalid" },
      "monthly",
      "usd",
      "request_0987654321",
    ),
    /CHECKOUT_BUSY/,
  );
  unlock({ data: [{ status: "active" }] });
  await assert.rejects(first, /SUBSCRIPTION_EXISTS/);
});

test("checkout timeout retries keep exactly the same Stripe payload and key", async () => {
  const calls = [];
  const { billing, advance } = fixture({
    checkout: {
      sessions: {
        create: async (body, options) => {
          calls.push({ body, options });
          if (calls.length === 1) throw Error("network timeout");
          return { id: "cs_retry", url: "https://checkout.stripe.com/retry" };
        },
      },
    },
  });
  const user = { id: "u", email: "demo@example.invalid" };
  await assert.rejects(
    billing.checkout(user, "topup", "usd", "request_1234567890"),
    /network timeout/,
  );
  advance(10000);
  await billing.checkout(user, "topup", "usd", "request_1234567890");
  assert.deepEqual(calls[0], calls[1]);
});

test("expired and completed hosted checkouts never reopen a stale payment link", async () => {
  let status = "open";
  const { billing } = fixture({
    checkout: {
      sessions: {
        create: async () => ({
          id: "cs_stale",
          url: "https://checkout.stripe.com/stale",
        }),
        retrieve: async () => ({ id: "cs_stale", status }),
      },
    },
  });
  const user = { id: "u", email: "demo@example.invalid" };
  await billing.checkout(user, "topup", "usd", "request_1234567890");
  status = "expired";
  await assert.rejects(
    billing.checkout(user, "topup", "usd", "request_1234567890"),
    /CHECKOUT_EXPIRED/,
  );
  await billing.checkout(user, "topup", "usd", "another_1234567890");
  status = "complete";
  await assert.rejects(
    billing.checkout(user, "topup", "usd", "another_1234567890"),
    /CHECKOUT_ALREADY_COMPLETED/,
  );
});

test("billing portal always uses this product configuration", async () => {
  let received;
  const { billing } = fixture({
    billingPortal: {
      sessions: {
        create: async (body) => {
          received = body;
          return { url: "https://billing.stripe.com/demo" };
        },
      },
    },
  });
  await billing.portal({ id: "u", email: "demo@example.invalid" });
  assert.equal(received.configuration, "bpc_relakeep");
});
