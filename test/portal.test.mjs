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
  assert.deepEqual(a.body, { ok: true });
  const u = await (await f.get("/api/app/me", a.cookie)).json(),
    v = await (await f.get("/api/app/me", b.cookie)).json();
  assert.notEqual(u.account.id, v.account.id);
  assert.equal(u.user.email, "a@example.test");
  assert(!JSON.stringify(u).includes("password"));
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
  assert.equal(
    (
      await f.post(
        "/api/app/agents",
        { name: "manual", permissions: ["read"] },
        a.cookie,
      )
    ).status,
    404,
  );
  const p = f.service.portal.authorizeNumbers(
    { headers: { cookie: a.cookie } },
    [u.account.id],
    "Agente",
  );
  const id = p.tokenHash;
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

  assert.equal(
    (await f.post("/api/app/agents/revoke", { id }, b.cookie)).status,
    400,
  );
  assert.equal(
    (await f.post("/api/app/agents/revoke", { id }, a.cookie)).status,
    200,
  );
  assert.equal(f.service.access.resolve(p), null);
});
test("retired recovery endpoint rejects requests and deletion removes own local data only", async (t) => {
  const f = await portalFixture(t),
    a = await f.register("recovery@example.test"),
    b = await f.register("other@example.test");
  const me = await (await f.get("/api/app/me", a.cookie)).json(),
    cookie = a.cookie;
  assert.equal((await f.post("/api/app/recover", {})).status, 404);
  const deletion = await f.post(
    "/api/app/delete",
    { password: "long-fictional-password-123", confirm: "ELIMINAR" },
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
  const me = await (await f.get("/api/app/me", u.cookie)).json();
  const key = f.service.access.issue(me.account.id, ["read", "send"]);
  const version = "2026-07-28";
  for (const [method, params] of [
    ["server/discover", {}],
    ["events/list", {}],
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
    if (method === "server/discover") {
      assert.match(body, /"events":\{\}/);
      assert.ok(body.includes("io.modelcontextprotocol/events"));
    }
    if (method === "events/list")
      assert.match(body, /whatsapp.message.received/);
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
  assert.deepEqual(await registered.json(), { ok: true });
  assert.equal(
    (await f.post("/api/app/login", { email: account.email, password })).status,
    200,
  );
  const cookie = registered.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await f.post("/api/app/delete", { password, confirm: "ELIMINAR" }, cookie))
      .status,
    200,
  );
});

test("password changes rotate browser sessions; receipt preferences stay per tenant and per number", async (t) => {
  const f = await portalFixture(t),
    email = "settings@example.test",
    current = "long-fictional-password-123";
  const a = await f.register(email),
    b = await f.register("other@example.test");
  const me = async (cookie) => (await f.get("/api/app/me", cookie)).json();
  const first = (await me(a.cookie)).account.id,
    second = (
      await (await f.post("/api/app/numbers", { label: "B" }, a.cookie)).json()
    ).id;
  const pref = (id, cookie, enabled) =>
    f.post("/api/app/numbers/read-receipts", { account: id, enabled }, cookie);
  assert.equal((await pref(first, b.cookie, true)).status, 400);
  assert.equal((await pref(second, a.cookie, true)).status, 200);
  assert.deepEqual(
    (await me(a.cookie)).numbers.map((n) => n.readReceipts),
    [false, true],
  );
  const change = (old, password) =>
    f.post("/api/app/password", { current: old, password }, a.cookie);
  assert.equal((await change("incorrecta", "ocho1234")).status, 400);
  assert.equal((await change(current, "short")).status, 400);
  const oldSession = (
    await f.post("/api/app/login", { email, password: current })
  ).headers
    .get("set-cookie")
    .split(";")[0];
  const changed = await change(current, "ocho1234");
  assert.equal(changed.status, 200);
  for (const cookie of [a.cookie, oldSession])
    assert.equal((await f.get("/api/app/me", cookie)).status, 401);
  assert.equal(
    (
      await f.get(
        "/api/app/me",
        changed.headers.get("set-cookie").split(";")[0],
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.post("/api/app/login", { email, password: current })).status,
    400,
  );
  assert.equal(
    (await f.post("/api/app/login", { email, password: "ocho1234" })).status,
    200,
  );
});

test("completed reconnection replaces earlier grants within the company, including a narrower set of numbers", async (t) => {
  const f = await portalFixture(t),
    a = await f.register("agent@example.test"),
    b = await f.register("different@example.test");
  const me = async (c) => (await f.get("/api/app/me", c)).json();
  const first = (await me(a.cookie)).account.id,
    other = (await me(b.cookie)).account.id,
    second = (
      await (await f.post("/api/app/numbers", { label: "B" }, a.cookie)).json()
    ).id;
  const start = (cookie, ids) =>
    f.service.portal.authorizeNumbers(
      { headers: { cookie } },
      ids,
      "ChatGPT",
      0,
      true,
    );
  const activate = (p, days) =>
    f.service.portal.activateConnection(
      p,
      {
        connection: "real-client",
        provider: "openai",
        permissions: ["read", "send"],
      },
      days ? Math.floor(Date.now() / 1000) + days * 86400 : 0,
      false,
    );
  const x = start(a.cookie, [first, second]),
    y = start(b.cookie, [other]);
  assert.equal((await me(a.cookie)).agents.length, 0);
  activate(x, 30);
  activate(y, 90);
  const narrow = start(a.cookie, [second]);
  assert(f.service.access.resolve(x));
  activate(narrow, 0);
  assert.equal(f.service.access.resolve(x), null);
  assert(f.service.access.resolve(y));
  const agents = (await me(a.cookie)).agents;
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "Dot / ChatGPT");
  assert.equal(agents[0].expiresAt, 0);
  assert.deepEqual(agents[0].numberIds, [second]);
  assert.equal(
    (await f.post("/api/app/agents/revoke", { id: agents[0].id }, a.cookie))
      .status,
    200,
  );
  assert.equal(f.service.access.resolve(narrow), null);
  assert(f.service.access.resolve(y));
});

test("MCP events verify callbacks, preserve filters and ownership, sign delivery and stop on revoke", async (t) => {
  const f = await portalFixture(t),
    a = await f.register("events@example.test"),
    b = await f.register("other-events@example.test");
  const account = async (u) =>
    (await (await f.get("/api/app/me", u.cookie)).json()).account.id;
  const n = await account(a),
    other = await account(b);
  const p = f.service.portal.authorizeNumbers(
    { headers: { cookie: a.cookie } },
    [n],
    "Dot",
  );
  const foreign = f.service.portal.authorizeNumbers(
    { headers: { cookie: b.cookie } },
    [other],
    "Dot",
  );
  const events = f.service.portal.events,
    calls = [];
  await events.stop();
  const { createHmac, randomBytes } = await import("node:crypto");
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const params = {
    name: "whatsapp.message.received",
    arguments: { account: n, contact: "+15555550001" },
    delivery: {
      url: "https://agent.example.test/callback",
      mode: "webhook",
      secret,
    },
    ttlMs: 100000,
  };
  events.post = async (url, body, headers) => {
    const data = JSON.parse(body);
    calls.push(data);
    const signed = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(
        headers["webhook-id"] + "." + headers["webhook-timestamp"] + "." + body,
      )
      .digest("base64");
    assert.equal(headers["webhook-signature"], "v1," + signed);
    assert(headers["X-MCP-Subscription-Id"]);
    return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
  };
  await assert.rejects(() =>
    events.handle("events/subscribe", params, foreign),
  );
  const accepted = await events.handle("events/subscribe", params, p),
    refresh = await events.handle("events/subscribe", params, p);
  assert.equal(accepted.id, refresh.id);
  assert.equal(calls.length, 1);
  const incoming = (id) => ({
    key: {
      id,
      remoteJid:
        id === "no"
          ? "15555550002@s.whatsapp.net"
          : "15555550001@s.whatsapp.net",
    },
    messageTimestamp: 1700000000,
    message: { conversation: "fixture" },
  });
  f.service.sessions.ingest(n, incoming("no"), true);
  f.service.sessions.ingest(n, incoming("yes"), true);
  f.service.sessions.ingest(n, incoming("yes"), true);
  f.service.sessions.ingest(other, incoming("other"), true);
  await events.drain();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.messageId, "yes");
  assert(!JSON.stringify(calls[1]).includes("fixture"));
  assert.equal(events.status([p.tokenHash]).count, 1);
  const realPost = events.post;
  events.post = async () => ({ status: 410, body: "" });
  f.service.sessions.ingest(n, incoming("skip"), true);
  await events.drain();
  assert.equal(events.status([p.tokenHash]).count, 1);
  events.post = realPost;
  await events.handle(
    "events/unsubscribe",
    { ...params, delivery: { url: params.delivery.url } },
    p,
  );

  await events.handle("events/unsubscribe", params, p);
  assert.equal(events.status([p.tokenHash]).count, 0);
  const post = events.post;
  events.post = async () => ({ status: 200, body: '{"challenge":"wrong"}' });
  await assert.rejects(
    () => events.handle("events/subscribe", params, p),
    (e) => e.code === -32015,
  );
  await assert.rejects(
    () => events.handle("events/subscribe", params, p, true),
    (e) => e.code === -32027,
  );
  events.post = post;
  await events.handle("events/subscribe", params, p);
  f.service.sessions.ingest(n, incoming("late"), true);
  f.service.access.revoke(p.tokenHash);
  await events.drain();
  assert.equal(calls.length, 3);
});

