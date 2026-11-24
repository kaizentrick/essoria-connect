import { AgentEvents } from "./events.js";
import { Wake, wakeSettings } from "./wake.js";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import type { Store } from "./store.js";
import { hash } from "./store.js";
import type { Access, Principal, Permission } from "./access.js";
import type { Sessions } from "./sessions.js";
import type { Tools } from "./mcp.js";
import type { Config } from "./config.js";
import { Billing } from "./billing.js";

export type PortalOptions = {
  signupOpen: boolean;
  commercialReady: boolean;
  maxCustomers?: number;
  stripeKey?: string;
  stripeWebhook?: string;
  stripePrice?: string;
  stripeAccount?: string;
};
export const portalOptions = (env = process.env): PortalOptions => ({
  signupOpen: env.ESSORIA_SIGNUP_OPEN === "true",
  commercialReady: env.ESSORIA_COMMERCIAL_READY === "true",
  maxCustomers: Number(env.ESSORIA_MAX_CUSTOMERS ?? 25),
  stripeKey: env.ESSORIA_STRIPE_SECRET_KEY,
  stripeWebhook: env.ESSORIA_STRIPE_WEBHOOK_SECRET,
  stripePrice: env.ESSORIA_STRIPE_PRICE_ID,
  stripeAccount: env.ESSORIA_STRIPE_ACCOUNT_ID,
});
const token = () => randomBytes(32).toString("base64url");
const credentials = z.object({
  email: z
    .email()
    .max(200)
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8).max(200),
});
let hashing = 0;
const passwordHash = async (
  password: string,
  salt: string,
): Promise<Buffer> => {
  if (hashing >= 2) throw new Error("Intenta de nuevo en unos segundos.");
  hashing++;
  try {
    return await new Promise((resolve, reject) =>
      scryptCallback(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, b) =>
        e ? reject(e) : resolve(b),
      ),
    );
  } finally {
    hashing--;
  }
};
const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class Portal {
  readonly router = express.Router();
  readonly billing: Billing;
  readonly wake: Wake;
  readonly events: AgentEvents;
  private limits = new Map<string, { count: number; until: number }>();
  constructor(
    readonly store: Store,
    readonly access: Access,
    readonly sessions: Sessions,
    readonly tools: Tools,
    readonly config: Config,
    readonly options: PortalOptions = portalOptions(),
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT,salt TEXT,account TEXT UNIQUE,created INTEGER,trial_until INTEGER,stripe_customer TEXT UNIQUE,stripe_subscription TEXT,billing_state TEXT DEFAULT 'beta',paid_until INTEGER DEFAULT 0,terms_version TEXT);
  CREATE TABLE IF NOT EXISTS company_numbers(customer TEXT REFERENCES customers(id) ON DELETE CASCADE, account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS web_sessions(id TEXT PRIMARY KEY,user_id TEXT REFERENCES customers(id) ON DELETE CASCADE,expires INTEGER);
  CREATE TABLE IF NOT EXISTS billing_events(id TEXT PRIMARY KEY,processed INTEGER);
  CREATE TABLE IF NOT EXISTS billing_holds(id TEXT PRIMARY KEY,user_id TEXT REFERENCES customers(id) ON DELETE CASCADE,subscription TEXT,reason TEXT,created INTEGER);
  CREATE TABLE IF NOT EXISTS billing_checkouts(id TEXT PRIMARY KEY,user_id TEXT REFERENCES customers(id) ON DELETE CASCADE,identifier TEXT,created INTEGER);
  CREATE TABLE IF NOT EXISTS send_usage(account TEXT REFERENCES accounts(id) ON DELETE CASCADE,request_id TEXT,month TEXT,created INTEGER,PRIMARY KEY(account,request_id));
  CREATE TABLE IF NOT EXISTS support_requests(id TEXT PRIMARY KEY,email TEXT,message TEXT,created INTEGER);`);
    this.wake = new Wake(store);
    this.events = new AgentEvents(store);
    sessions.onIncoming = (a, m, n) => {
      this.wake.enqueue(a, m, n);
      this.events.enqueue(a, m, n);
    };
    // Retire manual customer keys, including grants derived from them. Preserve OAuth connections.
    if (!store.get("meta", "", "customer-oauth-only-v1"))
      store.transaction(() => {
        for (const user of store.db
          .prepare("SELECT id,account FROM customers")
          .all())
          for (const account of this.numbers(user))
            for (const key of access.tokens(account.id))
              if (
                !store.get<{ numbers?: unknown }>("access-key", "", key.id)
                  ?.numbers
              )
                access.revoke(key.id);
        if (
          store.db
            .prepare("PRAGMA table_info(customers)")
            .all()
            .some((c) => c.name === "recovery")
        )
          store.db.exec("ALTER TABLE customers DROP COLUMN recovery");
        store.put("meta", "", "customer-oauth-only-v1", true);
      });
    this.billing = new Billing(this, options);
    const route = (
      method: "get" | "post",
      path: string,
      fn: (req: Request, res: Response) => any,
    ) =>
      this.router[method](path, async (req, res) => {
        try {
          await fn(req, res);
        } catch (e) {
          res.status((e as any)?.status ?? 400).json({
            error:
              e instanceof z.ZodError
                ? "Revisa los campos obligatorios y el formato de los datos."
                : e instanceof Error
                  ? e.message
                  : "No se pudo completar la operación.",
          });
        }
      });
    this.router.post(
      "/api/billing/webhook",
      express.raw({ type: "application/json", limit: "512kb" }),
      async (req, res) => {
        try {
          await this.billing.webhook(req);
          res.json({ received: true });
        } catch {
          res.status(400).json({ error: "Webhook no válido o no configurado" });
        }
      },
    );
    this.router.use(
      "/api/app",
      express.json({ limit: "64kb" }),
      (req, res, next) => {
        if (req.method !== "GET" && req.headers.origin !== config.publicUrl)
          return void res.status(403).json({ error: "Origen no permitido" });
        next();
      },
    );
    route("get", "/api/app/config", (_req, res) =>
      res.json({
        brand: "Essoria",
        signupOpen: options.signupOpen,
        beta: true,
        billing: this.billing.publicState(),
        channels: [
          { id: "whatsapp", name: "WhatsApp", state: "beta", mode: "qr" },
          { id: "instagram", name: "Instagram", state: "planned" },
          { id: "facebook", name: "Facebook", state: "planned" },
        ],
      }),
    );
    route("post", "/api/app/contact", (req, res) => {
      this.rate(req, "contact", 5, 86400000);
      const v = z
          .object({
            email: z.email().max(200),
            message: z.string().trim().min(20).max(4000),
            consent: z.literal(true),
          })
          .strict()
          .parse(req.body),
        id = randomUUID();
      store.db
        .prepare("INSERT INTO support_requests VALUES(?,?,?,?)")
        .run(id, v.email, v.message, Date.now());
      res.status(201).json({
        id,
        message:
          "Consulta guardada para revisión. Conserva este número de referencia.",
      });
    });
    route("post", "/api/app/register", async (req, res) => {
      if (!options.signupOpen)
        throw new Error(
          "El registro está cerrado durante la preparación del servicio. Puedes consultar la guía o contactar al equipo.",
        );
      this.rate(req, "register", 5, 86400000);
      const value = credentials
          .extend({
            name: z.string().trim().min(2).max(80),
            acceptedTerms: z.literal(true),
          })
          .strict()
          .parse(req.body),
        id = randomUUID(),
        salt = token(),
        pwd = (await passwordHash(value.password, salt)).toString("hex");
      if (
        store.db
          .prepare("SELECT id FROM customers WHERE email=?")
          .get(value.email)
      )
        throw new Error(
          "No se pudo crear la cuenta. Si ya tienes acceso, inicia sesión.",
        );
      store.transaction(() => {
        const max = options.maxCustomers ?? 25;
        if (!Number.isSafeInteger(max) || max < 1 || max > 10000)
          throw new Error("La capacidad de registro está mal configurada.");
        if (
          (store.db.prepare("SELECT count(*) AS n FROM customers").get() as any)
            .n >= max
        )
          throw new Error(
            "La beta alcanzó su capacidad actual. Contacta al equipo para solicitar acceso.",
          );
        const account = store.createAccount("Cuenta-" + id.slice(0, 12));
        store.db
          .prepare(
            "INSERT INTO customers(id,email,name,password,salt,account,created,trial_until,terms_version) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            value.email,
            value.name,
            pwd,
            salt,
            account.id,
            Date.now(),
            Date.now() + 7 * 86400000,
            "2026-10-31",
          );
      });
      this.newSession(id, res);
      res.status(201).json({ ok: true });
    });
    route("post", "/api/app/login", async (req, res) => {
      this.rate(req, "login", 20, 900000);
      const v = credentials.strict().parse(req.body),
        u = store.db
          .prepare("SELECT * FROM customers WHERE email=?")
          .get(v.email) as any;
      const candidate = (
        await passwordHash(v.password, u?.salt ?? "unknown-account-placeholder")
      ).toString("hex");
      if (
        !u ||
        !safeEqual(candidate, u.password) ||
        !store.db
          .prepare("SELECT 1 FROM customers WHERE id=? AND password=?")
          .get(u.id, u.password)
      )
        throw new Error("Correo o contraseña incorrectos.");
      this.newSession(u.id, res);
      res.json({ ok: true });
    });
    route("post", "/api/app/password", async (req, res) => {
      const u = this.user(req);
      this.count("password:" + u.id, 12, 900000);
      const v = z
        .object({
          current: credentials.shape.password,
          password: credentials.shape.password,
        })
        .strict()
        .parse(req.body);
      if (
        !safeEqual(
          (await passwordHash(v.current, u.salt)).toString("hex"),
          u.password,
        )
      )
        throw new Error("La contraseña actual es incorrecta.");
      const salt = token(),
        next = (await passwordHash(v.password, salt)).toString("hex");
      store.transaction(() => {
        if (
          !store.db
            .prepare(
              "UPDATE customers SET password=?,salt=? WHERE id=? AND password=?",
            )
            .run(next, salt, u.id, u.password).changes
        )
          throw new Error("La cuenta cambió. Vuelve a iniciar sesión.");
        store.db.prepare("DELETE FROM web_sessions WHERE user_id=?").run(u.id);
        this.newSession(u.id, res);
      });
      res.json({ ok: true });
    });
    route("post", "/api/app/numbers/read-receipts", (req, res) => {
      const u = this.user(req);
      const { account, enabled } = z
        .object({ account: z.string(), enabled: z.boolean() })
        .strict()
        .parse(req.body);
      if (!this.numbers(u).some((a) => a.id === account))
        throw new Error("Número no disponible.");
      store.put("preferences", account, "read-receipts", enabled);
      res.json({ enabled });
    });
    route("post", "/api/app/logout", (req, res) => {
      const s = this.cookie(req);
      if (s)
        store.db.prepare("DELETE FROM web_sessions WHERE id=?").run(hash(s));
      res.clearCookie("essoria_session", { path: "/" });
      res.json({ ok: true });
    });
    route("post", "/api/app/numbers", (req, res) => {
      const u = this.user(req);
      const label = z.string().trim().min(1).max(64).parse(req.body.label);
      const account = store.transaction(() => {
        const a = store.createAccount("WA-" + randomUUID());
        store.updateAccount(a.id, { label });
        store.db
          .prepare("INSERT INTO company_numbers VALUES(?,?)")
          .run(u.id, a.id);
        return store.account(a.id);
      });
      res.status(201).json(account);
    });
    route("get", "/api/app/me", (req, res) => {
      const u = this.user(req);
      res.json({
        user: {
          id: u.id,
          email: u.email,
          name: u.name,
          trialUntil: u.trial_until,
        },
        account: store.account(u.account),
        numbers: this.numbers(u).map((a) => ({
          ...a,
          readReceipts:
            store.get("preferences", a.id, "read-receipts") === true,
        })),
        agents: this.agentGroups(u).map(({ members, ...agent }) => ({
          ...agent,
          events: this.events.status(members),
        })),
        billing: {
          ...this.billing.publicState(),
          state: u.billing_state,
          accessActive: this.entitled(u),
          paidUntil: u.paid_until,
          subscribed:
            !!u.stripe_subscription &&
            !["canceled", "incomplete_expired"].includes(u.billing_state),
          hasCustomer: !!u.stripe_customer,
        },
        usage: { requests: this.companyUsage(u), monthlyLimit: 1000 },
      });
    });
    route("post", "/api/app/tools", async (req, res) => {
      const u = this.user(req),
        v = z
          .object({
            name: z.enum([
              "whatsapp_account_status",
              "whatsapp_pairing_start",
              "whatsapp_pairing_get",
              "whatsapp_account_disconnect",
              "whatsapp_account_logout",
            ]),
            account: z.string().optional(),
            confirm: z.boolean().optional(),
          })
          .strict()
          .parse(req.body);
      const selected = v.account ?? u.account;
      if (!this.numbers(u).some((a) => a.id === selected))
        throw new Error("Número no disponible");
      res.json(
        await tools.execute(
          v.name,
          {
            account: selected,
            ...(v.name === "whatsapp_account_logout"
              ? { confirm: v.confirm }
              : {}),
          },
          this.principal({ ...u, account: selected }),
        ),
      );
    });
    route("post", "/api/app/agents/wake", (req, res) => {
      const u = this.user(req);
      const v = z
        .object({ id: z.string(), settings: wakeSettings.nullable() })
        .strict()
        .parse(req.body);
      const group = this.agentGroups(u).find((a) => a.id === v.id);
      if (!group) throw new Error("Conexión no disponible");
      this.wake.configure(group.id, v.settings);
      for (const member of group.members)
        if (member !== group.id && this.wake.settings(member))
          this.wake.configure(member, null);
      res.json({ ok: true });
    });
    route("post", "/api/app/agents/revoke", (req, res) => {
      const u = this.user(req),
        v = z
          .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(req.body);
      const group = this.agentGroups(u).find((a) => a.id === v.id);
      if (!group) throw new Error("Conexión no disponible.");
      store.transaction(() => {
        for (const member of group.members) access.revoke(member);
      });
      res.json({ ok: true });
    });
    route("post", "/api/app/checkout", async (req, res) => {
      const u = this.user(req);
      this.rate(req, "checkout", 10, 3600000);
      res.json({ url: await this.billing.checkout(u) });
    });
    route("post", "/api/app/billing/portal", async (req, res) =>
      res.json({ url: await this.billing.customerPortal(this.user(req)) }),
    );
    route("post", "/api/app/delete", async (req, res) => {
      const u = this.user(req),
        v = z
          .object({
            password: z.string().min(8).max(200),
            confirm: z.literal("ELIMINAR"),
          })
          .strict()
          .parse(req.body);
      if (
        !safeEqual(
          (await passwordHash(v.password, u.salt)).toString("hex"),
          u.password,
        )
      )
        throw new Error("Contraseña incorrecta.");
      await this.billing.cancelForDeletion(u);
      let remoteUnlinked = true;
      for (const a of this.numbers(u)) {
        try {
          await sessions.logout(a.id);
        } catch {
          remoteUnlinked = false;
          await sessions.disconnect(a.id).catch(() => {});
        }
        for (const k of access.tokens(a.id)) access.revoke(k.id);
        store.transaction(() => {
          for (const table of [
            "aliases",
            "contacts",
            "chats",
            "messages",
            "receipts",
          ])
            store.db.prepare(`DELETE FROM ${table} WHERE account=?`).run(a.id);
          store.db.prepare("DELETE FROM slots WHERE account=?").run(a.id);
          store.db.prepare("DELETE FROM accounts WHERE id=?").run(a.id);
        });
      }
      store.transaction(() => {
        store.db.prepare("DELETE FROM customers WHERE id=?").run(u.id);
      });
      res.clearCookie("essoria_session", { path: "/" });
      res.json({
        deleted: true,
        remoteUnlinked,
        message: remoteUnlinked
          ? "Cuenta local eliminada y dispositivo desvinculado."
          : "Cuenta local eliminada. Revisa WhatsApp → Dispositivos vinculados y elimina manualmente el dispositivo de Essoria si sigue visible.",
      });
    });
  }
  private cookie(req: Request): string | undefined {
    return req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("essoria_session="))
      ?.slice("essoria_session=".length);
  }
  private newSession(id: string, res: Response): void {
    const s = token();
    this.store.db
      .prepare("INSERT INTO web_sessions VALUES(?,?,?)")
      .run(hash(s), id, Date.now() + 7 * 86400000);
    res.cookie("essoria_session", s, {
      httpOnly: true,
      secure: this.config.publicUrl.startsWith("https:"),
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 86400000,
    });
  }
  user(req: Request): any {
    const s = this.cookie(req),
      u = s
        ? this.store.db
            .prepare(
              "SELECT c.* FROM web_sessions s JOIN customers c ON c.id=s.user_id WHERE s.id=? AND s.expires>?",
            )
            .get(hash(s), Date.now())
        : undefined;
    if (!u)
      throw Object.assign(
        new Error(
          "Tu sesión terminó. Inicia sesión de nuevo; no repetimos la acción anterior.",
        ),
        { status: 401 },
      );
    return u;
  }
  numbers(u: any) {
    return [
      this.store.account(u.account),
      ...this.store.db
        .prepare(
          "SELECT account FROM company_numbers WHERE customer=? ORDER BY rowid",
        )
        .all(u.id)
        .map((r) => this.store.account(String(r.account))),
    ];
  }
  private agentGroups(u: any) {
    const tokens = this.numbers(u)
      .flatMap((a) => this.access.tokens(a.id))
      .sort(
        (a, b) =>
          (b.expiresAt || Infinity) - (a.expiresAt || Infinity) ||
          b.createdAt - a.createdAt,
      );
    const groups = new Map<string, typeof tokens>();
    for (const token of tokens) {
      if (token.unconfirmed) continue;
      const key = JSON.stringify([
        token.connection ?? token.id,
        [...token.numberIds].sort(),
        [...token.permissions].sort(),
      ]);
      const group = groups.get(key) ?? [];
      group.push(token);
      groups.set(key, group);
    }
    return Array.from(groups.values(), (group) => {
      const first = group[0]!;
      const configured = group.find((t) => this.wake.settings(t.id));
      return {
        ...first,
        name:
          (
            {
              openai: "Dot / ChatGPT",
              claude: "Claude / Duet",
              grok: "Grok",
              muse: "Muse",
            } as Record<string, string>
          )[first.provider ?? ""] ?? first.name,
        lastUsedAt: Math.max(...group.map((t) => t.lastUsedAt ?? 0)) || null,
        wake: configured ? this.wake.settings(configured.id) : null,
        members: group.map((t) => t.id),
      };
    });
  }
  activateConnection(
    p: Principal,
    info: { connection: string; provider?: string; permissions: Permission[] },
    expires: number,
    legacy: boolean,
  ) {
    if (!p.tokenHash || !p.accountIds) return;
    const id = p.tokenHash,
      key = this.store.get("access-key", "", id);
    if (!key) return;
    if (legacy && key.connection) {
      const permissions = key.permissions.filter((v: Permission) =>
        info.permissions.includes(v),
      );
      if (permissions.length !== key.permissions.length)
        this.store.transaction(() => {
          this.store.put(
            "access-key",
            "",
            id,
            { ...key, permissions },
            expires * 1000,
          );
          if (!permissions.includes("read")) {
            this.store.remove("wake", "", id);
            this.store.db
              .prepare("DELETE FROM wake_queue WHERE connection=?")
              .run(id);
            this.store.db
              .prepare("DELETE FROM agent_subscriptions WHERE owner=?")
              .run(id);
          }
        });
      return;
    }
    this.store.transaction(() => {
      this.store.put(
        "access-key",
        "",
        id,
        { ...key, ...info, pendingOAuth: false },
        expires * 1000,
      );
      if (legacy) return;
      const customer = this.customerForAccount(p.accountId!);
      if (!customer) return;
      for (const group of this.agentGroups(customer)) {
        if (group.connection !== info.connection) continue;
        for (const other of group.members) {
          if (other === id) continue;
          const wake = this.store.get("wake", "", other);
          const sameOrNarrower = p.accountIds!.every((n) =>
            group.numberIds.includes(n),
          );
          if (wake && sameOrNarrower && !this.store.get("wake", "", id)) {
            this.store.put("wake", "", id, wake);
            this.store.db
              .prepare(
                "UPDATE OR IGNORE wake_queue SET connection=? WHERE connection=?",
              )
              .run(id, other);
          }
          this.access.revoke(other);
        }
      }
    });
  }
  authorizeNumbers(
    req: Request,
    ids: string[],
    name: string,
    days = 30,
    pending = false,
  ) {
    const u = this.user(req),
      owned = this.numbers(u);
    if (!ids.length || ids.some((id) => !owned.some((a) => a.id === id)))
      throw new Error("Selecciona números de tu empresa");
    const issued = this.access.issue(
      ids[0]!,
      ["read", "send"],
      days,
      name,
      ids,
      pending,
    );
    return this.access.identify(issued.token);
  }
  principal(u: any): Principal {
    const a = this.store.account(u.account);
    return {
      role: "account",
      accountId: a.id,
      profileId: a.profileId,
      name: u.name,
      epoch: a.epoch,
      permissions: ["read", "send", "manage"],
    };
  }
  private rate(req: Request, action: string, max: number, ms: number): void {
    this.count(action + ":" + req.ip, max, ms);
  }
  private count(key: string, max: number, ms: number): void {
    const now = Date.now();
    if (this.limits.size > 10000) {
      for (const [k, v] of this.limits)
        if (v.until < now) this.limits.delete(k);
      if (this.limits.size > 10000)
        throw new Error("Servicio ocupado. Intenta más tarde.");
    }
    let value = this.limits.get(key);
    if (!value || value.until <= now) {
      value = { count: 0, until: now + ms };
      this.limits.set(key, value);
    }
    if (++value.count > max)
      throw Object.assign(
        new Error("Demasiados intentos. Intenta más tarde."),
        { status: 429 },
      );
  }
  private customerForAccount(account: string): any {
    return this.store.db
      .prepare(
        "SELECT * FROM customers WHERE account=? OR id IN (SELECT customer FROM company_numbers WHERE account=?)",
      )
      .get(account, account);
  }
  guard(name: string, p: Principal): void {
    if (p.role === "owner" || !p.accountId) return;
    const u = this.customerForAccount(p.accountId);
    if (!u) return;
    if (/message_send|media_send|pairing_start/.test(name)) {
      if (!this.entitled(u))
        throw new Error(
          "El acceso de prueba terminó. Revisa la facturación antes de continuar.",
        );
      this.count(p.accountId + ":" + name, 20, 60000);
    }
  }
  entitled(u: any): boolean {
    if (
      this.store.db
        .prepare(
          "SELECT id FROM billing_holds WHERE user_id=? AND subscription=? LIMIT 1",
        )
        .get(u.id, u.stripe_subscription ?? "")
    )
      return false;
    return (
      u.trial_until > Date.now() ||
      (["active", "trialing"].includes(u.billing_state) &&
        u.paid_until > Date.now())
    );
  }
  usage(account: string): number {
    const now = new Date(),
      start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    return Number(
      (
        this.store.db
          .prepare(
            "SELECT count(*) AS n FROM send_usage WHERE account=? AND month=?",
          )
          .get(account, new Date(start).toISOString().slice(0, 7)) as any
      ).n,
    );
  }
  companyUsage(u: any): number {
    return this.numbers(u).reduce((sum, a) => sum + this.usage(a.id), 0);
  }
  checkSend(account: string, requestId: string): void {
    const u = this.customerForAccount(account);
    if (!u) return;
    this.store.transaction(() => {
      if (!this.entitled(u))
        throw new Error("La cuenta no tiene acceso activo.");
      if (
        this.store.db
          .prepare(
            "SELECT request_id FROM send_usage WHERE account=? AND request_id=?",
          )
          .get(account, requestId)
      )
        return;
      if (this.companyUsage(u) >= 1000)
        throw new Error(
          "La cuenta alcanzó 1000 solicitudes de envío este mes.",
        );
      this.store.db
        .prepare("INSERT INTO send_usage VALUES(?,?,?,?)")
        .run(
          account,
          requestId,
          new Date().toISOString().slice(0, 7),
          Date.now(),
        );
    });
  }
}
