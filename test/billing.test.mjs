import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { Portal } from "../dist/portal.js";
import { Billing } from "../dist/billing.js";
import { fixture } from "./helpers.mjs";
// All identifiers, keys and provider responses below are synthetic fixtures. No network or charge occurs.
function billingFixture(t) {
  const f = fixture(t),
    options = {
      signupOpen: true,
      commercialReady: true,
      stripeKey: "sk_test_synthetic_fixture",
      stripeWebhook: "whsec_synthetic_fixture",
      stripePrice: "price_essoria",
      stripeAccount: "acct_essoria",
    };
  const portal = new Portal(
      f.store,
      f.access,
      f.sessions,
      f.tools,
      f.config,
      options,
    ),
    a = f.store.createAccount("Billing fixture");
  f.store.db
    .prepare(
      "INSERT INTO customers(id,email,name,account,trial_until,stripe_customer,stripe_subscription,billing_state,paid_until) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "u_test",
      "billing@example.test",
      "Billing fixture",
      a.id,
      0,
      "cus_test",
      "sub_current",
      "beta",
      0,
    );
  const subs = new Map([
      [
        "sub_current",
        {
          id: "sub_current",
          customer: "cus_test",
          created: 10,
          status: "active",
          metadata: { essoria_user: "u_test", brand: "essoria" },
          items: {
            data: [
              {
                price: { id: "price_essoria" },
                current_period_end: Math.floor(Date.now() / 1000) + 3600,
              },
            ],
          },
          latest_invoice: { status: "paid" },
        },
      ],
    ]),
    calls = [];
  const client = {
    rawRequest: async () => ({
      id: "acct_essoria",
      business_profile: { url: "https://essoria.app" },
      charges_enabled: false,
    }),
    prices: {
      retrieve: async () => ({
        active: true,
        currency: "usd",
        unit_amount: 1000,
        recurring: { interval: "month", interval_count: 1 },
      }),
    },
    customers: { create: async () => ({ id: "cus_test" }) },
    checkout: {
      sessions: {
        create: async (body, params) => {
          calls.push({ body, params });
          return { url: "https://checkout.stripe.com/synthetic-fixture" };
        },
      },
    },
    subscriptions: {
      retrieve: async (id, args) => {
        calls.push({ retrieve: id, args });
        return subs.get(id);
      },
    },
    charges: {
      retrieve: async () => ({ id: "ch_test", customer: "cus_test" }),
    },
    webhooks: new Stripe("sk_test_synthetic_fixture").webhooks,
  };
  const billing = new Billing(portal, options, client),
    user = () =>
      f.store.db.prepare("SELECT * FROM customers WHERE id=?").get("u_test");
  const event = (
    id,
    type,
    object = { customer: "cus_test", subscription: "sub_current" },
  ) => ({ id, type, livemode: false, data: { object } });
  return { ...f, portal, billing, options, client, subs, calls, user, event };
}
test("signed billing events grant access only for a paid current invoice and reject altered or live payloads", async (t) => {
  const f = billingFixture(t);
  f.subs.get("sub_current").latest_invoice.status = "open";
  await f.billing.process(
    f.event("evt_unpaid", "customer.subscription.updated", {
      id: "sub_current",
      customer: "cus_test",
    }),
  );
  assert.equal(f.portal.entitled(f.user()), false);
  f.subs.get("sub_current").latest_invoice.status = "paid";
  const payload = JSON.stringify(f.event("evt_paid", "invoice.paid")),
    header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: f.options.stripeWebhook,
    });
  await f.billing.webhook({
    headers: { "stripe-signature": header },
    body: Buffer.from(payload),
  });
  assert.equal(f.portal.entitled(f.user()), true);
  assert.deepEqual(f.calls.find((c) => c.retrieve)?.args, {
    expand: ["latest_invoice"],
  });
  const count = f.calls.length;
  await f.billing.webhook({
    headers: { "stripe-signature": header },
    body: Buffer.from(payload),
  });
  assert.equal(f.calls.length, count);
  await assert.rejects(
    f.billing.webhook({
      headers: { "stripe-signature": header },
      body: Buffer.from(payload + " "),
    }),
  );
  await assert.rejects(
    f.billing.process({
      ...f.event("evt_live", "invoice.paid"),
      livemode: true,
    }),
    /mode/,
  );
});
test("delayed old subscription events cannot replace a newer subscription; persistent holds survive invoice events", async (t) => {
  const f = billingFixture(t);
  const old = f.subs.get("sub_current");
  f.subs.set("sub_new", { ...old, id: "sub_new", created: 20 });
  f.store.db
    .prepare("UPDATE customers SET stripe_subscription=? WHERE id=?")
    .run("sub_new", "u_test");
  old.status = "canceled";
  await f.billing.process(
    f.event("evt_old", "customer.subscription.deleted", {
      id: "sub_current",
      customer: "cus_test",
    }),
  );
  assert.equal(f.user().stripe_subscription, "sub_new");
  await f.billing.process(
    f.event("evt_dispute", "charge.dispute.created", {
      id: "dp_test",
      charge: "ch_test",
    }),
  );
  assert.equal(f.user().billing_state, "disputed");
  assert.equal(f.portal.entitled(f.user()), false);
  await f.billing.process(
    f.event("evt_late_paid", "invoice.paid", {
      customer: "cus_test",
      subscription: "sub_new",
    }),
  );
  assert.equal(f.user().billing_state, "disputed");
  await f.billing.process(
    f.event("evt_won", "charge.dispute.closed", {
      id: "dp_test",
      charge: "ch_test",
      status: "won",
    }),
  );
  assert.equal(f.portal.entitled(f.user()), true);
  await f.billing.process(
    f.event("evt_refund", "charge.refunded", {
      id: "ch_test",
      customer: "cus_test",
      refunded: true,
    }),
  );
  await f.billing.process(
    f.event("evt_paid_again", "invoice.paid", {
      customer: "cus_test",
      subscription: "sub_new",
    }),
  );
  assert.equal(f.user().billing_state, "refunded");
});
test("actionable fraud warnings pause access, including a remaining trial, and later invoices cannot clear the hold", async (t) => {
  const f = billingFixture(t);
  f.store.db
    .prepare("UPDATE customers SET trial_until=? WHERE id=?")
    .run(Date.now() + 3600000, "u_test");
  await f.billing.process(
    f.event("evt_inactive_warning", "radar.early_fraud_warning.created", {
      id: "iss_inactive",
      charge: "ch_test",
      actionable: false,
    }),
  );
  assert.equal(f.portal.entitled(f.user()), true);
  await f.billing.process(
    f.event("evt_warning", "radar.early_fraud_warning.created", {
      id: "iss_actionable",
      charge: "ch_test",
      actionable: true,
    }),
  );
  assert.equal(f.user().billing_state, "fraud_warning");
  assert.equal(f.portal.entitled(f.user()), false);
  await f.billing.process(f.event("evt_later_invoice", "invoice.paid"));
  assert.equal(f.user().billing_state, "fraud_warning");
  assert.equal(f.portal.entitled(f.user()), false);
});
test("merchant identity and price are checked; retries use identical checkout parameters and no explicit payment method list", async (t) => {
  const f = billingFixture(t);
  f.store.db
    .prepare("UPDATE customers SET stripe_subscription=NULL WHERE id=?")
    .run("u_test");
  await f.billing.checkout(f.user());
  await f.billing.checkout(f.user());
  const [one, two] = f.calls.filter((c) => c.body);
  assert.deepEqual(one, two);
  assert(!("payment_method_types" in one.body));
  assert.match(one.body.integration_identifier, /^essoria-subscribe-[a-z]{8}$/);
  f.client.rawRequest = async () => ({
    id: "acct_other",
    business_profile: { url: "https://cenlo.example" },
  });
  await assert.rejects(f.billing.checkout(f.user()), /marca Essoria/);
});

