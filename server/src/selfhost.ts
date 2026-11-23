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
import { verifySyncTicket } from "./sync-identity";

const data = process.env.RELAKEEP_DATA_DIR ?? "/data";
const port = Number(process.env.RELAKEEP_PORT ?? "5011"),
  corePort = Number(process.env.RELAKEEP_CORE_PORT ?? "5012");
if (
  ![port, corePort].every(
    (n) => Number.isSafeInteger(n) && n > 0 && n <= 65535,
  ) ||
  port === corePort
)
  throw new Error("网页端口配置无效");
const coreOrigin = `http://localhost:${corePort}`;
const origin = process.env.RELAKEEP_ORIGIN ?? "http://localhost:5011";
const parsed = new URL(origin);
if (
  !["http:", "https:"].includes(parsed.protocol) ||
  parsed.pathname !== "/" ||
  parsed.search ||
  parsed.hash ||
  parsed.username ||
  parsed.password
)
  throw new Error("RELAKEEP_ORIGIN 无效");
if (
  parsed.protocol === "http:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
)
  throw new Error("远程地址需要 HTTPS");
const secret = process.env.BETTER_AUTH_SECRET;
const setupToken = process.env.RELAKEEP_SETUP_TOKEN;
if (!secret || secret.length < 32 || !setupToken || setupToken.length < 24)
  throw new Error("请先运行 init-selfhost.mjs 生成登录配置");
mkdirSync(data, { recursive: true });
const db = new Database(join(data, "auth.sqlite"));
db.pragma("journal_mode=WAL");
db.pragma("busy_timeout=5000");
db.exec(
  "CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY CHECK(id=1), record_environment INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO preferences(id) VALUES(1); CREATE TABLE IF NOT EXISTS sync_object(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, etag TEXT NOT NULL, updated_at TEXT NOT NULL);",
);
db.exec(
  "CREATE TABLE IF NOT EXISTS sync_key(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,last_used TEXT,expires_at INTEGER); CREATE TABLE IF NOT EXISTS cloud_binding(id INTEGER PRIMARY KEY CHECK(id=1),server_id TEXT NOT NULL,user_id TEXT NOT NULL,public_key TEXT NOT NULL); CREATE TABLE IF NOT EXISTS used_ticket(nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sync_history(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);",
);
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
function createSyncKey(name: string, expiresAt: number | null = null) {
  const token = "rks_" + randomBytes(32).toString("base64url"),
    id = randomBytes(16).toString("hex");
  db.prepare(
    "INSERT INTO sync_key(id,name,hash,created_at,expires_at) VALUES(?,?,?,?,?)",
  ).run(id, name, hashKey(token), new Date().toISOString(), expiresAt);
  return { id, token, url: origin + "/api/sync" };
}
const recordEnvironment = () =>
  !!(
    db
      .prepare("SELECT record_environment FROM preferences WHERE id=1")
      .get() as { record_environment: number }
  ).record_environment;
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
let creatingOwner = false;
const webToken = randomBytes(32).toString("hex");
const passkeys =
  !isIP(parsed.hostname) &&
  (parsed.protocol === "https:" || parsed.hostname === "localhost");
