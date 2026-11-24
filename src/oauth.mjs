import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import express from "express";
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const SCOPES = ["whatsapp:read", "whatsapp:send", "whatsapp:manage"];
const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString("base64url");
export const digest = (s) => createHash("sha256").update(s).digest("hex");
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const consentLifetime = 30 * 60;
const legacyConsentCookie = "__Host-wa-mcp-oauth";
const consentCookie = (id) => legacyConsentCookie + "-" + id;
const consentCookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
};

function browserCookie(req, name) {
  return (req.headers.cookie ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
}

function formProof(pending, cookie) {
  return createHmac("sha256", pending.formKey)
    .update(cookie)
    .digest("base64url");
}

function matchesConsentBrowser(req, id, pending) {
  if (!pending.formKey) {
    // Accept forms rendered just before an upgrade until their original expiry.
    const cookie = browserCookie(req, legacyConsentCookie);
    return !!cookie && digest(cookie) === pending.csrf;
  }
  const cookie = browserCookie(req, consentCookie(id));
  const proof = req.body.proof;
  if (
    !cookie ||
    typeof proof !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(proof)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(proof),
    Buffer.from(formProof(pending, cookie)),
  );
}

class Store {
  constructor(file, secret) {
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "whatsapp-mcp-oauth", "database-v1", 32),
    );
    this.db = new DatabaseSync(file);
    if (file !== ":memory:" && process.platform !== "win32")
      chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,data TEXT,expires INTEGER,PRIMARY KEY(kind,id))",
    );
  }
  get(kind, id) {
    const r = this.db
      .prepare("SELECT data,expires FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    if (!r || (r.expires && r.expires <= now())) return undefined;
    const b = Buffer.from(r.data, "base64");
    const dec = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    dec.setAAD(Buffer.from(`${kind}:${id}`));
    dec.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([dec.update(b.subarray(28)), dec.final()]).toString(),
    );
  }
  set(kind, id, data, expires = 0) {
    const iv = randomBytes(12),
      enc = createCipheriv("aes-256-gcm", this.key, iv);
    enc.setAAD(Buffer.from(`${kind}:${id}`));
    const encrypted = Buffer.concat([
      enc.update(JSON.stringify(data)),
      enc.final(),
    ]);
    const value = Buffer.concat([iv, enc.getAuthTag(), encrypted]).toString(
      "base64",
    );
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?)")
      .run(kind, id, value, expires);
  }
  delete(kind, id) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  clean() {
    this.db
      .prepare("DELETE FROM records WHERE expires>0 AND expires<?")
      .run(now());
  }
}

