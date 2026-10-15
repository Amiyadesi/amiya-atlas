import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import { config, priceId } from "./config";
import { auth, db } from "./auth";
import { emailDomains } from "./email-policy";
import { Ledger, LedgerError } from "./ledger";
import { Billing, type Prices } from "./billing";
import { cloudModel } from "./model";
import {
  cloudInputSchema,
  assertNoSecrets,
  cloudSnapshot,
} from "../../src/ai/cloud-contract";
export const ledger = new Ledger(db, Buffer.from(config.CACHE_KEY, "hex"));
const stripe = config.STRIPE_SECRET_KEY
  ? new Stripe(config.STRIPE_SECRET_KEY, {
      maxNetworkRetries: 2,
      timeout: 20000,
    })
  : null;
const prices: Prices = {
  monthly: { cny: "", hkd: "", usd: "" },
  topup: { cny: "", hkd: "", usd: "" },
};
if (config.BILLING_ENABLED)
  for (const kind of ["monthly", "topup"] as const)
    for (const currency of ["cny", "hkd", "usd"] as const)
      prices[kind][currency] = priceId(kind, currency);
const billing = stripe
  ? new Billing(
      stripe,
      ledger,
      prices,
      config.PUBLIC_ORIGIN,
      config.STRIPE_PORTAL_CONFIGURATION,
    )
  : null;
const cloudModels = config.CLOUD_MODELS.length ? config.CLOUD_MODELS : [{ id: "default", name: "官网云模型", upstream: config.QWEN_MODEL }];
const modelProviders = new Map(cloudModels.map((model) => [model.id, config.QWEN_API_KEY
  ? cloudModel(config.QWEN_API_KEY, undefined, config.QWEN_BASE_URL, model.upstream)
  : null]));
