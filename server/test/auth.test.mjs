import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = mkdtempSync(join(tmpdir(), "relakeep-auth-test-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  RELAKEEP_NO_LISTEN: "true",
  PUBLIC_ORIGIN: "http://localhost:4190",
  DATA_DIR: dir,
  BETTER_AUTH_SECRET: "test-only-auth-secret-at-least-32-characters",
  CACHE_KEY: "77".repeat(32),
  PROXY_SECRET: "test-proxy-secret-at-least-32-characters",
  RESEND_API_KEY: "test-only-key",
  GITHUB_CLIENT_ID: "test-github-client",
  GITHUB_CLIENT_SECRET: "test-github-secret",
  GOOGLE_CLIENT_ID: "test-google-client",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
});
let deliveredOtp;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) === "https://api.resend.com/emails") {
    deliveredOtp = JSON.parse(init.body).text.match(/\d{6}/)[0];
    return new Response("{}", { status: 200 });
  }
  throw new Error("Unexpected external network call");
};
const { app } = await import("../dist/app.js");
const headers = {
  "content-type": "application/json",
  origin: process.env.PUBLIC_ORIGIN,
  "x-relakeep-proxy": process.env.PROXY_SECRET,
};
function call(path, body, cookie) {
  return app.request("http://localhost:4190/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
test("OAuth requests use the configured callbacks and only login scopes", async () => {
  for (const [provider, origin, scopes] of [
    ["github", "https://github.com", ["read:user", "user:email"]],
    ["google", "https://accounts.google.com", ["email", "openid", "profile"]],
  ]) {
    const response = await call("/auth/sign-in/social", {
      provider,
      callbackURL: process.env.PUBLIC_ORIGIN + "/account",
    });
    assert.equal(response.status, 200);
    const url = new URL((await response.json()).url);
    assert.equal(url.origin, origin);
    assert.equal(
      url.searchParams.get("redirect_uri"),
      process.env.PUBLIC_ORIGIN + "/api/auth/callback/" + provider,
    );
    assert.deepEqual(url.searchParams.get("scope").split(" ").sort(), scopes);
    assert.ok(url.searchParams.get("state"));
    if (provider === "google") {
      assert.equal(url.searchParams.get("access_type"), "online");
      assert.equal(url.searchParams.has("include_granted_scopes"), false);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    }
  }
});
test("an incomplete OAuth credential pair stops startup without disclosing secrets", () => {
  for (const provider of ["GITHUB", "GOOGLE"]) {
    const result = spawnSync(process.execPath, ["dist/app.js"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, [`${provider}_CLIENT_SECRET`]: "" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes(
        `${provider} requires both CLIENT_ID and CLIENT_SECRET`,
      ),
    );
    assert.equal(
      result.stderr.includes(process.env[`${provider}_CLIENT_ID`]),
      false,
    );
  }
});
test("email OTP and first-party device flow complete without uploading a vault", async () => {
  const sent = await call("/auth/email-otp/send-verification-otp", {
    email: "test@gmail.com",
    type: "sign-in",
  });
  assert.equal(sent.status, 200);
  assert.ok(deliveredOtp);
  const login = await call("/auth/sign-in/email-otp", {
    email: "test@gmail.com",
    otp: deliveredOtp,
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  const bad = await call("/auth/device/code", {
    client_id: "untrusted-client",
  });
  assert.equal(bad.status, 400);
  const start = await call("/auth/device/code", {
    client_id: "relakeep-desktop",
  });
  assert.equal(start.status, 200);
  const device = await start.json();
  const verify = await call(
    "/auth/device?user_code=" + encodeURIComponent(device.user_code),
    undefined,
    cookie,
  );
  assert.equal(verify.status, 200);
  const approve = await call(
    "/auth/device/approve",
    { userCode: device.user_code },
    cookie,
  );
  assert.equal(approve.status, 200);
  const token = await call("/auth/device/token", {
    client_id: "relakeep-desktop",
    device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  assert.equal(token.status, 200);
  const value = await token.json();
  assert.ok(value.access_token);
  const balance = await app.request(
    "http://localhost:4190/api/account/balance",
    { headers: { ...headers, authorization: "Bearer " + value.access_token } },
  );
  assert.equal(balance.status, 200);
  assert.equal((await balance.json()).total, 0);
  const replay = await call("/auth/device/token", {
    client_id: "relakeep-desktop",
    device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  assert.notEqual(replay.status, 200);
});
test("missing proxy, bad origin, unsigned webhook and anonymous balance fail", async () => {
  assert.equal((await app.request("/api/features")).status, 403);
  assert.equal(
    (
      await app.request("/api/account/checkout", {
        method: "POST",
        headers: { ...headers, origin: "https://evil.invalid" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal((await call("/account/balance")).status, 401);
  assert.equal((await call("/stripe/webhook", {})).status, 503);
});
process.on("exit", () => {
  globalThis.fetch = originalFetch;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});