const authHeaders = (c: any) => {
  const headers = new Headers(c.req.raw.headers);
  const peer =
    process.env.RELAKEEP_TRUST_PROXY === "true"
      ? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim()
      : getConnInfo(c).remote.address;
  headers.set("x-relakeep-ip", peer && isIP(peer) ? peer : "");
  return headers;
};
const auth = betterAuth({
  appName: "Relakeep",
  database: db,
  baseURL: origin,
  basePath: "/api/auth",
  secret,
  trustedOrigins: [origin],
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (
        ctx.path === "/sign-up/email" &&
        (!creatingOwner ||
          !equal(ctx.headers?.get("x-relakeep-setup") ?? "", setupToken))
      )
        throw new APIError("FORBIDDEN", { message: "注册已关闭" });
    }),
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => ({
          data: {
            ...session,
            ...(recordEnvironment()
              ? {}
              : { ipAddress: null, userAgent: null }),
          },
        }),
      },
      update: {
        before: async (session) => ({
          data: {
            ...session,
            ...(recordEnvironment()
              ? {}
              : { ipAddress: null, userAgent: null }),
          },
        }),
      },
    },
  },
  advanced: {
    useSecureCookies: parsed.protocol === "https:",
    ipAddress: { ipAddressHeaders: ["x-relakeep-ip"] },
  },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 86400 },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 40,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 5 },
    },
  },
  logger: { disabled: true },
  plugins: [
    bearer(),
    twoFactor({ issuer: "Relakeep" }),
    deviceAuthorization({
      verificationUri: origin + "/?device=1",
      validateClient: (id) => id === "relakeep-sync",
      expiresIn: "10m",
      interval: "5s",
    }),
    ...(passkeys
      ? [passkey({ rpID: parsed.hostname, rpName: "Relakeep", origin })]
      : []),
  ],
});
await (await getMigrations(auth.options)).runMigrations();
const ownerExists = () => !!db.prepare("SELECT id FROM user LIMIT 1").get();
const app = new Hono();
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 128 * 1024 * 1024,
    onError: (c) => c.json({ message: "文件过大" }, 413),
  }),
);
app.use("/api/*", async (c, next) => {
  const requestOrigin = c.req.header("origin");
  if (requestOrigin && requestOrigin !== origin)
    return c.json({ message: "来源无效" }, 403);
  if (c.req.method !== "GET" && c.req.header("sec-fetch-site") === "cross-site")
    return c.json({ message: "来源无效" }, 403);
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/api/setup", (c) => c.json({ required: !ownerExists(), passkeys }));
app.post("/api/setup", async (c) => {
  if (ownerExists() || creatingOwner)
    return c.json({ message: "已配置登录账户" }, 409);
  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.setupToken !== "string" ||
    !equal(body.setupToken, setupToken)
  )
    return c.json({ message: "设置码无效" }, 403);
  if (
    typeof body.email !== "string" ||
    typeof body.password !== "string" ||
    body.password.length < 12 ||
    body.password.length > 4096
  )
    return c.json({ message: "请输入邮箱和至少 12 位密码" }, 400);
  creatingOwner = true;
  try {
    return await auth.handler(
      new Request(origin + "/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "x-relakeep-setup": setupToken,
        },
        body: JSON.stringify({
          email: body.email,
          password: body.password,
          name: "Owner",
        }),
      }),
    );
  } finally {
    creatingOwner = false;
  }
});
app.on(["GET", "POST"], "/api/auth/*", (c) =>
  auth.handler(new Request(c.req.raw, { headers: authHeaders(c) })),
);
app.get("/health", (c) => c.json({ ok: true }));
app.use("/api/security/*", async (c, next) => {
  const session = await auth.api.getSession({ headers: authHeaders(c) });
  if (!session) return c.json({ message: "请先登录" }, 401);
  await next();
});
app.get("/api/security/environment", (c) =>
  c.json({ enabled: recordEnvironment(), passkeys }),
);
app.post("/api/security/environment", async (c) => {
  const body = await c.req.json();
  if (typeof body.enabled !== "boolean")
    return c.json({ message: "设置无效" }, 400);
  db.transaction(() => {
    db.prepare("UPDATE preferences SET record_environment=? WHERE id=1").run(
      Number(body.enabled),
    );
    if (!body.enabled)
      db.prepare("UPDATE session SET ipAddress=NULL, userAgent=NULL").run();
  })();
  return c.json({ enabled: body.enabled });
});
async function core(command: string, args: unknown = {}) {
  const response = await fetch(coreOrigin + "/api/invoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + webToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(150000),
  });
  if (!response.ok) throw new Error("记忆库服务连接失败");
  return (await response.json()) as { ok: boolean; data?: any; error?: string };
}
app.get("/api/security/sync-keys", (c) =>
  c.json({
    keys: db
      .prepare(
        "SELECT id,name,created_at AS createdAt,last_used AS lastUsed,expires_at AS expiresAt FROM sync_key ORDER BY created_at DESC",
      )
      .all(),
    linked: !!db.prepare("SELECT id FROM cloud_binding WHERE id=1").get(),
  }),
);
app.post("/api/security/sync-keys", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 80
  )
    return c.json({ message: "填写设备名称" }, 400);
  return c.json(createSyncKey(body.name.trim()));
});
app.post("/api/security/sync-keys/revoke", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.id !== "string")
    return c.json({ message: "选择需要撤销的密钥" }, 400);
  db.prepare("DELETE FROM sync_key WHERE id=?").run(body.id);
  return c.json({ ok: true });
});
app.post("/api/security/cloud-link", async (c) => {
  const result = await core("cloud_request", {
    path: "/api/account/servers",
    body: { url: origin, name: parsed.hostname },
  });
  if (!result.ok) return c.json({ message: result.error }, 400);
  const value = result.data;
  if (
    value.url !== origin ||
    typeof value.serverId !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.publicKey !== "string"
  )
    return c.json({ message: "官网返回的服务器身份无效" }, 502);
  db.transaction(() => {
    const old = db
      .prepare("SELECT user_id FROM cloud_binding WHERE id=1")
      .get() as { user_id: string } | undefined;
    if (old && old.user_id !== value.userId)
      db.prepare("DELETE FROM sync_key WHERE expires_at IS NOT NULL").run();
    db.prepare(
      "INSERT INTO cloud_binding VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET server_id=excluded.server_id,user_id=excluded.user_id,public_key=excluded.public_key",
    ).run(value.serverId, value.userId, value.publicKey);
  })();
  return c.json({ linked: true });
});
app.post("/api/security/cloud-unlink", async (c) => {
  const binding = db
    .prepare("SELECT server_id FROM cloud_binding WHERE id=1")
    .get() as { server_id: string } | undefined;
  if (binding) {
    const result = await core("cloud_request", {
      path: "/api/account/servers/remove",
      body: { id: binding.server_id },
    });
    if (!result.ok) return c.json({ message: result.error }, 400);
  }
  db.prepare("DELETE FROM cloud_binding").run();
  db.prepare("DELETE FROM sync_key WHERE expires_at IS NOT NULL").run();
  return c.json({ linked: false });
});
app.post("/api/sync/connect", async (c) => {
  const binding = db
    .prepare(
      "SELECT server_id,user_id,public_key FROM cloud_binding WHERE id=1",
    )
    .get() as
    { server_id: string; user_id: string; public_key: string } | undefined;
  if (!binding) return c.json({ message: "服务器尚未关联官网账户" }, 403);
  const body = await c.req.json().catch(() => null);
  try {
    const ticket = verifySyncTicket(body?.ticket, binding.public_key, {
      url: origin,
      serverId: binding.server_id,
      userId: binding.user_id,
    });
    const result = db.transaction(() => {
      db.prepare("DELETE FROM used_ticket WHERE expires_at<?").run(Date.now());
      if (
        db
          .prepare("SELECT nonce FROM used_ticket WHERE nonce=?")
          .get(ticket.nonce)
      )
        throw new Error("连接授权已使用，请重试");
      db.prepare("INSERT INTO used_ticket VALUES(?,?)").run(
        ticket.nonce,
        ticket.exp,
      );
      return createSyncKey(
        typeof body.name === "string"
          ? body.name.slice(0, 80) || "官网账户设备"
          : "官网账户设备",
        Date.now() + 30 * 86400000,
      );
    })();
    return c.json(result);
  } catch {
    return c.json({ message: "连接授权已失效，请重新连接" }, 403);
  }
});
async function syncObject(c: any, internal = false) {
  if (internal) {
    if (!equal(c.req.header("authorization") ?? "", "Bearer " + webToken))
      return c.json({ message: "Unauthorized" }, 401);
  } else if (!(await auth.api.getSession({ headers: authHeaders(c) }))) {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const key = token.startsWith("rks_")
      ? (db
          .prepare(
            "SELECT id FROM sync_key WHERE hash=? AND (expires_at IS NULL OR expires_at>?)",
          )
          .get(hashKey(token), Date.now()) as { id: string } | undefined)
      : undefined;
    if (!key) return c.json({ message: "请重新授权同步" }, 401);
    db.prepare("UPDATE sync_key SET last_used=? WHERE id=?").run(
      new Date().toISOString(),
      key.id,
    );
  }
  if (c.req.method === "GET") {
    const row = db
      .prepare("SELECT payload,etag FROM sync_object WHERE id=1")
      .get() as { payload: string; etag: string } | undefined;
    if (!row) return c.body(null, 404);
    c.header("ETag", row.etag);
    c.header("Content-Type", "application/json");
    return c.body(row.payload);
  }
  if (Number(c.req.header("content-length")) > 128 * 1024 * 1024)
    return c.json({ message: "文件过大" }, 413);
  const text = await c.req.text();
  if (Buffer.byteLength(text) > 128 * 1024 * 1024)
    return c.json({ message: "文件过大" }, 413);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return c.json({ message: "备份格式无效" }, 400);
  }
  if (
    value.format !== "amiya-atlas-backup" ||
    value.version !== 1 ||
    typeof value.meta?.vaultId !== "string" ||
    !Array.isArray(value.records) ||
    !value.records.every(
      (r: any) =>
        typeof r.id === "string" &&
        Array.isArray(r.nonce) &&
        r.nonce.length === 24 &&
        Array.isArray(r.ciphertext) &&
        r.ciphertext.length >= 16 &&
        [...r.nonce, ...r.ciphertext].every(
          (n: unknown) =>
            Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 255,
        ),
    )
  )
    return c.json({ message: "仅接受加密备份" }, 400);
  const etag = '"' + createHash("sha256").update(text).digest("hex") + '"';
  const written = db.transaction(() => {
    const old = db.prepare("SELECT etag FROM sync_object WHERE id=1").get() as
      { etag: string } | undefined;
    if (
      old
        ? c.req.header("if-match") !== old.etag
        : c.req.header("if-none-match") !== "*"
    )
      return false;
    db.prepare(
      "INSERT INTO sync_object VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,etag=excluded.etag,updated_at=excluded.updated_at",
    ).run(text, etag, new Date().toISOString());
    return true;
  })();
  if (!written) return c.json({ message: "远端已更新" }, 412);
  c.header("ETag", etag);
  return c.body(null, 204);
}
app.on(["GET", "PUT"], "/api/sync", (c) => syncObject(c));
app.on(["GET", "PUT"], "/api/internal/sync", (c) => syncObject(c, true));
app.post("/api/invoke", async (c) => {
  if (!(await auth.api.getSession({ headers: authHeaders(c) })))
    return c.json({ message: "请先登录" }, 401);
  const input = await c.req.json();
  const result = await core(input.command, input.args);
  if (input.command === "import_backup" && result.ok) {
    try {
      const backup = await core("export_sync_backup");
      if (backup.ok && typeof backup.data === "string") {
        const payload = backup.data;
        db.transaction(() => {
          const old = db
            .prepare("SELECT payload FROM sync_object WHERE id=1")
            .get() as { payload: string } | undefined;
          if (old)
            db.prepare(
              "INSERT INTO sync_history(payload,created_at) VALUES(?,?)",
            ).run(old.payload, new Date().toISOString());
          db.prepare(
            "DELETE FROM sync_history WHERE id NOT IN (SELECT id FROM sync_history ORDER BY id DESC LIMIT 5)",
          ).run();
          db.prepare(
            "INSERT INTO sync_object VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,etag=excluded.etag,updated_at=excluded.updated_at",
          ).run(
            payload,
            '"' + hashKey(payload) + '"',
            new Date().toISOString(),
          );
        })();
      } else throw new Error("sync export failed");
    } catch {
      result.data.restoreWarning =
        "已导入；服务器同步副本未更新，请重新导入备份以重试";
    }
  }
  return c.json(result);
});
app.use("*", async (c, next) => {
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.coinbase.com https://atlas.sayori.org/downloads/releases.json https://api.github.com/repos/Amiyadesi/amiya-atlas/releases/latest https://api.github.com/repos/Amiyadesi/amiya-atlas/releases; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
app.get(
  "*",
  serveStatic({
    root: process.env.RELAKEEP_STATIC_DIR ?? "./ui",
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);
const child = spawn(
  process.env.RELAKEEP_WEB_BIN ?? "/usr/local/bin/relakeep-web",
  [],
  {
    env: {
      ...process.env,
      RELAKEEP_BIND: `127.0.0.1:${corePort}`,
      RELAKEEP_ORIGIN: coreOrigin,
      RELAKEEP_ACCESS_TOKEN: webToken,
      RELAKEEP_SELF_SYNC_URL: `http://127.0.0.1:${port}/api/internal/sync`,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
child.on("error", (error) => {
  console.error("网页核心启动失败", error.message);
  process.exit(1);
});
child.on("exit", () => process.exit(1));
process.on("SIGTERM", () => {
  child.kill();
  process.exit(0);
});
process.on("SIGINT", () => {
  child.kill();
  process.exit(0);
});
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(`Relakeep selfhost listening on :${port}`);
