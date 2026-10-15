import Stripe from "stripe";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { AMOUNTS } from "./billing";
if (!config.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY missing");
const stripe = new Stripe(config.STRIPE_SECRET_KEY);
const products = await stripe.products.list({ limit: 100 });
const result: Record<string, string> = {};
for (const kind of ["monthly", "topup"] as const) {
  let product = products.data.find(
    (p) =>
      p.metadata.product === "relakeep" && p.metadata.kind === kind && p.active,
  );
  product ??= await stripe.products.create(
    {
      name:
        kind === "monthly" ? "Relakeep 云 AI 月套餐" : "Relakeep 云 AI 加量包",
      description:
        kind === "monthly"
          ? "每个已付款月周期 300 次，不累积。"
          : "300 次，永久有效。",
      metadata: { product: "relakeep", kind },
    },
    { idempotencyKey: "relakeep-product-" + kind },
  );
  const prices = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  for (const currency of ["cny", "hkd", "usd"] as const) {
    let price = prices.data.find(
      (p) =>
        p.currency === currency &&
        p.unit_amount === AMOUNTS[currency] &&
        (kind === "monthly"
          ? p.recurring?.interval === "month" &&
            p.recurring.interval_count === 1
          : !p.recurring),
    );
    price ??= await stripe.prices.create(
      {
        product: product.id,
        currency,
        unit_amount: AMOUNTS[currency],
        ...(kind === "monthly" ? { recurring: { interval: "month" } } : {}),
        metadata: { product: "relakeep", kind, credits: "300" },
      },
      { idempotencyKey: "relakeep-price-" + kind + "-" + currency },
    );
    result[`PRICE_${kind.toUpperCase()}_${currency.toUpperCase()}`] = price.id;
  }
}
const portals = await stripe.billingPortal.configurations.list({ limit: 100 });
const portal =
  portals.data.find((p) => p.metadata?.product === "relakeep") ??
  (await stripe.billingPortal.configurations.create({
    metadata: { product: "relakeep" },
    business_profile: {
      headline: "管理 Relakeep 云 AI 订阅",
      privacy_policy_url: config.PUBLIC_ORIGIN + "/privacy",
      terms_of_service_url: config.PUBLIC_ORIGIN + "/refunds",
    },
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: false },
    },
  }));
result.STRIPE_PORTAL_CONFIGURATION = portal.id;
const hooks = await stripe.webhookEndpoints.list({ limit: 100 });
const url = config.PUBLIC_ORIGIN + "/api/stripe/webhook";
if (!hooks.data.some((h) => h.url === url && h.status === "enabled")) {
  const hook = await stripe.webhookEndpoints.create({
    url,
    api_version: "2026-09-30.endive",
    description: "Relakeep credit ledger",
    enabled_events: [
      "invoice.paid",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.expired",
      "refund.created",
      "refund.updated",
      "charge.refunded",
      "charge.dispute.created",
    ],
  });
  if (!hook.secret) throw new Error("Webhook secret missing");
  result.STRIPE_WEBHOOK_SECRET = hook.secret;
} else {
  if (!config.STRIPE_WEBHOOK_SECRET)
    throw new Error("Existing webhook needs its signing secret in server.env");
  result.STRIPE_WEBHOOK_SECRET = config.STRIPE_WEBHOOK_SECRET;
}
writeFileSync(
  join(config.DATA_DIR, "stripe-provision.env"),
  Object.entries(result)
    .map(([key, value]) => key + "=" + value)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    configured: true,
    prices: 6,
    environment: config.STRIPE_SECRET_KEY.includes("_live_")
      ? "live"
      : "sandbox",
    resultFile: "stripe-provision.env",
  }),
);
