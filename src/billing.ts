import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import type { Portal, PortalOptions } from "./portal.js";

export class Billing {
  private stripe?: Stripe;
  private reconciliation: Promise<void> = Promise.resolve();
  constructor(
    private portal: Portal,
    private options: PortalOptions,
    client?: Stripe,
  ) {
    if (client) this.stripe = client;
    else if (options.stripeKey)
      this.stripe = new Stripe(options.stripeKey, {
        maxNetworkRetries: 1,
        timeout: 15000,
      });
  }
  publicState() {
    const ready = !!(
      this.stripe &&
      this.options.stripeWebhook &&
      this.options.stripePrice &&
      this.options.stripeAccount &&
      this.options.commercialReady
    );
    return {
      enabled: ready,
      manageable: !!(this.stripe && this.options.stripeAccount),
      mode: !this.options.stripeKey
        ? "unconfigured"
        : this.options.stripeKey.includes("_test_")
          ? "test"
          : "live",
      price: 1000,
      currency: "usd",
      interval: "month",
      numbers: 1,
      maxAgents: 5,
      monthlySendRequests: 1000,
      reason: ready
        ? null
        : "Los cobros de Essoria todavía no están habilitados. La propuesta es USD 10 al mes; no se realizará ningún cargo desde esta página.",
    };
  }
  private async verified(checkout = true) {
    if (
      !this.stripe ||
      !this.options.stripeAccount ||
      (checkout && !this.publicState().enabled)
    )
      throw new Error("Los cobros todavía no están habilitados para Essoria.");
    const [account, price] = await Promise.all([
      this.stripe.rawRequest("GET", "/v1/account") as Promise<Stripe.Account>,
      checkout
        ? this.stripe.prices.retrieve(this.options.stripePrice!)
        : Promise.resolve(undefined),
    ]);
    let host = "";
    try {
      host = new URL(account.business_profile?.url ?? "").hostname;
    } catch {}
    if (
      account.id !== this.options.stripeAccount ||
      !["essoria.app", "www.essoria.app"].includes(host)
    )
      throw new Error(
        "La cuenta de cobro debe pertenecer a la marca Essoria y usar essoria.app.",
      );
    if (
      checkout &&
      (!price ||
        !price.active ||
        price.currency !== "usd" ||
        price.unit_amount !== 1000 ||
        price.recurring?.interval !== "month" ||
        price.recurring.interval_count !== 1)
    )
      throw new Error(
        "El precio configurado no coincide con Essoria Inicio: USD 10 al mes.",
      );
    if (
      checkout &&
      this.publicState().mode === "live" &&
      !account.charges_enabled
    )
      throw new Error("Stripe todavía no habilita los cobros de esta marca.");
    return this.stripe;
  }
  async checkout(user: any): Promise<string> {
    const stripe = await this.verified();
    if (
      user.stripe_subscription &&
      !["canceled", "incomplete_expired"].includes(user.billing_state)
    )
      throw new Error("Ya tienes una suscripción. Usa Gestionar suscripción.");
    let customer = user.stripe_customer;
    if (!customer) {
      const c = await stripe.customers.create(
        {
          email: user.email,
          name: user.name,
          metadata: { essoria_user: user.id, brand: "essoria" },
        },
        { idempotencyKey: "essoria-customer-" + user.id },
      );
      customer = c.id;
      this.portal.store.db
        .prepare("UPDATE customers SET stripe_customer=? WHERE id=?")
        .run(customer, user.id);
    }
    const key =
      "essoria-checkout-" +
      user.id +
      "-" +
      (user.stripe_subscription ?? "initial") +
      "-" +
      Math.floor(Date.now() / 1800000);
    const db = this.portal.store.db;
    db.prepare("INSERT OR IGNORE INTO billing_checkouts VALUES(?,?,?,?)").run(
      key,
      user.id,
      "essoria-subscribe-" +
        Array.from(randomBytes(8), (b) =>
          String.fromCharCode(97 + (b % 26)),
        ).join(""),
      Date.now(),
    );
    const identifier = (
      db
        .prepare("SELECT identifier FROM billing_checkouts WHERE id=?")
        .get(key) as any
    ).identifier;
    db.prepare("DELETE FROM billing_checkouts WHERE created<?").run(
      Date.now() - 86400000,
    );
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        line_items: [{ price: this.options.stripePrice, quantity: 1 }],
        client_reference_id: user.id,
        success_url:
          this.portal.config.publicUrl + "/app/facturacion?checkout=returned",
        cancel_url:
          this.portal.config.publicUrl + "/app/facturacion?checkout=cancelled",
        metadata: { essoria_user: user.id, brand: "essoria" },
        subscription_data: {
          metadata: { essoria_user: user.id, brand: "essoria" },
        },
        integration_identifier: identifier,
      } as any,
      { idempotencyKey: key },
    );
    if (!session.url) throw new Error("Stripe no devolvió una URL de pago.");
    return session.url;
  }
  async customerPortal(user: any): Promise<string> {
    const stripe = await this.verified(false);
    if (!user.stripe_customer)
      throw new Error("Todavía no tienes una suscripción de pago.");
    return (
      await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer,
        return_url: this.portal.config.publicUrl + "/app/facturacion",
      })
    ).url;
  }
  async cancelForDeletion(user: any) {
    if (!user.stripe_subscription) return;
    const stripe = await this.verified(false);
    const sub = await stripe.subscriptions.retrieve(user.stripe_subscription);
    if (!["canceled", "incomplete_expired"].includes(sub.status))
      await stripe.subscriptions.cancel(user.stripe_subscription);
  }
  async webhook(req: Request): Promise<void> {
    if (!this.stripe || !this.options.stripeWebhook)
      throw new Error("Unconfigured");
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string" || !Buffer.isBuffer(req.body))
      throw new Error("Missing signature");
    const event = this.stripe.webhooks.constructEvent(
      req.body,
      signature,
      this.options.stripeWebhook,
    );
    await this.process(event);
  }
  process(event: Stripe.Event): Promise<void> {
    const work = this.reconciliation.then(() => this.reconcile(event));
    this.reconciliation = work.catch(() => {});
    return work;
  }
  private async reconcile(event: Stripe.Event): Promise<void> {
    if (!this.stripe) throw new Error("Unconfigured");
    const db = this.portal.store.db;
    if (db.prepare("SELECT id FROM billing_events WHERE id=?").get(event.id))
      return;
    const expectedLive = this.publicState().mode === "live";
    if (event.livemode !== expectedLive)
      throw new Error("Unexpected billing mode");
    const object = event.data.object as any;
    const supported = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.payment_action_required",
      "charge.dispute.created",
      "charge.dispute.closed",
      "charge.refunded",
      "radar.early_fraud_warning.created",
    ];
    if (!supported.includes(event.type)) {
      db.prepare("INSERT OR IGNORE INTO billing_events VALUES(?,?)").run(
        event.id,
        Date.now(),
      );
      return;
    }
    const fraudWarning = event.type === "radar.early_fraud_warning.created";
    if (fraudWarning && object.actionable === false) {
      db.prepare("INSERT OR IGNORE INTO billing_events VALUES(?,?)").run(
        event.id,
        Date.now(),
      );
      return;
    }
    const charge =
      (event.type.startsWith("charge.dispute.") || fraudWarning) &&
      object.charge
        ? await this.stripe.charges.retrieve(
            typeof object.charge === "string"
              ? object.charge
              : object.charge.id,
          )
        : object;
    const customer =
      typeof charge.customer === "string"
        ? charge.customer
        : charge.customer?.id;
    const user = customer
      ? (db
          .prepare("SELECT * FROM customers WHERE stripe_customer=?")
          .get(customer) as any)
      : undefined;
    if (!user) {
      db.prepare("INSERT OR IGNORE INTO billing_events VALUES(?,?)").run(
        event.id,
        Date.now(),
      );
      return;
    }
    let subscriptionId = event.type.startsWith("customer.subscription.")
      ? object.id
      : typeof object.subscription === "string"
        ? object.subscription
        : object.parent?.subscription_details?.subscription;
    subscriptionId ??= user.stripe_subscription;
    let state = user.billing_state,
      paidUntil = user.paid_until;
    let hold: string | undefined;
    if (subscriptionId) {
      // Read current provider state so delayed/out-of-order events cannot reactivate a canceled subscription.
      const sub = (await this.stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["latest_invoice"],
      })) as any;
      if (user.stripe_subscription && user.stripe_subscription !== sub.id) {
        const current = await this.stripe.subscriptions.retrieve(
          user.stripe_subscription,
        );
        if (
          current.created > sub.created ||
          (current.created === sub.created &&
            !["canceled", "incomplete_expired"].includes(current.status))
        ) {
          db.prepare("INSERT OR IGNORE INTO billing_events VALUES(?,?)").run(
            event.id,
            Date.now(),
          );
          return;
        }
      }
      if (
        (typeof sub.customer === "string" ? sub.customer : sub.customer?.id) !==
          customer ||
        sub.metadata?.essoria_user !== user.id ||
        sub.metadata?.brand !== "essoria" ||
        !sub.items?.data?.some(
          (i: any) => i.price?.id === this.options.stripePrice,
        )
      )
        throw new Error(
          "Subscription does not belong to this Essoria customer/price",
        );
      state = sub.status;
      const end =
        sub.items?.data?.map((i: any) => i.current_period_end ?? 0) ?? [];
      paidUntil = Math.min(...end) * 1000;
      if (!Number.isFinite(paidUntil)) paidUntil = 0;
      if (state === "active" && sub.latest_invoice?.status !== "paid") {
        state = "awaiting_payment";
        paidUntil = 0;
      }
      if (state === "trialing") paidUntil = (sub.trial_end ?? 0) * 1000;
      if (event.type === "charge.dispute.created") {
        hold = "disputed";
        state = "disputed";
        paidUntil = 0;
      }
      if (event.type === "charge.refunded" && object.refunded) {
        hold = "refunded";
        state = "refunded";
        paidUntil = 0;
      }
      if (fraudWarning) {
        hold = "fraud_warning";
        state = "fraud_warning";
        paidUntil = 0;
      }
      if (event.type === "charge.dispute.closed" && object.status === "won")
        db.prepare("DELETE FROM billing_holds WHERE id=? AND user_id=?").run(
          object.id,
          user.id,
        );
    }
    this.portal.store.transaction(() => {
      if (db.prepare("SELECT id FROM billing_events WHERE id=?").get(event.id))
        return;
      if (hold)
        db.prepare("INSERT OR IGNORE INTO billing_holds VALUES(?,?,?,?,?)").run(
          object.id,
          user.id,
          subscriptionId,
          hold,
          Date.now(),
        );
      const existingHold = db
        .prepare(
          "SELECT reason FROM billing_holds WHERE user_id=? AND subscription=? LIMIT 1",
        )
        .get(user.id, subscriptionId ?? "") as any;
      if (existingHold) {
        state = existingHold.reason;
        paidUntil = 0;
      }
      db.prepare(
        "UPDATE customers SET stripe_subscription=?,billing_state=?,paid_until=? WHERE id=?",
      ).run(subscriptionId ?? null, state, paidUntil, user.id);
      db.prepare("INSERT INTO billing_events VALUES(?,?)").run(
        event.id,
        Date.now(),
      );
    });
  }
}