test("legacy MCP initialization advertises events and exposes the authenticated event catalog", async (t) => {
  const f = await portalFixture(t),
    u = await f.register("event-legacy@example.test");
  const me = await (await f.get("/api/app/me", u.cookie)).json(),
    key = f.service.access.issue(me.account.id, ["read"]);
  const invoke = async (method, params) => {
    const res = await fetch(f.base + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return res.json();
  };
  const hello = await invoke("initialize", {
    protocolVersion: "2025-03-26",
    clientInfo: { name: "test", version: "1" },
    capabilities: {},
  });
  assert.deepEqual(hello.result.capabilities.events, {});
  assert.equal(
    (await invoke("events/list", {})).result.events[0].name,
    "whatsapp.message.received",
  );
  assert.equal(
    (await invoke("events/subscribe", { name: "invalid" })).error.code,
    -32602,
  );
});

test("downscoping a company connection removes its active read subscriptions", async (t) => {
  const f = await portalFixture(t),
    u = await f.register("narrow-events@example.test");
  const { account } = await (await f.get("/api/app/me", u.cookie)).json(),
    p = f.service.portal.authorizeNumbers(
      { headers: { cookie: u.cookie } },
      [account.id],
      "Dot",
    );
  const info = {
    connection: "provider-and-client",
    provider: "openai",
    permissions: ["read", "send"],
  };
  f.service.portal.activateConnection(p, info, 0, false);
  const events = f.service.portal.events;
  events.post = async (_url, b) => ({
    status: 200,
    body: JSON.stringify({ challenge: JSON.parse(b).challenge }),
  });
  await events.handle(
    "events/subscribe",
    {
      name: "whatsapp.message.received",
      arguments: { account: account.id },
      delivery: {
        mode: "webhook",
        url: "https://example.test/cb",
        secret: "whsec_" + Buffer.alloc(32, 3).toString("base64"),
      },
    },
    p,
  );
  assert.equal(events.status([p.tokenHash]).count, 1);
  f.service.portal.activateConnection(
    p,
    { ...info, permissions: ["send"] },
    0,
    true,
  );
  assert.equal(events.status([p.tokenHash]).count, 0);
  assert.deepEqual(f.service.access.resolve(p).permissions, ["send"]);
});

test("agent consent survives parallel tabs and login in a second browser, with one decision per request", async (t) => {
  const f = await portalFixture(t);
  const origin = f.service.config.publicUrl;
  const user = await f.register("agent-consent@example.test");
  const primary = (await (await f.get("/api/app/me", user.cookie)).json())
    .account.id;
  const second = (
    await (
      await f.post("/api/app/numbers", { label: "Second" }, user.cookie)
    ).json()
  ).id;
  const field = (html, name) =>
    html.match(new RegExp('name="' + name + '" value="([^"]+)"'))[1];

  async function review(response) {
    assert.equal(response.status, 200);
    const html = await response.text();
    return {
      id: field(html, "request"),
      proof: field(html, "proof"),
      cookie: response.headers.get("set-cookie").split(";")[0],
    };
  }
  async function begin(name) {
    const callback = "https://" + name.toLowerCase() + ".example.test/callback";
    const reg = await f.post("/register", {
      client_name: name,
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    });
    assert.equal(reg.status, 201);
    const client = await reg.json();
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: callback,
      state: name,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
    });
    return review(await f.get("/authorize?" + query));
  }
  async function browserReturn(response) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("cache-control"), /no-store/);
    const page = await response.text();
    const automatic = page.match(
      /http-equiv="refresh" content="0;url=([^"]+)"/,
    )[1];
    const manual = page.match(/href="([^"]+)">Volver al agente</)[1];
    assert.equal(manual, automatic);
    return new URL(automatic.replaceAll("&amp;", "&"));
  }
  function accept(flow, cookie, number, decision = "approve") {
    return fetch(f.base + "/oauth/consent", {
      method: "POST",
      redirect: "manual",
      headers: {
        origin,
        accept: "text/html",
        cookie: user.cookie + "; " + cookie,
      },
      body: new URLSearchParams({
        decision,
        request: flow.id,
        proof: flow.proof,
        company: "yes",
        number,
        send: "yes",
      }),
    });
  }

  const [grok, initialMuse] = await Promise.all([begin("Grok"), begin("Muse")]);
  assert.notEqual(grok.cookie.split("=")[0], initialMuse.cookie.split("=")[0]);
  const muse = await review(
    await f.get("/oauth/choose?request=" + initialMuse.id, user.cookie),
  );
  assert.equal(muse.id, initialMuse.id);
  assert.notEqual(muse.proof, initialMuse.proof);
  const browser = [grok.cookie, muse.cookie].join("; ");
  const mismatch = await accept(initialMuse, browser, second);
  assert.equal(mismatch.status, 400);
  assert((await mismatch.text()).includes("Revisar permisos"));
  for (const [name, flow, number] of [
    ["Grok", grok, primary],
    ["Muse", muse, second],
  ]) {
    const response = await accept(flow, browser, number);
    const redirect = await browserReturn(response);
    assert.equal(redirect.hostname, name.toLowerCase() + ".example.test");
    assert.equal(redirect.searchParams.get("state"), name);
    assert(redirect.searchParams.get("code"));
    assert.equal(
      response.headers.get("set-cookie").split("=")[0],
      flow.cookie.split("=")[0],
    );
    assert.equal((await accept(flow, browser, number)).status, 400);
  }
  assert.equal(
    (await accept(initialMuse, initialMuse.cookie, second)).status,
    400,
  );
  const cursor = await begin("Cursor");
  const cancelled = await browserReturn(
    await accept(cursor, cursor.cookie, primary, "cancel"),
  );
  assert.equal(cancelled.host, "cursor.example.test");
  assert.equal(cancelled.searchParams.get("error"), "access_denied");
  assert.equal(cancelled.searchParams.get("state"), "Cursor");
  assert.equal(cancelled.searchParams.has("code"), false);
  const expired = await begin("Muse");
  f.service.oauth.store.db
    .prepare("UPDATE records SET expires=1 WHERE kind='pending' AND id=?")
    .run(expired.id);
  const response = await accept(expired, expired.cookie, second);
  assert.equal(response.status, 400);
  assert((await response.text()).includes("Esta solicitud ya terminó"));
});

