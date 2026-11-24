import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Principal } from "./access.js";
import { Store, hash, type StoredMessage } from "./store.js";
import { postWebhook, receiver, signatureHeaders } from "./wake.js";

const name = "whatsapp.message.received";
const args = z
  .object({
    account: z
      .string()
      .min(1)
      .max(100)
      .describe("Use the authorized account ID from whatsapp_account_list."),
    contact: z
      .string()
      .regex(/^\+?[1-9]\d{5,14}$/)
      .optional()
      .describe(
        "Only incoming messages from this phone, including country code.",
      ),
    newChat: z
      .boolean()
      .optional()
      .describe("Only the first incoming message in a new WhatsApp chat."),
  })
  .strict();
const payload = z
  .object({ account: z.string(), chat: z.string(), messageId: z.string() })
  .strict();
const definition = {
  name,
  description:
    "Incoming WhatsApp message on one authorized number. Use whatsapp_message_get to read the indicated message.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(args),
  payloadSchema: z.toJSONSchema(payload),
};
const delivery = z.object({
  mode: z.literal("webhook"),
  url: z.string().url().max(2048),
});
const base = z.object({ name: z.literal(name), arguments: args, delivery });
const subscribe = base.extend({
  delivery: delivery.extend({
    secret: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/)
      .max(96)
      .refine((s) => {
        const b = Buffer.from(s.slice(6), "base64");
        return (
          b.length >= 24 &&
          b.length <= 64 &&
          b.toString("base64").replace(/=+$/, "") ===
            s.slice(6).replace(/=+$/, "")
        );
      }),
  }),
  ttlMs: z.number().int().positive().nullable().optional(),
});
export const eventCapabilities = { tools: {}, events: {} };
export const eventMethods = [
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
] as const;
export type EventMethod = (typeof eventMethods)[number];
type Config = {
  url: string;
  secret: string;
  contact: string;
  newChat: boolean;
  verifiedAt: number;
  previous?: { secret: string; until: number };
};
type Sub = {
  id: string;
  owner: string;
  account: string;
  expires: number;
  accepted: number;
};
const day = 86400000;
function rpcError(code: number, message: string, data?: unknown) {
  return Object.assign(new Error(message), { code, data });
}
function signed(body: string, id: string, sub: string, c: Config) {
  const now = Date.now(),
    headers = signatureHeaders(body, id, c.secret, now);
  if (c.previous && c.previous.until > now)
    headers["webhook-signature"] +=
      " " +
      signatureHeaders(body, id, c.previous.secret, now)["webhook-signature"];
  return { ...headers, "X-MCP-Subscription-Id": sub };
}

