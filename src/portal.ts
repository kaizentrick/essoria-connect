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
  password: z.string().min(12).max(200),
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
      .exec(`CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT,salt TEXT,recovery TEXT,account TEXT UNIQUE,created INTEGER,trial_until INTEGER,stripe_customer TEXT UNIQUE,stripe_subscription TEXT,billing_state TEXT DEFAULT 'beta',paid_until INTEGER DEFAULT 0,terms_version TEXT);
  CREATE TABLE IF NOT EXISTS web_sessions(id TEXT PRIMARY KEY,user_id TEXT REFERENCES customers(id) ON DELETE CASCADE,expires INTEGER);
  CREATE TABLE IF NOT EXISTS billing_events(id TEXT PRIMARY KEY,processed INTEGER);
  CREATE TABLE IF NOT EXISTS billing_holds(id TEXT PRIMARY KEY,user_id TEXT REFERENCES customers(id) ON DELETE CASCADE,subscription TEXT,reason TEXT,created INTEGER);
  CREATE TABLE IF NOT EXISTS billing_checkouts(id TEXT PRIMARY KEY,user_id TEXT REFERENCES customers(id) ON DELETE CASCADE,identifier TEXT,created INTEGER);
  CREATE TABLE IF NOT EXISTS send_usage(account TEXT REFERENCES accounts(id) ON DELETE CASCADE,request_id TEXT,month TEXT,created INTEGER,PRIMARY KEY(account,request_id));
  CREATE TABLE IF NOT EXISTS support_requests(id TEXT PRIMARY KEY,email TEXT,message TEXT,created INTEGER);`);
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
        recovery = "essoria-recovery-" + token(),
        pwd = (await passwordHash(value.password, salt)).toString("hex");
      if (
        store.db
          .prepare("SELECT id FROM customers WHERE email=?")
          .get(value.email)
      )
        throw new Error(
          "No se pudo crear la cuenta. Si ya tienes acceso, inicia sesión o usa tu código de recuperación.",
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
            "INSERT INTO customers(id,email,name,password,salt,recovery,account,created,trial_until,terms_version) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            value.email,
            value.name,
            pwd,
            salt,
            hash(recovery),
            account.id,
            Date.now(),
            Date.now() + 7 * 86400000,
            "2026-10-31",
          );
      });
      this.newSession(id, res);
      res.status(201).json({
        recoveryCode: recovery,
        message:
          "Guarda este código: es necesario para recuperar tu cuenta. No volverá a mostrarse.",
      });
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
      if (!u || !safeEqual(candidate, u.password))
        throw new Error("Correo o contraseña incorrectos.");
      this.newSession(u.id, res);
      res.json({ ok: true });
    });
    route("post", "/api/app/recover", async (req, res) => {
      this.rate(req, "recover", 10, 900000);
      const v = credentials
          .extend({ recoveryCode: z.string().min(20).max(150) })
          .strict()
          .parse(req.body),
        u = store.db
          .prepare("SELECT * FROM customers WHERE email=?")
          .get(v.email) as any;
      if (!u || !safeEqual(hash(v.recoveryCode), u.recovery))
        throw new Error("No se pudo recuperar la cuenta con esos datos.");
      const salt = token(),
        pwd = (await passwordHash(v.password, salt)).toString("hex"),
        recovery = "essoria-recovery-" + token();
      store.transaction(() => {
        store.db
          .prepare(
            "UPDATE customers SET password=?,salt=?,recovery=? WHERE id=?",
          )
          .run(pwd, salt, hash(recovery), u.id);
        store.db.prepare("DELETE FROM web_sessions WHERE user_id=?").run(u.id);
        store.updateAccount(u.account, {
          epoch: store.account(u.account).epoch + 1,
        });
      });
      this.newSession(u.id, res);
      res.json({
        recoveryCode: recovery,
        message:
          "Se cerraron las demás sesiones y se revocaron las claves anteriores.",
      });
    });
    route("post", "/api/app/logout", (req, res) => {
      const s = this.cookie(req);
      if (s)
        store.db.prepare("DELETE FROM web_sessions WHERE id=?").run(hash(s));
      res.clearCookie("essoria_session", { path: "/" });
      res.json({ ok: true });
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
        agents: access.tokens(u.account),
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
        usage: { requests: this.usage(u.account), monthlyLimit: 1000 },
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
            confirm: z.boolean().optional(),
          })
          .strict()
          .parse(req.body);
      res.json(
        await tools.execute(
          v.name,
          {
            account: u.account,
            ...(v.name === "whatsapp_account_logout"
              ? { confirm: v.confirm }
              : {}),
          },
          this.principal(u),
        ),
      );
    });
    route("post", "/api/app/agents", async (req, res) => {
      const u = this.user(req),
        v = z
          .object({
            name: z.string().trim().min(1).max(60),
            permissions: z
              .array(z.enum(["read", "send", "manage"]))
              .min(1)
              .max(3),
          })
          .strict()
          .parse(req.body);
      if (!v.permissions.includes("read"))
        throw new Error("La clave debe incluir lectura.");
      if (access.tokens(u.account).length >= 5)
        throw new Error(
          "Puedes mantener hasta cinco claves activas. Revoca una para crear otra.",
        );
      const issued = access.issue(u.account, v.permissions, 30, v.name);
      res.status(201).json({
        ...issued,
        endpoint: config.publicUrl + "/mcp",
        codeModeEndpoint: config.publicUrl + "/mcp/code",
      });
    });
    route("post", "/api/app/agents/revoke", (req, res) => {
      const u = this.user(req),
        v = z
          .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(req.body);
      if (!access.tokens(u.account).some((t) => t.id === v.id))
        throw new Error("Clave no encontrada.");
      access.revoke(v.id);
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
            password: z.string().min(12).max(200),
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
      let remoteUnlinked = false;
      try {
        await sessions.logout(u.account);
        remoteUnlinked = true;
      } catch {
        await sessions.disconnect(u.account).catch(() => {});
      }
      for (const k of access.tokens(u.account)) access.revoke(k.id);
      store.transaction(() => {
        for (const table of [
          "aliases",
          "contacts",
          "chats",
          "messages",
          "receipts",
        ])
          store.db
            .prepare(`DELETE FROM ${table} WHERE account=?`)
            .run(u.account);
        store.db.prepare("DELETE FROM slots WHERE account=?").run(u.account);
        store.db.prepare("DELETE FROM accounts WHERE id=?").run(u.account);
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
  guard(name: string, p: Principal): void {
    if (p.role === "owner" || !p.accountId) return;
    const u = this.store.db
      .prepare("SELECT * FROM customers WHERE account=?")
      .get(p.accountId) as any;
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
  checkSend(account: string, requestId: string): void {
    const u = this.store.db
      .prepare("SELECT * FROM customers WHERE account=?")
      .get(account) as any;
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
      if (this.usage(account) >= 1000)
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