test("Cursor automation wakes use the saved webhook key, preserve filters and isolate credentials", async (t) => {
  const { randomBytes, randomUUID } = await import("node:crypto");
  const { Wake, deliverWake } = await import("../dist/wake.js");
  const f = await portalFixture(t);
  const user = await f.register("cursor@example.test"),
    otherUser = await f.register("second@example.test");
  const me = async () => (await f.get("/api/app/me", user.cookie)).json();
  const account = (await me()).account.id;
  const p = f.service.portal.authorizeNumbers(
    { headers: { cookie: user.cookie } },
    [account],
    "Cursor",
    0,
    true,
  );
  f.service.portal.activateConnection(
    p,
    { connection: "cursor-test", permissions: ["read", "send"] },
    0,
    false,
  );
  const id = (await me()).agents[0].id;
  const url = "https://api2.cursor.sh/automations/webhook/" + randomUUID();
  const token = randomBytes(32).toString("base64url");
  const set = (settings, cookie = user.cookie) =>
    f.post("/api/app/agents/wake", { id, settings }, cookie);
  const data = { mode: "all", contacts: [], url };
  assert.equal((await set(data)).status, 400);
  assert.equal(
    (await set({ ...data, cursorKey: "Bearer key\r\nX-Other: test" })).status,
    400,
  );
  assert.equal(
    (await set({ ...data, cursorKey: token }, otherUser.cookie)).status,
    400,
  );
  assert.equal(
    (await set({ ...data, cursorKey: "Authorization: Bearer " + token }))
      .status,
    200,
  );
  const config = (await me()).agents[0].wake;
  assert.deepEqual(config, {
    mode: "all",
    contacts: [],
    host: "api2.cursor.sh",
    hasCursorKey: true,
  });
  const contact = "+15555551234";
  assert.equal(
    (await set({ mode: "contacts", contacts: [contact] })).status,
    200,
  );
  assert.equal((await set({ ...data, url: url + "-other" })).status, 400);
  assert.equal(
    (
      await set({
        ...data,
        url: "https://example.test/agent",
        cursorKey: token,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await set({
        ...data,
        url: "https://api2.cursor.sh/another/path",
        cursorKey: token,
      })
    ).status,
    400,
  );
  await f.service.portal.wake.stop();
  const calls = [];
  const post = async (to, body, headers) => {
    calls.push({ to, body, headers });
    return { status: calls.length === 1 ? 503 : 200, body: "" };
  };
  const worker = new Wake(f.service.store, (settings, event) =>
    deliverWake(settings, event, post),
  );
  const ingest = (number, message) =>
    f.service.sessions.ingest(
      account,
      {
        key: { id: message, remoteJid: number + "@s.whatsapp.net" },
        message: { conversation: "contenido privado de prueba" },
      },
      true,
    );
  ingest("15555550011", "filtered");
  ingest(contact.slice(1), "accepted");
  ingest(contact.slice(1), "accepted");
  await worker.drain();
  f.service.store.db.prepare("UPDATE wake_queue SET due=0").run();
  await worker.drain();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  const event = JSON.parse(calls[0].body),
    headers = calls[0].headers;
  assert.deepEqual(headers, {
    Authorization: "Bearer " + token,
    "Idempotency-Key": event.eventId,
  });
  assert.equal(calls[0].to, url);
  assert.equal(event.account, account);
  assert.equal(event.messageId, "accepted");
  assert.match(event.context, /MCP/);
  assert(!calls[0].body.includes("contenido privado"));
  assert.equal(
    (await set({ ...data, url: "https://example.test/generic" })).status,
    200,
  );
  ingest(contact.slice(1), "generic");
  await worker.drain();
  assert.equal(calls[2].headers.Authorization, undefined);
  assert.equal((await set(null)).status, 200);
  ingest(contact.slice(1), "off");
  await worker.drain();
  assert.equal(calls.length, 3);
});
