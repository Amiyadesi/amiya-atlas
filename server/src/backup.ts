import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config";
const recipient = process.env.BACKUP_RECIPIENT;
if (!recipient?.startsWith("age1"))
  throw new Error("BACKUP_RECIPIENT required");
const destination = process.env.BACKUP_FILE;
if (!destination) throw new Error("BACKUP_FILE required");
const work = mkdtempSync(join(tmpdir(), "relakeep-backup-"));
try {
  const db = new Database(join(config.DATA_DIR, "relakeep.sqlite"), {
    readonly: true,
  });
  await db.backup(join(work, "relakeep.sqlite"));
  db.close();
  const check = new Database(join(work, "relakeep.sqlite"));
  check.pragma("journal_mode = DELETE");
  if (check.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("Backup integrity check failed");
  check.close();
  writeFileSync(
    join(work, "server.env.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(config)
          .filter(([key, value]) => key !== "DATA_DIR" && value !== undefined)
          .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
      ),
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    join(work, "manifest.json"),
    JSON.stringify({
      format: "relakeep-cloud-backup",
      version: 1,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const tar = spawn("tar", ["-czf", "-", "-C", work, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const age = spawn(
    "/usr/local/bin/age",
    ["-r", recipient, "-o", destination],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  tar.stdout.pipe(age.stdin);
  await Promise.all(
    [tar, age].map(
      (p) =>
        new Promise<void>((ok, fail) => {
          p.on("error", fail);
          p.on("close", (c) =>
            c === 0 ? ok() : fail(new Error("Encrypted backup failed")),
          );
        }),
    ),
  );
  console.log(JSON.stringify({ backup: true, encrypted: true }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