export class AgentEvents {
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private verifying = new Set<string>();
  private nextSweep = 0;
  constructor(
    private store: Store,
    private post = postWebhook,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS agent_subscriptions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,expires INTEGER NOT NULL,accepted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS subs_account ON agent_subscriptions(account,expires);
    CREATE INDEX IF NOT EXISTS subs_owner ON agent_subscriptions(owner);
    CREATE TABLE IF NOT EXISTS agent_deliveries(id TEXT PRIMARY KEY,sub TEXT NOT NULL REFERENCES agent_subscriptions(id) ON DELETE CASCADE,chat TEXT NOT NULL,message TEXT NOT NULL,occurred INTEGER NOT NULL,due INTEGER NOT NULL,attempt INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS deliveries_due ON agent_deliveries(due);
    CREATE TRIGGER IF NOT EXISTS event_grant_removed AFTER DELETE ON slots WHEN OLD.kind='access-key' BEGIN DELETE FROM agent_subscriptions WHERE owner=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS event_subscription_removed AFTER DELETE ON agent_subscriptions BEGIN DELETE FROM slots WHERE kind='agent-callback' AND account=OLD.account AND id=OLD.id; END;`);
  }
  supports(p: Principal) {
    return (
      !!p.tokenHash && p.role === "account" && p.permissions.includes("read")
    );
  }
  private allowed(owner: string, account: string) {
    const grant = this.store.get("access-key", "", owner);
    if (!grant || grant.pendingOAuth || !grant.permissions.includes("read"))
      return false;
    const numbers = grant.numbers ?? [
      { id: grant.accountId, epoch: grant.epoch },
    ];
    return (
      numbers.some((a: { id: string }) => a.id === account) &&
      numbers.every((a: { id: string; epoch: number }) =>
        this.store.db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND epoch=?")
          .get(a.id, a.epoch),
      )
    );
  }
  private remove(id: string, account: string) {
    this.store.db
      .prepare("DELETE FROM agent_subscriptions WHERE id=? AND account=?")
      .run(id, account);
  }
  async handle(method: EventMethod, params: unknown, p: Principal) {
    if (!this.supports(p)) throw rpcError(-32601, "Events unavailable");
    if (method === "events/list") return { events: [definition] };
    const isCreate = method === "events/subscribe";
    const parsed = (isCreate ? subscribe : base).safeParse(params);
    if (!parsed.success)
      throw rpcError(-32602, "Invalid event filters or webhook settings");
    const { arguments: filter, delivery: dest } = parsed.data,
      owner = p.tokenHash!;
    if (!this.allowed(owner, filter.account))
      throw rpcError(-32602, "Account unavailable");
    let url: string;
    try {
      url = receiver(dest.url).href;
    } catch {
      throw rpcError(-32602, "A public HTTPS callback is required");
    }
    const contact = filter.contact?.replace(/^\+/, "") ?? "",
      newChat = filter.newChat ?? false;
    const id =
      "sub_" +
      hash(
        JSON.stringify([owner, url, name, filter.account, contact, newChat]),
      );
    if (!isCreate) {
      this.remove(id, filter.account);
      return {};
    }
    const v = parsed.data as z.infer<typeof subscribe>;
    const old = this.store.get<Config>("agent-callback", filter.account, id),
      secret = v.delivery.secret;
    const now = Date.now(),
      config: Config = {
        url,
        secret,
        newChat,
        contact,
        verifiedAt: old?.verifiedAt ?? 0,
      };
    const count = Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_subscriptions WHERE owner=? AND expires>?",
        )
        .get(owner, now)?.n,
    );
    if (!old && count >= 24)
      throw rpcError(-32602, "Subscription limit reached");
    if (!old || old.secret !== secret || now - old.verifiedAt > 5 * 60000) {
      if (this.verifying.has(owner) || this.verifying.size >= 24)
        throw rpcError(-32015, "Callback busy", { reason: "rate_limited" });
      this.verifying.add(owner);
      try {
        const challenge = randomBytes(28).toString("base64url"),
          body = JSON.stringify({ type: "verification", challenge });
        const result = await this.post(
          url,
          body,
          signed(body, randomUUID(), id, config),
          true,
        );
        const echo = Buffer.from(
          String(JSON.parse(result.body).challenge ?? ""),
        );
        if (
          result.status < 200 ||
          result.status >= 300 ||
          echo.length !== challenge.length ||
          !timingSafeEqual(echo, Buffer.from(challenge))
        )
          throw new Error();
        config.verifiedAt = Date.now();
      } catch (e) {
        throw rpcError(-32015, "Callback verification failed", {
          reason:
            (e as Error)?.name === "AbortError"
              ? "timeout"
              : "challenge_failed",
        });
      } finally {
        this.verifying.delete(owner);
      }
    }
    if (!this.allowed(owner, filter.account))
      throw rpcError(-32602, "Account unavailable");
    if (old && old.secret !== secret)
      config.previous = { secret: old.secret, until: now + 300000 };
    else if (old?.previous && old.previous.until > now)
      config.previous = old.previous;
    const keyExpiry =
      Number(
        this.store.db
          .prepare(
            "SELECT expires FROM slots WHERE kind='access-key' AND account='' AND id=?",
          )
          .get(owner)?.expires,
      ) || Infinity;
    const expires = Math.min(
      keyExpiry,
      Date.now() + Math.min(v.ttlMs ?? day, 7 * day),
    );
    this.store.transaction(() => {
      this.store.put("agent-callback", filter.account, id, config, expires);
      this.store.db
        .prepare(
          "INSERT INTO agent_subscriptions(id,owner,account,expires) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires",
        )
        .run(id, owner, filter.account, expires);
    });
    return {
      id,
      refreshBefore: new Date(expires).toISOString(),
      cursor: null,
      truncated: false,
    };
  }
  status(owners: string[]) {
    let count = 0,
      lastAccepted = 0;
    for (const owner of owners) {
      const r = this.store.db
        .prepare(
          "SELECT COUNT(*) AS n,MAX(accepted) AS last FROM agent_subscriptions WHERE owner=? AND expires>?",
        )
        .get(owner, Date.now());
      count += Number(r?.n ?? 0);
      lastAccepted = Math.max(lastAccepted, Number(r?.last ?? 0));
    }
    return { count, lastAccepted };
  }
  enqueue(account: string, m: StoredMessage, newChat: boolean) {
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM agent_subscriptions WHERE account=? AND expires>?",
      )
      .all(account, Date.now()) as Sub[]) {
      const c = this.store.get<Config>("agent-callback", account, row.id);
      if (!c || !this.allowed(row.owner, account) || (c.newChat && !newChat))
        continue;
      if (c.contact) {
        const wanted = this.store.canonical(
          account,
          c.contact + "@s.whatsapp.net",
        );
        if (
          ![m.participant ?? m.chatId, m.participantAlt ?? m.remoteJidAlt].some(
            (v) => v && this.store.canonical(account, v) === wanted,
          )
        )
          continue;
      }
      this.store.db
        .prepare(
          "INSERT INTO agent_deliveries(id,sub,chat,message,occurred,due) VALUES(?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          row.id,
          m.chatId,
          m.id,
          m.timestamp ? m.timestamp * 1000 : Date.now(),
          Date.now(),
        );
    }
  }
  async drain() {
    if (this.nextSweep <= Date.now()) {
      this.store.db
        .prepare("DELETE FROM agent_subscriptions WHERE expires<=?")
        .run(Date.now());
      this.nextSweep = Date.now() + 60000;
    }
    for (const d of this.store.db
      .prepare(
        "SELECT d.*,s.owner,s.account,s.expires FROM agent_deliveries d JOIN agent_subscriptions s ON s.id=d.sub WHERE due<=? ORDER BY due LIMIT 10",
      )
      .all(Date.now())) {
      const sub = String(d.sub),
        account = String(d.account),
        id = String(d.id);
      const c = this.store.get<Config>("agent-callback", account, sub);
      if (!c || !this.allowed(String(d.owner), account)) {
        this.remove(sub, account);
        continue;
      }
      const body = JSON.stringify({
        eventId: id,
        name,
        timestamp: new Date(Number(d.occurred)).toISOString(),
        data: { account, chat: d.chat, messageId: d.message },
        cursor: null,
      });
      let status = 0;
      try {
        status = (await this.post(c.url, body, signed(body, id, sub, c)))
          .status;
      } catch {}
      if (status === 410) {
        this.remove(sub, account);
        continue;
      }
      if (status >= 200 && status < 300)
        this.store.db
          .prepare("UPDATE agent_subscriptions SET accepted=? WHERE id=?")
          .run(Date.now(), sub);
      else if (status !== 413 && Number(d.attempt) < 5) {
        this.store.db
          .prepare(
            "UPDATE agent_deliveries SET attempt=attempt+1,due=? WHERE id=?",
          )
          .run(Date.now() + 2000 * 2 ** Number(d.attempt), id);
        continue;
      }
      this.store.db.prepare("DELETE FROM agent_deliveries WHERE id=?").run(id);
    }
  }
  start() {
    this.timer = setInterval(() => {
      this.running ??= this.drain()
        .catch(() => {})
        .finally(() => {
          this.running = undefined;
        });
    }, 500);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    await this.running;
  }
}
