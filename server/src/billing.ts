import Stripe from "stripe";
import { createHash } from "node:crypto";
import { Ledger, LedgerError } from "./ledger";
export const AMOUNTS = { cny: 2000, hkd: 2350, usd: 299 } as const;
export type Currency = keyof typeof AMOUNTS;
export type Prices = Record<"monthly" | "topup", Record<Currency, string>>;
const ref = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);
const effective = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);
export class Billing {
  constructor(
    readonly stripe: Stripe,
    readonly ledger: Ledger,
    readonly prices: Prices,
    readonly origin: string,
    readonly portalConfiguration?: string,
  ) {}
  async customer(user: { id: string; email: string }) {
    const row = this.ledger.db
      .prepare("SELECT stripe_customer FROM cloud_customers WHERE user_id=?")
      .get(user.id) as { stripe_customer: string } | undefined;
    if (row) return row.stripe_customer;
    const customer = await this.stripe.customers.create(
      { email: user.email, metadata: { product: "relakeep", userId: user.id } },
      { idempotencyKey: "relakeep-customer-" + user.id },
    );
    this.ledger.db
      .prepare(
        "INSERT OR IGNORE INTO cloud_customers(user_id,stripe_customer) VALUES(?,?)",
      )
      .run(user.id, customer.id);
    return customer.id;
  }
  async checkout(
    user: { id: string; email: string },
    kind: "monthly" | "topup",
    currency: Currency,
    requestId: string,
  ) {
    const db = this.ledger.db,
      now = this.ledger.clock(),
      price = this.prices[kind][currency],
      operation = user.id + ":" + requestId;
    const prior = db
      .prepare("SELECT * FROM cloud_checkouts WHERE id=?")
      .get(operation) as
      | {
          kind: string;
          price: string;
          state: string;
          url: string;
          created_at: number;
          stripe_session: string | null;
        }
      | undefined;
    if (prior && (prior.kind !== kind || prior.price !== price))
      throw new LedgerError("REQUEST_ID_REUSED");
    if (prior?.state === "open") {
      if (!prior.stripe_session)
        throw new LedgerError("PAYMENT_REVIEW_REQUIRED");
      const session = await this.stripe.checkout.sessions.retrieve(
        prior.stripe_session,
      );
      if (session.status === "open") return { url: prior.url };
      db.prepare("UPDATE cloud_checkouts SET state=? WHERE id=?").run(
        session.status,
        operation,
      );
      throw new LedgerError(
        session.status === "complete"
          ? "CHECKOUT_ALREADY_COMPLETED"
          : "CHECKOUT_EXPIRED",
      );
    }
    if (prior?.state === "complete")
      throw new LedgerError("CHECKOUT_ALREADY_COMPLETED");
    const createdAt = prior?.created_at ?? now;
    if (prior?.state === "expired" || createdAt + 1800000 <= now) {
      db.prepare("UPDATE cloud_checkouts SET state='expired' WHERE id=?").run(
        operation,
      );
      throw new LedgerError("CHECKOUT_EXPIRED");
    }
    db.transaction(() => {
      const lock = db
        .prepare("SELECT expires_at FROM cloud_purchase_locks WHERE user_id=?")
        .get(user.id) as { expires_at: number } | undefined;
      if (lock && lock.expires_at > now) throw new LedgerError("CHECKOUT_BUSY");
      db.prepare("INSERT OR REPLACE INTO cloud_purchase_locks VALUES(?,?)").run(
        user.id,
        now + 180000,
      );
      db.prepare(
        "INSERT OR IGNORE INTO cloud_checkouts(id,user_id,kind,price,currency,state,url,created_at) VALUES(?,?,?,?,?,'creating',NULL,?)",
      ).run(operation, user.id, kind, price, currency, createdAt);
    }).immediate();
    try {
      const customer = await this.customer(user);
      if (kind === "monthly") {
        const subscriptions = await this.stripe.subscriptions.list({
          customer,
          status: "all",
          limit: 100,
        });
        if (subscriptions.data.some((s) => effective.has(s.status)))
          throw new LedgerError("SUBSCRIPTION_EXISTS");
        const open = db
          .prepare(
            "SELECT id FROM cloud_checkouts WHERE user_id=? AND kind='monthly' AND state IN ('open','creating') AND id<>? AND created_at>?",
          )
          .get(user.id, operation, now - 1800000);
        if (open) throw new LedgerError("SUBSCRIPTION_CHECKOUT_PENDING");
      }
      const metadata = {
        product: "relakeep",
        userId: user.id,
        kind,
        currency,
        operation,
      };
      const letters = Array.from(
        createHash("sha256").update(operation).digest().subarray(0, 8),
        (n) => String.fromCharCode(97 + (n % 26)),
      ).join("");
      const session = await this.stripe.checkout.sessions.create(
        {
          customer,
          client_reference_id: user.id,
          mode: kind === "monthly" ? "subscription" : "payment",
          line_items: [{ price, quantity: 1 }],
          metadata,
          ...(kind === "monthly"
            ? { subscription_data: { metadata } }
            : { payment_intent_data: { metadata } }),
          success_url: this.origin + "/success",
          cancel_url: this.origin + "/pricing",
          expires_at: Math.floor(createdAt / 1000) + 1800,
          integration_identifier: "relakeep-" + letters,
        },
        { idempotencyKey: "relakeep-checkout-" + operation },
      );
      if (!session.url) throw new Error("CHECKOUT_URL_MISSING");
      db.prepare(
        "UPDATE cloud_checkouts SET state='open',url=?,stripe_session=? WHERE id=?",
      ).run(session.url, session.id, operation);
      return { url: session.url };
    } catch (error) {
      // Business refusal did not create a payment; a network timeout remains retryable with the same operation.
      if (error instanceof LedgerError)
        db.prepare(
          "UPDATE cloud_checkouts SET state='rejected' WHERE id=?",
        ).run(operation);
      throw error;
    } finally {
      db.prepare("DELETE FROM cloud_purchase_locks WHERE user_id=?").run(
        user.id,
      );
    }
  }
  async portal(user: { id: string; email: string }) {
    if (!this.portalConfiguration)
      throw new LedgerError("BILLING_NOT_AVAILABLE", 503);
    const customer = await this.customer(user);
    const session = await this.stripe.billingPortal.sessions.create({
      customer,
      configuration: this.portalConfiguration,
      return_url: this.origin + "/account",
    });
    return { url: session.url };
  }
  async prepare(event: Stripe.Event): Promise<() => void> {
    const db = this.ledger.db,
      object = event.data.object;
    const knownUser = (customer: string | null) => {
      const row = db
        .prepare("SELECT user_id FROM cloud_customers WHERE stripe_customer=?")
        .get(customer) as { user_id: string } | undefined;
      return row?.user_id;
    };
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = await this.stripe.checkout.sessions.retrieve(
        (object as Stripe.Checkout.Session).id,
        { expand: ["line_items"] },
      );
      if (session.metadata?.product !== "relakeep") return () => {};
      const user = knownUser(ref(session.customer));
      if (
        !user ||
        user !== session.metadata.userId ||
        session.client_reference_id !== user
      )
        throw new Error("CHECKOUT_OWNER_MISMATCH");
      const paid = session.payment_status === "paid";
      const currency = session.currency as Currency;
      const item = session.line_items?.data;
      if (session.mode === "payment" && paid) {
        if (
          !AMOUNTS[currency] ||
          session.amount_total !== AMOUNTS[currency] ||
          item?.length !== 1 ||
          ref(item[0].price) !== this.prices.topup[currency] ||
          item[0].quantity !== 1
        )
          throw new Error("CHECKOUT_PRICE_MISMATCH");
        const intent = ref(session.payment_intent);
        if (!intent) throw new Error("PAYMENT_REFERENCE_MISSING");
        return () => {
          this.ledger.grant(session.id, user, "topup", 300, null, intent);
          db.prepare(
            "UPDATE cloud_checkouts SET state='complete' WHERE id=?",
          ).run(session.metadata?.operation);
        };
      }
      return () => {
        if (session.status === "complete")
          db.prepare(
            "UPDATE cloud_checkouts SET state='complete' WHERE id=?",
          ).run(session.metadata?.operation);
      };
    }
    if (event.type === "invoice.paid") {
      const invoice = await this.stripe.invoices.retrieve(
        (object as Stripe.Invoice).id,
        { expand: ["payments"] },
      );
      const subscriptionId = ref(
        invoice.parent?.subscription_details?.subscription,
      );
      if (!subscriptionId) return () => {};
      const subscription =
        await this.stripe.subscriptions.retrieve(subscriptionId);
      if (subscription.metadata.product !== "relakeep") return () => {};
      const user = knownUser(ref(invoice.customer));
      if (!user || subscription.metadata.userId !== user)
        throw new Error("INVOICE_OWNER_MISMATCH");
      if (
        invoice.status !== "paid" ||
        !["subscription_create", "subscription_cycle"].includes(
          invoice.billing_reason ?? "",
        )
      )
        return () => {};
      const lines = await this.stripe.invoices.listLineItems(invoice.id, {
        limit: 100,
      });
      const currency = invoice.currency as Currency;
      const line = lines.data.find(
        (l) =>
          ref(l.pricing?.price_details?.price) ===
          this.prices.monthly[currency],
      );
      if (
        !AMOUNTS[currency] ||
        lines.data.length !== 1 ||
        !line ||
        line.quantity !== 1 ||
        line.amount !== AMOUNTS[currency] ||
        invoice.amount_paid < AMOUNTS[currency] ||
        line.parent?.subscription_item_details?.proration
      )
        throw new Error("INVOICE_PRICE_MISMATCH");
      const payment = invoice.payments?.data.find((p) => p.status === "paid");
      const intent = ref(payment?.payment.payment_intent),
        charge = ref(payment?.payment.charge);
      if (!intent && !charge)
        throw new Error("INVOICE_PAYMENT_REFERENCE_MISSING");
      const start = line.period.start * 1000,
        end = line.period.end * 1000;
      return () =>
        this.ledger.grant(
          invoice.id,
          user,
          "monthly",
          300,
          end,
          intent,
          charge,
          subscriptionId + ":" + start,
          start,
        );
    }
    if (event.type.startsWith("customer.subscription.")) {
      const subscription = await this.stripe.subscriptions.retrieve(
        (object as Stripe.Subscription).id,
      );
      if (subscription.metadata.product !== "relakeep") return () => {};
      const user = knownUser(ref(subscription.customer));
      if (!user || subscription.metadata.userId !== user)
        throw new Error("SUBSCRIPTION_OWNER_MISMATCH");
      const end =
        Math.max(
          0,
          ...subscription.items.data.map((i) => i.current_period_end),
        ) * 1000;
      // Fetching current Stripe state prevents older deliveries from undoing cancellation.
      return () =>
        db
          .prepare(
            "INSERT INTO cloud_subscriptions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,ends_at=excluded.ends_at,cancels=excluded.cancels",
          )
          .run(
            subscription.id,
            user,
            subscription.status,
            end,
            subscription.cancel_at_period_end ? 1 : 0,
          );
    }
    if (event.type === "refund.created" || event.type === "refund.updated") {
      const refund = object as Stripe.Refund;
      if (refund.status === "succeeded")
        return () =>
          this.ledger.revoke(ref(refund.charge), ref(refund.payment_intent));
    }
    if (event.type === "charge.refunded") {
      const charge = object as Stripe.Charge;
      if (charge.amount_refunded > 0)
        return () => this.ledger.revoke(charge.id, ref(charge.payment_intent));
    }
    if (event.type === "charge.dispute.created") {
      const dispute = object as Stripe.Dispute,
        charge = await this.stripe.charges.retrieve(ref(dispute.charge)!);
      const user = knownUser(ref(charge.customer));
      return () => {
        this.ledger.revoke(charge.id, ref(charge.payment_intent));
        if (user)
          db.prepare(
            "UPDATE cloud_customers SET blocked=1 WHERE user_id=?",
          ).run(user);
      };
    }
    if (event.type === "checkout.session.expired")
      return () => {
        const session = object as Stripe.Checkout.Session;
        if (session.metadata?.product === "relakeep")
          db.prepare(
            "UPDATE cloud_checkouts SET state='expired' WHERE id=?",
          ).run(session.metadata.operation);
      };
    return () => {};
  }
}