export function createOAuth({
  config,
  companyNumbers,
  authorizeNumbers,
  revokeCompany,
  activateConnection,
  resolvePrincipal,
  storePath,
}) {
  const ORIGIN = config.publicUrl;
  const RESOURCE = ORIGIN + "/mcp";
  const issuer = new URL(ORIGIN);
  const challenge = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="${SCOPES.join(" ")}"`;
  const store = new Store(storePath, config.masterKey);
  function connectionInfo(client, uri, resource, scopes) {
    const url = uri && new URL(uri);
    const provider =
      url?.protocol === "https:" &&
      {
        "chatgpt.com": "openai",
        "chat.openai.com": "openai",
        "claude.ai": "claude",
        "grok.com": "grok",
        "muse.ai": "muse",
      }[url.hostname];
    const identity =
      provider === "openai"
        ? [provider, url.port, url.pathname, url.search]
        : [client.client_id, uri];
    return {
      permissions: scopes.map((s) => s.split(":")[1]),
      provider: provider || undefined,
      connection: digest(JSON.stringify([identity, resource])),
    };
  }
  if (activateConnection) {
    for (const { id } of store.db
      .prepare(
        "SELECT id FROM records WHERE kind='grant' AND (expires=0 OR expires>?)",
      )
      .all(now())) {
      const grant = store.get("grant", id);
      if (grant?.revoked || !grant?.principal.accountIds) continue;
      const client = store.get("client", grant.clientId);
      if (!client) continue;
      const uri =
        grant.redirectUri ??
        (client.redirect_uris.length === 1
          ? client.redirect_uris[0]
          : undefined);
      activateConnection(
        grant.principal,
        connectionInfo(client, uri, grant.resource, grant.scopes),
        grant.expires,
        true,
      );
    }
  }
  const resourceOk = (resource) =>
    !resource || [RESOURCE, ORIGIN + "/mcp/code"].includes(resource.href);
  const getGrant = (kind, token, client) => {
    const record = store.get(kind, digest(token));
    if (!record || (client && record.clientId !== client.client_id))
      throw new InvalidGrantError("Invalid or expired grant");
    const grant = store.get("grant", record.grantId);
    if (!grant || grant.revoked)
      throw new InvalidGrantError("Grant has been revoked");
    return { record, grant };
  };
  const issue = (grantId, grant) => {
    const access = random(),
      refresh = random();
    const lifetime = grant.expires
      ? Math.min(3600, grant.expires - now())
      : 3600;
    store.set(
      "access",
      digest(access),
      { grantId, clientId: grant.clientId },
      now() + lifetime,
    );
    store.set(
      "refresh",
      digest(refresh),
      { grantId, clientId: grant.clientId },
      grant.expires,
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: lifetime,
      refresh_token: refresh,
      scope: grant.scopes.join(" "),
    };
  };
  const provider = {
    clientsStore: {
      getClient(id) {
        return store.get("client", id);
      },
      registerClient(client) {
        if (!client.redirect_uris?.length || client.redirect_uris.length > 10)
          throw new InvalidClientMetadataError("Specify valid redirect URIs");
        for (const uri of client.redirect_uris) {
          const u = new URL(uri);
          const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
            u.hostname,
          );
          if (
            (u.protocol !== "https:" &&
              !(u.protocol === "http:" && loopback)) ||
            u.username ||
            u.password ||
            u.hash
          )
            throw new InvalidClientMetadataError(
              "Redirect URIs must use HTTPS or HTTP on loopback",
            );
        }
        if (
          !["none", "client_secret_post"].includes(
            client.token_endpoint_auth_method ?? "client_secret_post",
          )
        )
          throw new InvalidClientMetadataError(
            "Unsupported client authentication",
          );
        const value = {
          ...client,
          client_id: client.client_id ?? randomUUID(),
          client_id_issued_at: client.client_id_issued_at ?? now(),
        };
        store.set("client", value.client_id, value);
        return value;
      },
    },
    async authorize(client, params, res) {
      if (!resourceOk(params.resource))
        throw new InvalidTargetError("Wrong resource");
      if (params.scopes?.some((x) => !SCOPES.includes(x)))
        throw new InvalidScopeError("Unsupported scope");
      startConsent(res, client, {
        ...params,
        resource: params.resource?.href ?? RESOURCE,
        scopes: params.scopes?.length ? params.scopes : SCOPES,
      });
    },
    async challengeForAuthorizationCode(client, code) {
      const r = store.get("code", digest(code));
      if (!r || r.clientId !== client.client_id)
        throw new InvalidGrantError("Invalid authorization code");
      return r.challenge;
    },
    async exchangeAuthorizationCode(
      client,
      code,
      _verifier,
      redirectUri,
      resource,
    ) {
      if (!resourceOk(resource)) throw new InvalidTargetError("Wrong resource");
      const pendingCode = store.get("code", digest(code));
      if (!pendingCode || !(await resolvePrincipal(pendingCode.principal)))
        throw new InvalidGrantError("Credential revoked or expired");
      const { grant, tokens } = store.transaction(() => {
        const r = store.get("code", digest(code));
        if (
          !r ||
          r.clientId !== client.client_id ||
          r.redirectUri !== redirectUri ||
          (resource && resource.href !== r.resource)
        )
          throw new InvalidGrantError("Invalid authorization code or redirect");
        store.delete("code", digest(code));
        const grantId = randomUUID(),
          grant = {
            clientId: client.client_id,
            principal: r.principal,
            scopes: r.scopes,
            resource: r.resource ?? RESOURCE,
            expires: r.expires ?? now() + 30 * 86400,
            redirectUri: r.redirectUri,
            revoked: false,
          };
        store.set("grant", grantId, grant, grant.expires);
        return { grant, tokens: issue(grantId, grant) };
      });
      activateConnection?.(
        grant.principal,
        connectionInfo(client, grant.redirectUri, grant.resource, grant.scopes),
        grant.expires,
        false,
      );
      return tokens;
    },
    async exchangeRefreshToken(client, token, scopes, resource) {
      if (!resourceOk(resource)) throw new InvalidTargetError("Wrong resource");
      const current = getGrant("refresh", token, client);
      if (!(await resolvePrincipal(current.grant.principal)))
        throw new InvalidGrantError("Credential revoked or expired");
      return store.transaction(() => {
        const { record, grant } = getGrant("refresh", token, client);
        if (resource && resource.href !== grant.resource)
          throw new InvalidTargetError("Wrong resource");
        if (scopes?.some((s) => !grant.scopes.includes(s)))
          throw new InvalidScopeError("Cannot expand scopes");
        if (scopes?.length) {
          grant.scopes = scopes;
          activateConnection?.(
            grant.principal,
            connectionInfo(client, grant.redirectUri, grant.resource, scopes),
            grant.expires,
            true,
          );
        }
        store.delete("refresh", digest(token));
        store.set("grant", record.grantId, grant, grant.expires);
        return issue(record.grantId, grant);
      });
    },
    async verifyAccessToken(token) {
      try {
        const { record, grant } = getGrant("access", token);
        const auth = await resolvePrincipal(grant.principal);
        if (!auth)
          throw new InvalidTokenError(
            "Account credential changed or was removed",
          );
        return {
          principal: auth,
          scopes: grant.scopes,
          resource: grant.resource,
          clientId: record.clientId,
        };
      } catch {
        throw new InvalidTokenError("Invalid or expired access token");
      }
    },
    async revokeToken(client, request) {
      try {
        const kind =
          request.token_type_hint === "refresh_token" ? "refresh" : "access";
        let r = store.get(kind, digest(request.token));
        if (!r)
          r = store.get(
            kind === "access" ? "refresh" : "access",
            digest(request.token),
          );
        if (r?.clientId === client.client_id) {
          const grant = store.get("grant", r.grantId);
          if (grant) {
            if (grant.principal?.accountIds)
              revokeCompany?.(grant.principal.tokenHash);
            grant.revoked = true;
            store.set("grant", r.grantId, grant, grant.expires);
          }
        }
      } catch {}
    },
  };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  function startConsent(res, client, params) {
    const id = random();
    const pending = { clientId: client.client_id, params, formKey: random() };
    store.clean();
    store.set("pending", id, pending, now() + consentLifetime);
    showConsent(res, id, client, pending);
  }
  function showConsent(res, id, client, pending, error = "") {
    let proof = "";
    if (pending.formKey) {
      // Each browser reviews its own form, even when login opens outside the agent.
      let cookie = browserCookie(res.req, consentCookie(id));
      if (!cookie) {
        cookie = random();
        res.cookie(consentCookie(id), cookie, {
          ...consentCookieOptions,
          maxAge: consentLifetime * 1000,
        });
      }
      proof = formProof(pending, cookie);
    }
    let numbers;
    try {
      numbers = companyNumbers(res.req);
    } catch {}
    consentPage(res, id, client, pending, error, numbers, proof);
  }
  app.get("/oauth/choose", (req, res) => {
    const id = String(req.query.request ?? ""),
      pending = store.get("pending", id);
    if (!pending) return consentProblem(res);
    const client = store.get("client", pending.clientId);
    showConsent(res, id, client, pending);
  });
  app.use("/authorize", (_req, res, next) => {
    const redirect = res.redirect.bind(res);
    res.redirect = (status, url) => {
      if (typeof status !== "number") {
        url = status;
        status = 302;
      }
      const target = new URL(url, ORIGIN);
      target.searchParams.set("iss", issuer.href);
      return redirect(status, target.href);
    };
    next();
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      ...createOAuthMetadata({
        provider,
        issuerUrl: issuer,
        scopesSupported: SCOPES,
      }),
      authorization_response_iss_parameter_supported: true,
    }),
  );
  app.get("/.well-known/oauth-protected-resource/mcp/code", (_req, res) =>
    res.json({
      resource: ORIGIN + "/mcp/code",
      authorization_servers: [issuer.href],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
    }),
  );
  app.get("/.well-known/oauth-protected-resource", (_req, res) =>
    res.redirect("/.well-known/oauth-protected-resource/mcp"),
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: new URL(RESOURCE),
      scopesSupported: SCOPES,
      resourceName: "Essoria WhatsApp",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  function finishConsent(res, id, pending, result) {
    const redirect = new URL(pending.params.redirectUri);
    for (const [key, value] of Object.entries(result))
      redirect.searchParams.set(key, value);
    redirect.searchParams.set("iss", issuer.href);
    if (pending.params.state)
      redirect.searchParams.set("state", pending.params.state);
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; form-action 'self' ${redirect.origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.clearCookie(
      pending.formKey ? consentCookie(id) : legacyConsentCookie,
      consentCookieOptions,
    );
    res.redirect(303, redirect.href);
  }
  const attempts = new Map();
  app.post(
    "/oauth/consent",
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      res.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      if (req.headers.origin !== ORIGIN)
        return res.status(403).send("Invalid origin");
      const ip = req.ip,
        id = String(req.body.request ?? "");
      const pending = store.get("pending", id);
      if (!pending) return consentProblem(res);
      if (!matchesConsentBrowser(req, id, pending))
        return consentProblem(res, pending.formKey ? id : undefined);
      const client = store.get("client", pending.clientId);
      if (!client) return res.status(400).send("Client is not registered.");
      if (req.body.decision === "cancel") {
        store.delete("pending", id);
        return finishConsent(res, id, pending, { error: "access_denied" });
      }
      const count = attempts.get(ip);
      if (count && count.until > Date.now() && count.count >= 10)
        return res.status(429).send("Too many attempts. Wait 15 minutes.");
      const duration = req.body.duration ?? "30";
      if (!["30", "60", "90", "indefinite"].includes(duration))
        return res.status(400).send("Selecciona una duración válida.");
      const days = duration === "indefinite" ? 0 : Number(duration);
      let principal;
      try {
        if (req.body.company === "yes") {
          const ids = [
            ...new Set(
              [req.body.number].flat().filter((v) => typeof v === "string"),
            ),
          ];
          principal = await authorizeNumbers(
            req,
            ids,
            String(client.client_name ?? "Agente MCP").slice(0, 60),
            days,
          );
        }
      } catch {}
      if (!principal) {
        const c =
          count && count.until > Date.now()
            ? count
            : { count: 0, until: Date.now() + 900000 };
        c.count++;
        attempts.set(ip, c);
        return showConsent(
          res.status(401),
          id,
          client,
          pending,
          "Inicia sesión y selecciona al menos una instancia.",
        );
      }
      let scopes = pending.params.scopes.filter(
        (s) =>
          s === "whatsapp:read" ||
          (s === "whatsapp:send" && req.body.send === "yes") ||
          (s === "whatsapp:manage" && req.body.manage === "yes"),
      );
      scopes = scopes.filter((s) =>
        principal.permissions.includes(s.split(":")[1]),
      );
      if (!scopes.includes("whatsapp:read")) scopes.unshift("whatsapp:read");
      const code = random();
      const issued = store.transaction(() => {
        if (!store.get("pending", id)) return false;
        store.set(
          "code",
          digest(code),
          {
            clientId: client.client_id,
            principal,
            scopes,
            expires: days ? now() + days * 86400 : 0,
            challenge: pending.params.codeChallenge,
            redirectUri: pending.params.redirectUri,
            resource: pending.params.resource,
          },
          now() + 120,
        );
        store.delete("pending", id);
        return true;
      });
      if (!issued) {
        if (principal.tokenHash) revokeCompany?.(principal.tokenHash);
        return consentProblem(res);
      }
      finishConsent(res, id, pending, { code });
    },
  );
  return { app, provider, store, challenge, resource: RESOURCE };
}

function consentProblem(res, retryId) {
  const title = retryId
    ? "Vuelve a revisar los permisos"
    : "Esta solicitud ya terminó";
  const detail = retryId
    ? "Abre el formulario en este navegador para elegir los números que quieres compartir."
    : "Si tu agente sigue esperando, vuelve a él y elige conectar Essoria de nuevo.";
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  return res.status(400).type("html")
    .send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Essoria</title>
    <link rel="stylesheet" href="/assets/consent.css"></head><body><main>
    <img class="brand" src="/assets/brand/essoria/logo-horizontal-dark.png" width="130" alt="Essoria">
    <section><h1>${title}</h1><p>${detail}</p>${retryId ? `<footer><a class="primary" href="/oauth/choose?request=${encodeURIComponent(retryId)}">Revisar permisos</a></footer>` : ""}</section></main></body></html>`);
}

