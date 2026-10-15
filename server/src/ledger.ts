import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

export class LedgerError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
type Grant = {
  id: string;
  user_id: string;
  kind: "monthly" | "topup";
  original: number;
  remaining: number;
  expires_at: number | null;
  revoked: number;
};
type Request = {
  user_id: string;
  id: string;
  digest: string;
  attempt: string;
  state: string;
  grant_id: string;
  lease_until: number;
  result: Buffer | null;
  result_until: number | null;
};
export class Ledger {
  db: Database.Database;
  key: Buffer;
  clock: () => number;
  constructor(db: Database.Database, key: Buffer, clock = () => Date.now()) {
    if (key.length !== 32) throw new Error("CACHE_KEY must contain 32 bytes");
    this.db = db;
    this.key = key;
    this.clock = clock;
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_customers(user_id TEXT PRIMARY KEY, stripe_customer TEXT NOT NULL UNIQUE, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cloud_subscriptions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, ends_at INTEGER, cancels INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cloud_checkouts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, price TEXT NOT NULL, currency TEXT NOT NULL, state TEXT NOT NULL, url TEXT, created_at INTEGER NOT NULL, stripe_session TEXT);
      CREATE TABLE IF NOT EXISTS cloud_purchase_locks(user_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_grants(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('monthly','topup')), original INTEGER NOT NULL CHECK(original>0), remaining INTEGER NOT NULL CHECK(remaining>=0), starts_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, period_key TEXT UNIQUE, charge_id TEXT, payment_intent TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_revocations(reference TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cloud_grants_user ON cloud_grants(user_id,expires_at);
      CREATE TABLE IF NOT EXISTS cloud_requests(user_id TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,attempt TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','completed','failed')),grant_id TEXT NOT NULL REFERENCES cloud_grants(id),lease_until INTEGER NOT NULL,result BLOB,result_until INTEGER,error TEXT,PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS cloud_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,processed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_preferences(user_id TEXT PRIMARY KEY, model TEXT, unlimited INTEGER NOT NULL DEFAULT 0 CHECK(unlimited IN (0,1)), internal_usd_cents INTEGER NOT NULL DEFAULT 0 CHECK(internal_usd_cents>=0));
    `);
    if (
      !(db.pragma("table_info(cloud_checkouts)") as { name: string }[]).some(
        (column) => column.name === "stripe_session",
      )
    )
      db.exec("ALTER TABLE cloud_checkouts ADD COLUMN stripe_session TEXT");
  }
  grant(
    id: string,
    user: string,
    kind: "monthly" | "topup",
    amount: number,
    expires: number | null,
    paymentIntent: string | null = null,
    charge: string | null = null,
    periodKey: string | null = null,
    starts = 0,
  ) {
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      (kind === "monthly" && !expires)
    )
      throw new Error("Invalid grant");
    const revoked = Boolean(
      this.db
        .prepare("SELECT 1 FROM cloud_revocations WHERE reference IN (?,?)")
        .get(paymentIntent, charge),
    );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO cloud_grants(id,user_id,kind,original,remaining,starts_at,expires_at,payment_intent,charge_id,period_key,revoked,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        user,
        kind,
        amount,
        revoked ? 0 : amount,
        starts,
        expires,
        paymentIntent,
        charge,
        periodKey,
        revoked ? 1 : 0,
        this.clock(),
      );
  }
  recover() {
    const now = this.clock();
    this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            "SELECT * FROM cloud_requests WHERE state='pending' AND lease_until<?",
          )
          .all(now) as Request[];
        for (const row of rows) this.releaseRow(row, "INTERRUPTED");
        this.db
          .prepare("UPDATE cloud_requests SET result=NULL WHERE result_until<?")
          .run(now);
      })
      .immediate();
  }
  releaseRow(row: Request, error: string) {
    this.db
      .prepare(
        "UPDATE cloud_grants SET remaining=remaining+1 WHERE id=? AND revoked=0 AND id NOT LIKE 'owner:%'",
      )
      .run(row.grant_id);
    this.db
      .prepare(
        "UPDATE cloud_requests SET state='failed',error=?,result=NULL WHERE user_id=? AND id=? AND state='pending'",
      )
      .run(error, row.user_id, row.id);
  }
  balance(user: string) {
    this.recover();
    const rows = this.db
      .prepare(
        "SELECT kind,COALESCE(SUM(remaining),0) AS amount FROM cloud_grants WHERE user_id=? AND id NOT LIKE 'owner:%' AND revoked=0 AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) GROUP BY kind",
      )
      .all(user, this.clock(), this.clock()) as {
      kind: string;
      amount: number;
    }[];
    const monthly = rows.find((x) => x.kind === "monthly")?.amount ?? 0;
    const topup = rows.find((x) => x.kind === "topup")?.amount ?? 0;
    const subscription = this.db
      .prepare(
        "SELECT status,ends_at,cancels FROM cloud_subscriptions WHERE user_id=? ORDER BY COALESCE(ends_at,0) DESC LIMIT 1",
      )
      .get(user);
    const customer = this.db
      .prepare("SELECT blocked FROM cloud_customers WHERE user_id=?")
      .get(user) as { blocked: number } | undefined;
    const preferences = this.db.prepare("SELECT model,unlimited,internal_usd_cents FROM cloud_preferences WHERE user_id=?").get(user) as { model: string | null; unlimited: number; internal_usd_cents: number } | undefined;
    const unlimited = preferences?.unlimited === 1;
    const paidPeriod = this.db.prepare("SELECT 1 FROM cloud_grants WHERE user_id=? AND kind='monthly' AND revoked=0 AND starts_at<=? AND expires_at>? AND (payment_intent IS NOT NULL OR charge_id IS NOT NULL) LIMIT 1").get(user, this.clock(), this.clock());
    return {
      monthly,
      topup,
      total: unlimited ? 999999999 : monthly + topup,
      subscription: subscription ?? null,
      blocked: Boolean(customer?.blocked),
      unlimited,
      internalBalanceUsd: (preferences?.internal_usd_cents ?? 0) / 100,
      canChooseModels: unlimited || Boolean(paidPeriod),
      selectedModel: preferences?.model ?? null,
    };
  }
  reserve(
    user: string,
    id: string,
    input: unknown,
  ): { cached: unknown } | { reserved: true; attempt: string } {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id))
      throw new LedgerError("INVALID_REQUEST_ID", 400);
    const digest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    this.recover();
    return this.db
      .transaction(() => {
        const customer = this.db
          .prepare("SELECT blocked FROM cloud_customers WHERE user_id=?")
          .get(user) as { blocked: number } | undefined;
        if (customer?.blocked)
          throw new LedgerError("PAYMENT_REVIEW_REQUIRED", 403);
        const existing = this.db
          .prepare("SELECT * FROM cloud_requests WHERE user_id=? AND id=?")
          .get(user, id) as Request | undefined;
        if (existing) {
          if (existing.digest !== digest)
            throw new LedgerError("REQUEST_ID_REUSED", 409);
          if (existing.state === "pending")
            throw new LedgerError("REQUEST_IN_PROGRESS", 409);
          if (existing.state === "completed") {
            if (
              !existing.result ||
              (existing.result_until ?? 0) <= this.clock()
            )
              throw new LedgerError("RESULT_EXPIRED", 410);
            return { cached: this.decrypt(existing.result) };
          }
          // A failed operation may be retried with the same ID and payload; no successful debit exists.
          this.db
            .prepare("DELETE FROM cloud_requests WHERE user_id=? AND id=?")
            .run(user, id);
        }
        const active = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM cloud_requests WHERE state='pending'",
          )
          .get() as { count: number };
        if (active.count >= 2) throw new LedgerError("AI_BUSY", 429);
        const preferences = this.db.prepare("SELECT unlimited FROM cloud_preferences WHERE user_id=?").get(user) as { unlimited: number } | undefined;
        const unlimited = preferences?.unlimited === 1;
        if (unlimited) this.grant("owner:" + user, user, "topup", 1, null);
        const grant = unlimited
          ? this.db.prepare("SELECT * FROM cloud_grants WHERE id=? AND revoked=0").get("owner:" + user) as Grant | undefined
          : this.db
          .prepare(
            "SELECT * FROM cloud_grants WHERE user_id=? AND id NOT LIKE 'owner:%' AND remaining>0 AND revoked=0 AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY CASE kind WHEN 'monthly' THEN 0 ELSE 1 END,COALESCE(expires_at,9223372036854775807),created_at,id LIMIT 1",
          )
          .get(user, this.clock(), this.clock()) as Grant | undefined;
        if (!grant) throw new LedgerError("NO_CREDITS", 402);
        if (!unlimited) this.db
          .prepare(
            "UPDATE cloud_grants SET remaining=remaining-1 WHERE id=? AND remaining>0",
          )
          .run(grant.id);
        const attempt = randomUUID();
        this.db
          .prepare(
            "INSERT INTO cloud_requests(user_id,id,digest,attempt,state,grant_id,lease_until) VALUES(?,?,?,?,'pending',?,?)",
          )
          .run(user, id, digest, attempt, grant.id, this.clock() + 180000);
        return { reserved: true as const, attempt };
      })
      .immediate();
  }
  complete(user: string, id: string, result: unknown, attempt: string) {
    this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            "SELECT * FROM cloud_requests WHERE user_id=? AND id=? AND attempt=? AND state='pending'",
          )
          .get(user, id, attempt) as Request | undefined;
        if (!row) throw new LedgerError("REQUEST_NO_LONGER_PENDING");
        const grant = this.db
          .prepare("SELECT revoked FROM cloud_grants WHERE id=?")
          .get(row.grant_id) as { revoked: number };
        if (grant.revoked) throw new LedgerError("CREDITS_REVOKED", 403);
        this.db
          .prepare(
            "UPDATE cloud_requests SET state='completed',result=?,result_until=? WHERE user_id=? AND id=?",
          )
          .run(this.encrypt(result), this.clock() + 3600000, user, id);
      })
      .immediate();
  }
  fail(user: string, id: string, code: string, attempt: string) {
    this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            "SELECT * FROM cloud_requests WHERE user_id=? AND id=? AND attempt=? AND state='pending'",
          )
          .get(user, id, attempt) as Request | undefined;
        if (row) this.releaseRow(row, code);
      })
      .immediate();
  }
  revoke(charge: string | null, intent: string | null) {
    if (!charge && !intent) throw new Error("Refund lacks payment reference");
    this.db
      .transaction(() => {
        for (const reference of [charge, intent])
          if (reference)
            this.db
              .prepare("INSERT OR IGNORE INTO cloud_revocations VALUES(?,?)")
              .run(reference, this.clock());
        this.db
          .prepare(
            "UPDATE cloud_grants SET remaining=0,revoked=1 WHERE charge_id=? OR payment_intent=?",
          )
          .run(charge, intent);
      })
      .immediate();
  }
  event(id: string, type: string, apply: () => void) {
    return this.db
      .transaction(() => {
        if (this.db.prepare("SELECT 1 FROM cloud_events WHERE id=?").get(id))
          return false;
        apply();
        this.db
          .prepare("INSERT INTO cloud_events VALUES(?,?,?)")
          .run(id, type, this.clock());
        return true;
      })
      .immediate();
  }
  encrypt(value: unknown) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from("relakeep-result-v1"));
    return Buffer.concat([
      nonce,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }
  decrypt(value: Buffer) {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from("relakeep-result-v1"));
    decipher.setAuthTag(value.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(value.subarray(12, -16)),
        decipher.final(),
      ]).toString("utf8"),
    );
  }
}
