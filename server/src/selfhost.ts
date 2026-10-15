import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { bodyLimit } from "hono/body-limit";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { getMigrations } from "better-auth/db/migration";
import { APIError, createAuthMiddleware } from "better-auth/api";
import Database from "better-sqlite3";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const data = process.env.RELAKEEP_DATA_DIR ?? "/data";
const origin = process.env.RELAKEEP_ORIGIN ?? "http://localhost:5011";
const parsed = new URL(origin);
if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("RELAKEEP_ORIGIN 无效");
if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("远程地址需要 HTTPS");
const secret = process.env.BETTER_AUTH_SECRET;
const setupToken = process.env.RELAKEEP_SETUP_TOKEN;
if (!secret || secret.length < 32 || !setupToken || setupToken.length < 24) throw new Error("请先运行 init-selfhost.mjs 生成登录配置");
mkdirSync(data, { recursive: true });
const db = new Database(join(data, "auth.sqlite"));
db.pragma("journal_mode=WAL"); db.pragma("busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY CHECK(id=1), record_environment INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO preferences(id) VALUES(1); CREATE TABLE IF NOT EXISTS sync_object(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, etag TEXT NOT NULL, updated_at TEXT NOT NULL);");
const recordEnvironment = () => !!(db.prepare("SELECT record_environment FROM preferences WHERE id=1").get() as { record_environment: number }).record_environment;
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
let creatingOwner = false;
const webToken = randomBytes(32).toString("hex");
const passkeys = !isIP(parsed.hostname) && (parsed.protocol === "https:" || parsed.hostname === "localhost");
const authHeaders = (c: any) => { const headers = new Headers(c.req.raw.headers); const peer = process.env.RELAKEEP_TRUST_PROXY === "true" ? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() : getConnInfo(c).remote.address; headers.set("x-relakeep-ip", peer && isIP(peer) ? peer : ""); return headers; };
const auth = betterAuth({
  appName: "Relakeep", database: db, baseURL: origin, basePath: "/api/auth", secret,
  trustedOrigins: [origin], emailAndPassword: { enabled: true, minPasswordLength: 12 },
  hooks: { before: createAuthMiddleware(async ctx => {
    if (ctx.path === "/sign-up/email" && (!creatingOwner || !equal(ctx.headers?.get("x-relakeep-setup") ?? "", setupToken))) throw new APIError("FORBIDDEN", { message: "注册已关闭" });
  }) },
  databaseHooks: { session: {
    create: { before: async session => ({ data: { ...session, ...(recordEnvironment() ? {} : { ipAddress: null, userAgent: null }) } }) },
    update: { before: async session => ({ data: { ...session, ...(recordEnvironment() ? {} : { ipAddress: null, userAgent: null }) } }) },
  } },
  advanced: { useSecureCookies: parsed.protocol === "https:", ipAddress: { ipAddressHeaders: ["x-relakeep-ip"] } },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 86400 },
  rateLimit: { enabled: true, storage: "database", window: 60, max: 40,
    customRules: { "/sign-in/email": { window: 60, max: 5 }, "/two-factor/verify-totp": { window: 60, max: 5 } } },
  logger: { disabled: true },
  plugins: [bearer(), twoFactor({ issuer: "Relakeep" }),
    deviceAuthorization({ verificationUri: origin + "/?device=1", validateClient: id => id === "relakeep-sync", expiresIn: "10m", interval: "5s" }),
    ...(passkeys ? [passkey({ rpID: parsed.hostname, rpName: "Relakeep", origin })] : [])],
});
await (await getMigrations(auth.options)).runMigrations();
const ownerExists = () => !!db.prepare("SELECT id FROM user LIMIT 1").get();
const app = new Hono();
app.use("/api/*", bodyLimit({ maxSize: 128 * 1024 * 1024, onError: c => c.json({ message: "文件过大" }, 413) }));
app.use("/api/*", async (c, next) => {
  const requestOrigin = c.req.header("origin");
  if (requestOrigin && requestOrigin !== origin) return c.json({ message: "来源无效" }, 403);
  if (c.req.method !== "GET" && c.req.header("sec-fetch-site") === "cross-site") return c.json({ message: "来源无效" }, 403);
  c.header("Cache-Control", "no-store"); await next();
});
app.get("/api/setup", c => c.json({ required: !ownerExists(), passkeys }));
app.post("/api/setup", async c => {
  if (ownerExists() || creatingOwner) return c.json({ message: "已配置登录账户" }, 409);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.setupToken !== "string" || !equal(body.setupToken, setupToken)) return c.json({ message: "设置码无效" }, 403);
  if (typeof body.email !== "string" || typeof body.password !== "string" || body.password.length < 12 || body.password.length > 4096) return c.json({ message: "请输入邮箱和至少 12 位密码" }, 400);
  creatingOwner = true;
  try {
    return await auth.handler(new Request(origin + "/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", "Origin": origin, "x-relakeep-setup": setupToken }, body: JSON.stringify({ email: body.email, password: body.password, name: "Owner" }) }));
  } finally { creatingOwner = false; }
});
app.on(["GET", "POST"], "/api/auth/*", c => auth.handler(new Request(c.req.raw, { headers: authHeaders(c) })));
app.get("/health", c => c.json({ ok: true }));
app.use("/api/security/*", async (c, next) => {
  const session = await auth.api.getSession({ headers: authHeaders(c) });
  if (!session) return c.json({ message: "请先登录" }, 401);
  await next();
});
app.get("/api/security/environment", c => c.json({ enabled: recordEnvironment(), passkeys }));
app.post("/api/security/environment", async c => {
  const body = await c.req.json();
  if (typeof body.enabled !== "boolean") return c.json({ message: "设置无效" }, 400);
  db.transaction(() => { db.prepare("UPDATE preferences SET record_environment=? WHERE id=1").run(Number(body.enabled)); if (!body.enabled) db.prepare("UPDATE session SET ipAddress=NULL, userAgent=NULL").run(); })();
  return c.json({ enabled: body.enabled });
});
async function syncObject(c: any, internal = false) {
  if (internal) { if (!equal(c.req.header("authorization") ?? "", "Bearer " + webToken)) return c.json({ message: "Unauthorized" }, 401); }
  else if (!await auth.api.getSession({ headers: authHeaders(c) })) return c.json({ message: "请重新授权同步" }, 401);
  if (c.req.method === "GET") {
    const row = db.prepare("SELECT payload,etag FROM sync_object WHERE id=1").get() as { payload: string, etag: string } | undefined;
    if (!row) return c.body(null, 404);
    c.header("ETag", row.etag); c.header("Content-Type", "application/json"); return c.body(row.payload);
  }
  if (Number(c.req.header("content-length")) > 128 * 1024 * 1024) return c.json({ message: "文件过大" }, 413);
  const text = await c.req.text();
  if (Buffer.byteLength(text) > 128 * 1024 * 1024) return c.json({ message: "文件过大" }, 413);
  let value; try { value = JSON.parse(text); } catch { return c.json({ message: "备份格式无效" }, 400); }
  if (value.format !== "amiya-atlas-backup" || value.version !== 1 || typeof value.meta?.vaultId !== "string" || !Array.isArray(value.records) || !value.records.every((r: any) => typeof r.id === "string" && Array.isArray(r.nonce) && r.nonce.length === 24 && Array.isArray(r.ciphertext) && r.ciphertext.length >= 16 && [...r.nonce, ...r.ciphertext].every((n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 255))) return c.json({ message: "仅接受加密备份" }, 400);
  const etag = '"' + createHash("sha256").update(text).digest("hex") + '"';
  const written = db.transaction(() => {
    const old = db.prepare("SELECT etag FROM sync_object WHERE id=1").get() as { etag: string } | undefined;
    if (old ? c.req.header("if-match") !== old.etag : c.req.header("if-none-match") !== "*") return false;
    db.prepare("INSERT INTO sync_object VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,etag=excluded.etag,updated_at=excluded.updated_at").run(text, etag, new Date().toISOString()); return true;
  })();
  if (!written) return c.json({ message: "远端已更新" }, 412);
  c.header("ETag", etag); return c.body(null, 204);
}
app.on(["GET", "PUT"], "/api/sync", c => syncObject(c));
app.on(["GET", "PUT"], "/api/internal/sync", c => syncObject(c, true));
app.post("/api/invoke", async c => {
  if (!await auth.api.getSession({ headers: authHeaders(c) })) return c.json({ message: "请先登录" }, 401);
  const response = await fetch("http://127.0.0.1:5012/api/invoke", { method: "POST", headers: { "Host": "localhost:5012", "Authorization": "Bearer " + webToken, "Content-Type": "application/json" }, body: await c.req.text(), signal: AbortSignal.timeout(90000) });
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
});
app.use("*", async (c, next) => { c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"); c.header("Referrer-Policy", "no-referrer"); await next(); });
app.get("*", serveStatic({ root: process.env.RELAKEEP_STATIC_DIR ?? "./ui", rewriteRequestPath: path => path === "/" ? "/index.html" : path }));
const child = spawn(process.env.RELAKEEP_WEB_BIN ?? "/usr/local/bin/relakeep-web", [], { env: { ...process.env, RELAKEEP_BIND: "127.0.0.1:5012", RELAKEEP_ORIGIN: "http://localhost:5012", RELAKEEP_ACCESS_TOKEN: webToken, RELAKEEP_SELF_SYNC_URL: "http://127.0.0.1:5011/api/internal/sync" }, stdio: ["ignore", "ignore", "inherit"] });
child.on("error", error => { console.error("网页核心启动失败", error.message); process.exit(1); });
child.on("exit", () => process.exit(1));
process.on("SIGTERM", () => { child.kill(); process.exit(0); }); process.on("SIGINT", () => { child.kill(); process.exit(0); });
serve({ fetch: app.fetch, port: 5011, hostname: "0.0.0.0" });
console.log("Relakeep selfhost listening on :5011");
