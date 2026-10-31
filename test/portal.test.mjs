import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../dist/service.js";
import { initialize, loadConfig } from "../dist/config.js";
import { fakeDriver } from "./helpers.mjs";
export async function portalFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "essoria-portal-"));
  initialize(dir);
  const config = loadConfig({
      WA_DATA_DIR: dir,
      WA_PORT: "0",
      WA_AUTO_START: "false",
    }),
    fake = fakeDriver(),
    service = new Service(config, fake.factory, {
      signupOpen: true,
      commercialReady: false,
    });
  await service.start();
  t.after(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = service.address();
  const post = async (path, body, cookie, origin = config.publicUrl) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const get = (path, cookie) =>
    fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
  const register = async (email, name = "Test operator") => {
    const r = await post("/api/app/register", {
      email,
      name,
      password: "long-fictional-password-123",
      acceptedTerms: true,
    });
    assert.equal(r.status, 201);
    return {
      cookie: r.headers.get("set-cookie").split(";")[0],
      body: await r.json(),
    };
  };
  return { service, base, post, get, register, fake };
}
test("registration isolates account data, uses private sessions and never exposes stored secrets", async (t) => {
  const f = await portalFixture(t),
    a = await f.register("a@example.test"),
    b = await f.register("b@example.test");
  assert(a.body.recoveryCode.startsWith("essoria-recovery-"));
  const u = await (await f.get("/api/app/me", a.cookie)).json(),
    v = await (await f.get("/api/app/me", b.cookie)).json();
  assert.notEqual(u.account.id, v.account.id);
  assert.equal(u.user.email, "a@example.test");
  assert(!JSON.stringify(u).includes("password"));
  assert(!JSON.stringify(u).includes(a.body.recoveryCode));
  assert.equal((await f.get("/api/app/me")).status, 401);
  assert.equal(
    (
      await f.post(
        "/api/app/agents",
        { name: "Read agent", permissions: ["read"] },
        a.cookie,
        "https://evil.example",
      )
    ).status,
    403,
  );
  const issued = await (
    await f.post(
      "/api/app/agents",
      { name: "Read agent", permissions: ["read"] },
      a.cookie,
    )
  ).json();
  const p = f.service.access.identify(issued.token);
  assert.equal(p.accountId, u.account.id);
  assert(
    (
      await f.service.tools.execute(
        "whatsapp_account_status",
        { account: v.account.id },
        p,
      )
    ).isError,
  );
  const own = await (await f.get("/api/app/me", a.cookie)).json();
  assert.equal(own.agents.length, 1);
  assert(!JSON.stringify(own).includes(issued.token));
  assert.equal(
    (await f.post("/api/app/agents/revoke", { id: issued.id }, b.cookie))
      .status,
    400,
  );
  assert.equal(
    (await f.post("/api/app/agents/revoke", { id: issued.id }, a.cookie))
      .status,
    200,
  );
  assert.equal(f.service.access.identify(issued.token), null);
});
test("recovery rotates sessions and agent credentials, and deletion removes own local data only", async (t) => {
  const f = await portalFixture(t),
    a = await f.register("recovery@example.test"),
    b = await f.register("other@example.test");
  const me = await (await f.get("/api/app/me", a.cookie)).json(),
    k = await (
      await f.post(
        "/api/app/agents",
        { name: "Old agent", permissions: ["read", "send"] },
        a.cookie,
      )
    ).json();
  const r = await f.post("/api/app/recover", {
    email: "recovery@example.test",
    password: "new-long-password-456",
    recoveryCode: a.body.recoveryCode,
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0],
    recovery = await r.json();
  assert.notEqual(recovery.recoveryCode, a.body.recoveryCode);
  assert.equal((await f.get("/api/app/me", a.cookie)).status, 401);
  assert.equal(f.service.access.identify(k.token), null);
  assert.equal(
    (
      await f.post("/api/app/recover", {
        email: "recovery@example.test",
        password: "new-long-password-456",
        recoveryCode: a.body.recoveryCode,
      })
    ).status,
    400,
  );
  const deletion = await f.post(
    "/api/app/delete",
    { password: "new-long-password-456", confirm: "ELIMINAR" },
    cookie,
  );
  assert.equal(deletion.status, 200);
  assert.equal((await deletion.json()).remoteUnlinked, false);
  assert.throws(() => f.service.store.account(me.account.id), /not found/);
  assert.equal((await f.get("/api/app/me", cookie)).status, 401);
  assert.equal((await f.get("/api/app/me", b.cookie)).status, 200);
});
test("billing remains closed without dedicated merchant readiness; trial expiry blocks mutating tools", async (t) => {
  const f = await portalFixture(t),
    a = await f.register("billing@example.test");
  const me = await (await f.get("/api/app/me", a.cookie)).json();
  assert.equal(me.billing.enabled, false);
  assert.equal(me.billing.price, 1000);
  assert.equal((await f.post("/api/app/checkout", {}, a.cookie)).status, 400);
  assert.equal(
    (await f.post("/api/billing/webhook", { type: "invoice.paid" })).status,
    400,
  );
  f.service.store.db
    .prepare("UPDATE customers SET trial_until=0 WHERE id=?")
    .run(me.user.id);
  const result = await (
    await f.post("/api/app/tools", { name: "whatsapp_pairing_start" }, a.cookie)
  ).json();
  assert(result.isError);
  assert.equal(f.fake.sockets.length, 0);
  for (let n = 0; n < 5; n++)
    assert.equal(
      (
        await f.post(
          "/api/app/agents",
          { name: "Agent " + n, permissions: ["read"] },
          a.cookie,
        )
      ).status,
      201,
    );
  assert.equal(
    (
      await f.post(
        "/api/app/agents",
        { name: "Too many", permissions: ["read"] },
        a.cookie,
      )
    ).status,
    400,
  );
});
test("public pages preserve availability truth, support requests persist, and metadata excludes private areas", async (t) => {
  const f = await portalFixture(t);
  for (const path of [
    "/",
    "/producto",
    "/integraciones",
    "/agentes",
    "/precios",
    "/docs",
    "/seguridad",
    "/contacto",
    "/privacidad",
    "/terminos",
    "/entrar",
    "/registro",
    "/recuperar",
    "/estado",
  ]) {
    const r = await f.get(path);
    assert.equal(r.status, 200);
    assert(
      r.headers
        .get("content-security-policy")
        .includes("frame-ancestors 'none'"),
    );
    assert((await r.text()).includes("Essoria"));
  }
  const contact = await f.post("/api/app/contact", {
    email: "reader@example.test",
    message: "Please let me know when beta access becomes available.",
    consent: true,
  });
  assert.equal(contact.status, 201);
  const ticket = await contact.json();
  assert(
    f.service.store.db
      .prepare("SELECT id FROM support_requests WHERE id=?")
      .get(ticket.id),
  );
  const sitemap = await (await f.get("/sitemap.xml")).text();
  assert(!sitemap.includes("/app"));
  assert((await f.get("/app")).headers.get("x-robots-tag").includes("noindex"));
});