function accountBalance(user: string) {
  const balance = ledger.balance(user);
  return { ...balance, selectedModel: balance.selectedModel ?? cloudModels[0].id, models: cloudModels.map(({ id, name }) => ({ id, name })) };
}
type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
export const app = new Hono<{ Variables: { user: Session["user"] } }>();
app.use(
  "*",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ message: "请求过大" }, 413),
  }),
);
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (c.req.path === "/health") return next();
  const supplied = Buffer.from(c.req.header("x-relakeep-proxy") ?? ""),
    expected = Buffer.from(config.PROXY_SECRET);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return c.json({ message: "Forbidden" }, 403);
  if (c.req.method !== "GET" && c.req.path !== "/api/stripe/webhook") {
    const origin = c.req.header("origin");
    if (origin && origin !== config.PUBLIC_ORIGIN)
      return c.json({ message: "来源无效" }, 403);
    if (!origin && c.req.header("sec-fetch-site") === "cross-site")
      return c.json({ message: "来源无效" }, 403);
  }
  await next();
});
app.get("/health", (c) => c.json({ ok: true, version: "0.4.1" }));
app.get("/api/features", (c) =>
  c.json({
    email: Boolean(config.RESEND_API_KEY),
    emailDomains,
    github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
    google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
    cloud: config.CLOUD_ENABLED,
    billing: config.BILLING_ENABLED,
    downloadUrl: config.DOWNLOAD_URL ?? null,
    version: "0.4.1",
  }),
);
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.post("/api/stripe/webhook", async (c) => {
  if (!stripe || !billing || !config.STRIPE_WEBHOOK_SECRET)
    return c.json({ message: "Webhook not configured" }, 503);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      await c.req.text(),
      c.req.header("stripe-signature") ?? "",
      config.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return c.json({ message: "Invalid signature" }, 400);
  }
  if (event.livemode !== /^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY!))
    return c.json({ message: "Wrong environment" }, 400);
  if (db.prepare("SELECT 1 FROM cloud_events WHERE id=?").get(event.id))
    return c.json({ received: true });
  const apply = await billing.prepare(event);
  ledger.event(event.id, event.type, apply);
  return c.json({ received: true });
});
app.use("/api/account/*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session)
    return c.json({ message: "请登录官网云账户", code: "UNAUTHORIZED" }, 401);
  c.set("user", session.user);
  await next();
});
app.get("/api/account/balance", (c) =>
  c.json(accountBalance(c.get("user").id)),
);
app.post("/api/account/model", async (c) => {
  const { model } = z.strictObject({ model: z.string().min(1).max(100) }).parse(await c.req.json());
  if (!modelProviders.has(model)) throw new LedgerError("MODEL_NOT_AVAILABLE", 400);
  const user = c.get("user").id, balance = ledger.balance(user);
  if (model !== cloudModels[0].id && !balance.canChooseModels) throw new LedgerError("SUBSCRIPTION_REQUIRED", 402);
  db.prepare("INSERT INTO cloud_preferences(user_id,model) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET model=excluded.model").run(user, model);
  return c.json(accountBalance(user));
});
app.get("/api/account/purchases", (c) =>
  c.json(
    db
      .prepare(
        "SELECT id,kind,original,remaining,starts_at,expires_at,revoked,created_at FROM cloud_grants WHERE user_id=? AND id NOT LIKE 'owner:%' ORDER BY created_at DESC LIMIT 50",
      )
      .all(c.get("user").id),
  ),
);
const checkoutSchema = z.strictObject({
  kind: z.enum(["monthly", "topup"]),
  currency: z.enum(["cny", "hkd", "usd"]),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/),
});
app.post("/api/account/checkout", async (c) => {
  if (!config.BILLING_ENABLED || !billing)
    throw new LedgerError("BILLING_NOT_AVAILABLE", 503);
  const input = checkoutSchema.parse(await c.req.json());
  return c.json(
    await billing.checkout(
      c.get("user"),
      input.kind,
      input.currency,
      input.requestId,
    ),
  );
});
app.post("/api/account/portal", async (c) => {
  if (!config.BILLING_ENABLED || !stripe || !billing)
    throw new LedgerError("BILLING_NOT_AVAILABLE", 503);
  return c.json(await billing.portal(c.get("user")));
});
app.post("/api/account/ai", async (c) => {
  if (!config.CLOUD_ENABLED || !config.QWEN_API_KEY)
    throw new LedgerError("CLOUD_NOT_AVAILABLE", 503);
  const input = cloudInputSchema.parse(await c.req.json());
  assertNoSecrets(input.text);
  cloudSnapshot(input);
  const user = c.get("user").id;
  const reservation = ledger.reserve(user, input.requestId, input);
  if ("cached" in reservation)
    return c.json({
      result: reservation.cached,
      balance: accountBalance(user),
    });
  try {
    const balance = accountBalance(user);
    if (balance.selectedModel !== cloudModels[0].id && !balance.canChooseModels)
      throw new LedgerError("SUBSCRIPTION_REQUIRED", 402);
    const model = modelProviders.get(balance.selectedModel);
    if (!model) throw new LedgerError("MODEL_NOT_AVAILABLE", 503);
    const result = await model(input);
    ledger.complete(user, input.requestId, result, reservation.attempt);
    return c.json({ result, balance: accountBalance(user) });
  } catch (error) {
    ledger.fail(user, input.requestId, "MODEL_FAILED", reservation.attempt);
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("MODEL_FAILED", 502);
  }
});
const messages: Record<string, string> = {
  NO_CREDITS: "云额度不足，请购买加量包或切回免费模型。",
  SUBSCRIPTION_REQUIRED: "选择云模型需要有效月订阅，请订阅或选择默认模型。",
  MODEL_NOT_AVAILABLE: "此模型暂不可用，请在官网账户页重新选择。",
  REQUEST_IN_PROGRESS: "同一请求仍在处理，请稍后用原请求重试。",
  REQUEST_ID_REUSED: "请求 ID 已用于不同内容。",
  RESULT_EXPIRED: "结果缓存已过期；这笔请求不会重复扣费，请查看本地收件箱。",
  AI_BUSY: "云模型正在处理其他请求，请稍后重试。",
  MODEL_FAILED: "模型结果未通过校验，已返还本次额度，请重试或补充描述。",
  CHECKOUT_EXPIRED: "结账已过期，请刷新余额后重新选择套餐。",
  CHECKOUT_ALREADY_COMPLETED:
    "这笔结账已完成，请刷新余额；再次购买请重新选择套餐。",
  SUBSCRIPTION_EXISTS: "已有有效订阅，请在账户页管理。",
  SUBSCRIPTION_CHECKOUT_PENDING:
    "已有待完成的订阅结账，请使用原结账链接或等 30 分钟后重试。",
  CHECKOUT_BUSY: "结账正在创建，请稍后重试。",
  BILLING_NOT_AVAILABLE: "收费入口尚未开放。",
  CLOUD_NOT_AVAILABLE: "官网云服务尚未开放。",
  PAYMENT_REVIEW_REQUIRED: "付款需要人工核验，请联系 me@sayori.org。",
};
app.onError((error, c) => {
  if (error instanceof LedgerError)
    return c.json(
      { code: error.code, message: messages[error.code] ?? error.code },
      error.status as 400,
    );
  if (error instanceof z.ZodError)
    return c.json({ message: "请求格式无效，请更新客户端。" }, 400);
  // Never log exceptions: upstream messages can contain submitted text, email or credentials.
  console.error(
    JSON.stringify({ event: "request_failed", path: c.req.path, status: 500 }),
  );
  return c.json({ message: "服务暂时不可用，请稍后重试。" }, 500);
});
const cleanup = setInterval(() => ledger.recover(), 60000);
cleanup.unref();
if (process.env.RELAKEEP_NO_LISTEN !== "true")
  serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" });