function numberOption(account, index, count) {
  const phone = /^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/.exec(
    account.selfJid ?? "",
  )?.[1];
  const name =
    account.label ||
    (/^(Cuenta-|WA-)/.test(account.name)
      ? index === 0
        ? "Número principal"
        : "Número " + (index + 1)
      : account.name);
  return `<label class="number">
    <input type="checkbox" name="number" value="${escape(account.id)}" ${count === 1 ? "checked" : ""}>
    <span class="number-info"><strong>${escape(name)}</strong><span>${phone ? "+" + phone : "Sin teléfono vinculado"}</span></span>
  </label>`;
}

function consentPage(res, id, client, pending, error, numbers, proof) {
  const callback = new URL(pending.params.redirectUri);
  const canSend = pending.params.scopes.includes("whatsapp:send");
  const clientName = escape(client.client_name || "tu agente");
  res.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'; form-action 'self' ${callback.origin}; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.type("html")
    .send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0a1b1d">
    <title>Conectar ${clientName} · Essoria</title><link rel="icon" href="/assets/brand/essoria/favicon-32.png">
    <link rel="stylesheet" href="/assets/consent.css"><script defer src="/assets/consent.js"></script></head>
    <body><main>
      <img class="brand" src="/assets/brand/essoria/logo-horizontal-dark.png" width="130" alt="Essoria">
      <section aria-labelledby="title">
        <header><h1 id="title">Conectar ${clientName}</h1>
        <p>${numbers ? "Elige los números de WhatsApp que podrá usar." : "Inicia sesión en Essoria para elegir qué números de WhatsApp quieres compartir."}</p></header>
        <form method="post" action="/oauth/consent">
          <input type="hidden" name="request" value="${escape(id)}">
          ${proof ? `<input type="hidden" name="proof" value="${escape(proof)}">` : ""}
          ${
            numbers
              ? `<input type="hidden" name="company" value="yes">
            ${canSend ? '<input type="hidden" name="send" value="yes">' : ""}
            <fieldset><legend>Tus números</legend>${numbers.map((a, i) => numberOption(a, i, numbers.length)).join("")}</fieldset>
            <label class="grant-duration">Duración del permiso<select name="duration"><option value="30">30 días</option><option value="60">60 días</option><option value="90">90 días</option><option value="indefinite">Indefinido · hasta que lo revoque</option></select></label>
            <div class="permission"><img src="/assets/platforms/whatsapp.svg" width="21" height="21" alt=""><div><strong>Permiso del agente</strong><p>${canSend ? "Leer y responder mensajes" : "Leer mensajes"} en los números que selecciones.</p></div></div>`
              : ""
          }
          ${error ? `<p role="alert">${escape(error)}</p>` : ""}
          <footer><div class="actions">
            <button class="cancel" type="submit" name="decision" value="cancel" formnovalidate>Cancelar</button>
            ${numbers ? '<button class="primary" id="authorize" type="submit">Autorizar conexión</button>' : `<a class="primary" href="/entrar?oauth=${encodeURIComponent(id)}">Iniciar sesión</a>`}
          </div><p class="destination">Volverás a <bdi>${escape(callback.host)}</bdi></p></footer>
        </form>
      </section></main></body></html>`);
}