test("monthly quota reserves each request once, has an exact limit, and keeps original month accounting", (t) => {
  const f = billingFixture(t),
    u = f.user();
  f.store.db
    .prepare("UPDATE customers SET trial_until=? WHERE id=?")
    .run(Date.now() + 3600000, u.id);
  for (let i = 0; i < 1000; i++)
    f.portal.checkSend(u.account, "unique-request-" + i);
  assert.equal(f.portal.usage(u.account), 1000);
  f.portal.checkSend(u.account, "unique-request-0");
  assert.equal(f.portal.usage(u.account), 1000);
  assert.throws(() => f.portal.checkSend(u.account, "over-limit"), /1000/);
  f.store.db
    .prepare("UPDATE send_usage SET month=? WHERE account=? AND request_id=?")
    .run("2000-01", u.account, "unique-request-0");
  assert.equal(f.portal.usage(u.account), 999);
  f.portal.checkSend(u.account, "unique-request-0");
  assert.equal(f.portal.usage(u.account), 999);
  f.portal.checkSend(u.account, "new-month-request");
  assert.equal(f.portal.usage(u.account), 1000);
  f.store.db.prepare("DELETE FROM accounts WHERE id=?").run(u.account);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM send_usage").get().n,
    0,
  );
});

test("closing new sales still allows existing clients to cancel or manage; canceled subscriptions need no second cancellation", async (t) => {
  const f = billingFixture(t);
  f.options.commercialReady = false;
  let cancelled = 0;
  f.client.subscriptions.cancel = async () => {
    cancelled++;
    return {};
  };
  f.client.billingPortal = {
    sessions: {
      create: async () => ({
        url: "https://billing.stripe.com/synthetic-fixture",
      }),
    },
  };
  assert.equal(f.billing.publicState().enabled, false);
  assert.equal(f.billing.publicState().manageable, true);
  assert.match(await f.billing.customerPortal(f.user()), /^https:/);
  await f.billing.cancelForDeletion(f.user());
  assert.equal(cancelled, 1);
  f.subs.get("sub_current").status = "canceled";
  await f.billing.cancelForDeletion(f.user());
  assert.equal(cancelled, 1);
  await assert.rejects(f.billing.checkout(f.user()), /no están habilitados/);
});

test("concurrent webhook reconciliation cannot write a stale active state after cancellation", async (t) => {
  const f = billingFixture(t);
  let release, began;
  const gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (began = r));
  let first = true;
  f.client.subscriptions.retrieve = async () => {
    const snapshot = structuredClone(f.subs.get("sub_current"));
    if (first) {
      first = false;
      began();
      await gate;
    }
    return snapshot;
  };
  const paid = f.billing.process(
    f.event("evt_concurrent_paid", "invoice.paid"),
  );
  await started;
  f.subs.get("sub_current").status = "canceled";
  const canceled = f.billing.process(
    f.event("evt_concurrent_cancel", "customer.subscription.deleted", {
      id: "sub_current",
      customer: "cus_test",
    }),
  );
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([paid, canceled]);
  assert.equal(f.user().billing_state, "canceled");
  assert.equal(f.portal.entitled(f.user()), false);
});
