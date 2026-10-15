import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "relakeep-webhook-mode-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  RELAKEEP_NO_LISTEN: "true",
  PUBLIC_ORIGIN: "http://localhost:4190",
  DATA_DIR: directory,
  BETTER_AUTH_SECRET: "fixture-auth-secret-at-least-32-characters",
  CACHE_KEY: "77".repeat(32),
  PROXY_SECRET: "fixture-proxy-secret-at-least-32-characters",
  STRIPE_SECRET_KEY: "rk_live_fixture_only",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture_only",
  CLOUD_ENABLED: "false",
  BILLING_ENABLED: "false",
});
const { app, ledger } = await import("../dist/app.js");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
test("live restricted keys accept live signatures and reject sandbox events", async () => {
  for (const live of [false, true]) {
    const payload = JSON.stringify({ id: "evt_fixture_" + live, type: "fixture.ignored", livemode: live, data: { object: {} } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const response = await app.request("http://localhost:4190/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature, "x-relakeep-proxy": process.env.PROXY_SECRET },
      body: payload,
    });
    assert.equal(response.status, live ? 200 : 400);
  }
});
test.after(() => { ledger.db.close(); rmSync(directory, { recursive: true, force: true }); });
