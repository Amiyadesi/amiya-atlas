import { z } from "zod";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((x) => x === "true");
const env = z
  .object({
    NODE_ENV: z
      .enum(["production", "development", "test"])
      .default("production"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4190),
    PUBLIC_ORIGIN: z.string().url().default("https://atlas.sayori.org"),
    DATA_DIR: z.string().default("/data"),
    BETTER_AUTH_SECRET: z.string().min(32),
    CACHE_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    PROXY_SECRET: z.string().min(32),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PORTAL_CONFIGURATION: z.string().startsWith("bpc_").optional(),
    BILLING_ENABLED: flag,
    CLOUD_ENABLED: flag,
    PRICE_MONTHLY_CNY: z.string().optional(),
    PRICE_MONTHLY_HKD: z.string().optional(),
    PRICE_MONTHLY_USD: z.string().optional(),
    PRICE_TOPUP_CNY: z.string().optional(),
    PRICE_TOPUP_HKD: z.string().optional(),
    PRICE_TOPUP_USD: z.string().optional(),
    QWEN_API_KEY: z.string().optional(),
    QWEN_BASE_URL: z.string().url().default("https://dashscope-intl.ap-southeast-1.aliyuncs.com/compatible-mode/v1"),
    QWEN_MODEL: z.string().trim().min(1).max(200).default("qwen3.7-flash-2026-07-15"),
    CLOUD_MODELS: z.string().default("[]").transform((value) => JSON.parse(value)).pipe(z.array(z.strictObject({
      id: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
      name: z.string().trim().min(1).max(100),
      upstream: z.string().trim().min(1).max(200),
    })).max(10)),
    DOWNLOAD_URL: z.string().url().optional(),
  })
  .parse(process.env);
if (new Set(env.CLOUD_MODELS.map((model) => model.id)).size !== env.CLOUD_MODELS.length)
  throw new Error("CLOUD_MODELS IDs must be unique");
for (const provider of ["GITHUB", "GOOGLE"] as const) {
  if (
    Boolean(env[`${provider}_CLIENT_ID`]) !==
    Boolean(env[`${provider}_CLIENT_SECRET`])
  )
    throw new Error(`${provider} requires both CLIENT_ID and CLIENT_SECRET`);
}
if (env.NODE_ENV === "production" && !env.PUBLIC_ORIGIN.startsWith("https://"))
  throw new Error("PUBLIC_ORIGIN requires HTTPS");
if (env.CLOUD_ENABLED && !env.QWEN_API_KEY)
  throw new Error("QWEN_API_KEY missing");
if (
  env.BILLING_ENABLED &&
  (!env.STRIPE_SECRET_KEY ||
    !env.STRIPE_WEBHOOK_SECRET ||
    !env.STRIPE_PORTAL_CONFIGURATION ||
    !env.CLOUD_ENABLED)
)
  throw new Error(
    "Billing needs Stripe, verified cloud model, webhook and portal configuration",
  );
export const config = { ...env, DATA_DIR: resolve(env.DATA_DIR) };
mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
export const currencyPrices = { cny: 2000, hkd: 2350, usd: 299 } as const;
export type Currency = keyof typeof currencyPrices;
export function priceId(kind: "monthly" | "topup", currency: Currency) {
  const key =
    `PRICE_${kind.toUpperCase()}_${currency.toUpperCase()}` as keyof typeof config;
  const value = config[key];
  if (typeof value !== "string" || !value.startsWith("price_"))
    throw new Error("Stripe price missing: " + key);
  return value;
}
