import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";

const archive = process.argv[2];
if (!/^relakeep-cloud-\d{8}T\d{6}Z\.tar\.gz\.age$/.test(archive ?? ""))
  throw new Error("Pass the encrypted cloud backup filename");
const privateRoot = resolve("_private");
const work = join(
  privateRoot,
  "cloud",
  "restore-" + new Date().toISOString().replace(/[:.]/g, "-"),
);
mkdirSync(work, { recursive: true, mode: 0o700 });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    writeFileSync(join(work, "failure.log"), result.stderr ?? "", {
      mode: 0o600,
    });
    throw new Error(
      `${command} failed (${result.status}); diagnostics kept in the private restore directory`,
    );
  }
  return result.stdout.trim();
}
const local = join(work, archive);
run("scp", ["-q", "sayori:/opt/relakeep-backups/cloud/" + archive, local]);
const decrypted = join(work, "backup.tar.gz");
run(join(privateRoot, "retirement", "age", "age.exe"), [
  "-d",
  "-i",
  join(privateRoot, "retirement", "backup-identity.txt"),
  "-o",
  decrypted,
  local,
]);
const entries = run("tar", ["-tf", decrypted])
  .split(/\r?\n/)
  .map((name) => name.replace(/^\.\//, ""));
const files = ["manifest.json", "server.env.json", "relakeep.sqlite"];
const allowed = [...files, "relakeep.sqlite-shm", "relakeep.sqlite-wal"];
if (
  entries.some((name) => name !== "" && !allowed.includes(name)) ||
  files.some((name) => !entries.includes(name))
)
  throw new Error("Unexpected backup members; nothing extracted");
run("tar", ["-xzf", decrypted, "-C", work]);
const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
if (manifest.format !== "relakeep-cloud-backup" || manifest.version !== 1)
  throw new Error("Unsupported cloud backup format");
const env = JSON.parse(readFileSync(join(work, "server.env.json"), "utf8"));
for (const key of [
  "BETTER_AUTH_SECRET",
  "CACHE_KEY",
  "PROXY_SECRET",
  "PUBLIC_ORIGIN",
])
  if (typeof env[key] !== "string" || !env[key])
    throw new Error("Missing restore setting: " + key);
const db = new Database(join(work, "relakeep.sqlite"), { readonly: true });
if (db.pragma("integrity_check", { simple: true }) !== "ok")
  throw new Error("Cloud backup integrity failed");
const tables = db
  .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
  .get().n;
db.close();
// A restored copy must boot the actual backend and run its migrations without touching production.
run(process.execPath, [resolve("server/dist/app.js")], {
  env: { ...process.env, ...env, DATA_DIR: work, RELAKEEP_NO_LISTEN: "true" },
});
const report = {
  archive,
  authenticatedDecryption: true,
  sqliteIntegrity: "ok",
  tables,
  backendStartup: "passed",
  verifiedAt: new Date().toISOString(),
};
writeFileSync(
  join(work, "restore-report.json"),
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
