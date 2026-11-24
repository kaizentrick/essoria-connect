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

test("company grants restrict both MCP and queued wakes to chosen numbers", async (t) => {
  const f = await portalFixture(t),
    a = await f.register("multi@example.test"),
    b = await f.register("unrelated@example.test");
  const me = async (c) => (await f.get("/api/app/me", c)).json();
  const first = (await me(a.cookie)).account.id,
    other = (await me(b.cookie)).account.id;
  const second = (
    await (
      await f.post("/api/app/numbers", { label: "Ventas" }, a.cookie)
    ).json()
  ).id;
  const req = { headers: { cookie: a.cookie } };
  assert.throws(() =>
    f.service.portal.authorizeNumbers(req, [other], "Unrelated"),
  );
  const principal = f.service.portal.authorizeNumbers(
    req,
    [first, second],
    "QA",
  );
  const result = await f.service.tools.execute(
    "whatsapp_account_list",
    {},
    principal,
  );
  assert.deepEqual(
    JSON.parse(result.content[0].text)
      .accounts.map((a) => a.id)
      .sort(),
    [first, second].sort(),
  );
  assert(
    (
      await f.service.tools.execute(
        "whatsapp_account_status",
        { account: other },
        principal,
      )
    ).isError,
  );
  assert.deepEqual(principal.permissions, ["read", "send"]);
  const wake = f.service.portal.wake;
  const rows = () =>
    f.service.store.db.prepare("SELECT account,message FROM wake_queue").all();
  const input = (id, chat) => ({
    key: { id, remoteJid: chat },
    message: { conversation: "local test" },
  });
  const jid = "15551112222@s.whatsapp.net";
  const cfg = {
    url: "https://agent.example.test/inbox",
    contacts: [],
    mode: "new",
  };
  wake.configure(principal.tokenHash, cfg);
  const ingest = (account, id, live = true) =>
    f.service.sessions.ingest(account, input(id, jid), live);
  ingest(second, "1");
  ingest(second, "1");
  ingest(second, "2");
  ingest(other, "3");
  ingest(first, "history", false);
  assert.deepEqual(
    rows().map((r) => r.message),
    ["1"],
  );
  wake.configure(principal.tokenHash, {
    ...cfg,
    mode: "contacts",
    contacts: ["+15551112222"],
  });
  ingest(second, "4");
  assert.deepEqual(
    rows().map((r) => r.message),
    ["4"],
  );
  const received = [];
  const { Wake, signatureHeaders } = await import("../dist/wake.js");
  await new Wake(f.service.store, async (_, event) =>
    received.push(event),
  ).drain();
  assert.equal(received[0].account, second);
  assert.equal(received[0].messageId, "4");
  assert.equal(received[0].text, undefined);
  assert(
    signatureHeaders("test", "msg_1", "whsec_dGVzdA==")[
      "webhook-signature"
    ].startsWith("v1,"),
  );
  wake.configure(principal.tokenHash, null);
  ingest(second, "5");
  assert.equal(rows().length, 0);
  f.service.access.revoke(principal.tokenHash);
  assert.equal(f.service.access.resolve(principal), null);
});

test("2026 MCP serves discovery and authorized tools on the public transport", async (t) => {
  const f = await portalFixture(t),
    u = await f.register("modern@example.test");
  const key = await (
    await f.post(
      "/api/app/agents",
      { name: "Client", permissions: ["read", "send"] },
      u.cookie,
    )
  ).json();
  const version = "2026-07-28";
  for (const [method, params] of [
    ["server/discover", {}],
    ["tools/list", {}],
    ["tools/call", { name: "whatsapp_account_list", arguments: {} }],
  ]) {
    const response = await fetch(f.base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + key.token,
        "MCP-Protocol-Version": version,
        "Mcp-Method": method,
        ...(params.name ? { "Mcp-Name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert(!body.includes('"error":'), body);
    if (method === "tools/list") assert(body.includes("whatsapp_message_send"));
  }
});

test("passwords require eight characters throughout the account lifecycle", async (t) => {
  const f = await portalFixture(t);
  const account = {
    email: "length@example.test",
    name: "Length test",
    acceptedTerms: true,
  };
  const password = "abcdefgh";
  assert.equal(
    (
      await f.post("/api/app/register", {
        ...account,
        password: password.slice(1),
      })
    ).status,
    400,
  );
  const registered = await f.post("/api/app/register", {
    ...account,
    password,
  });
  assert.equal(registered.status, 201);
  const { recoveryCode } = await registered.json();
  assert.equal(
    (await f.post("/api/app/login", { email: account.email, password })).status,
    200,
  );
  const change = { email: account.email, recoveryCode, password: "87654321" };
  assert.equal(
    (
      await f.post("/api/app/recover", {
        ...change,
        password: change.password.slice(1),
      })
    ).status,
    400,
  );
  const recovered = await f.post("/api/app/recover", change);
  assert.equal(recovered.status, 200);
  const cookie = recovered.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await f.post(
        "/api/app/delete",
        { password: change.password, confirm: "ELIMINAR" },
        cookie,
      )
    ).status,
    200,
  );
});
