import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, deviceAuthorization, emailOTP } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { join } from "node:path";
import { config } from "./config";
import { allowsEmail } from "./email-policy";
export const db = new Database(join(config.DATA_DIR, "relakeep.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const socialProviders = {
  ...(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
    ? {
        github: {
          clientId: config.GITHUB_CLIENT_ID,
          clientSecret: config.GITHUB_CLIENT_SECRET,
        },
      }
    : {}),
  ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          accessType: "online" as const,
          includeGrantedScopes: false,
        },
      }
    : {}),
};
export const auth = betterAuth({
  appName: "Relakeep",
  database: db,
  baseURL: config.PUBLIC_ORIGIN,
  basePath: "/api/auth",
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [config.PUBLIC_ORIGIN],
  socialProviders,
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith("/email-otp/") && ctx.path !== "/sign-in/email-otp") return;
      if (!config.RESEND_API_KEY)
        throw new APIError("SERVICE_UNAVAILABLE", { message: "邮箱登录暂未开通，请使用 GitHub 或 Google" });
      for (const key of ["email", "newEmail"])
        if (ctx.body?.[key] !== undefined && !allowsEmail(ctx.body[key]))
          throw new APIError("BAD_REQUEST", { message: "请使用 Gmail、Outlook、QQ、163 等支持的常见邮箱" });
    }),
  },
  account: {
    accountLinking: {
      enabled: true,
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
      disableImplicitLinking: true,
    },
  },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  advanced: {
    useSecureCookies: config.NODE_ENV === "production",
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip"],
      disableIpTracking: true,
    },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 50,
    customRules: {
      "/email-otp/send-verification-otp": { window: 60, max: 3 },
      "/device/code": { window: 60, max: 5 },
    },
  },
  logger: { disabled: true },
  plugins: [
    bearer(),
    deviceAuthorization({
      verificationUri: config.PUBLIC_ORIGIN + "/device",
      validateClient: (id) => id === "relakeep-desktop",
      expiresIn: "10m",
      interval: "5s",
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "hashed",
      async sendVerificationOTP({ email, otp }) {
        if (!config.RESEND_API_KEY)
          throw new Error("Email delivery unavailable");
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.RESEND_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "络笺 Relakeep <no-reply@atlas.sayori.org>",
            to: [email],
            subject: "Relakeep 登录验证码",
            text: `你的验证码：${otp}\n10 分钟内有效。请勿转发。如果不是你本人操作，请忽略。`,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error("Email delivery failed");
      },
    }),
  ],
});
await (await getMigrations(auth.options)).runMigrations();
