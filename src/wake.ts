import https from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import { createHmac, randomUUID } from "node:crypto";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import type { Store, StoredMessage } from "./store.js";

export const wakeSettings = z
  .object({
    url: z.string().url().max(2048),
    mode: z.enum(["all", "new", "contacts"]),
    contacts: z.array(z.string().regex(/^\+?[1-9]\d{5,14}$/)).max(100),
    signingKey: z.string().max(256).optional(),
  })
  .strict();
type Settings = z.infer<typeof wakeSettings>;
export function receiver(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    isIP(u.hostname.replace(/^\[|\]$/g, "")) ||
    !u.hostname.includes(".")
  )
    throw new Error("Usa una URL HTTPS pública con nombre de dominio.");
  return u;
}
export function signatureHeaders(
  body: string,
  id: string,
  key?: string,
  signedAt = Date.now(),
): Record<string, string> {
  if (!key) return {};
  if (key.startsWith("whsec_")) {
    const timestamp = String(Math.floor(signedAt / 1000));
    const signature = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
      .update(id + "." + timestamp + "." + body)
      .digest("base64");
    return {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": "v1," + signature,
    };
  }
  return {
    "X-Essoria-Signature":
      "sha256=" + createHmac("sha256", key).update(body).digest("hex"),
  };
}
export type HookResponse = { status: number; body: string };
export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  readBody = false,
): Promise<HookResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      receiver(url),
      {
        method: "POST",
        agent: false,
        family: 4,
        signal: AbortSignal.timeout(6000),
        lookup(host, opts, done) {
          lookup(host, { all: true }, (err, rows) => {
            if (
              err ||
              !rows.length ||
              rows.some((r) => ipaddr.parse(r.address).range() !== "unicast")
            )
              return done(new Error("Destino no público"), "", 4);
            const r = rows.find((r) => r.family === 4);
            if (!r) return done(new Error("Sin dirección IPv4 pública"), "", 4);
            done(null, r.address, r.family);
          });
        },
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!readBody || status < 200 || status >= 300) {
          res.destroy();
          resolve({ status, body: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4096) {
            res.destroy();
            reject(new Error("Respuesta demasiado grande"));
          } else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
async function deliver(
  s: Settings,
  event: { eventId: unknown; [key: string]: unknown },
) {
  const body = JSON.stringify(event);
  const response = await postWebhook(
    s.url,
    body,
    signatureHeaders(body, String(event.eventId), s.signingKey),
  );
  if (response.status < 200 || response.status >= 300)
    throw new Error("Receptor no confirmó");
}

export class Wake {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private store: Store,
    private send = deliver,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS wake_queue(id TEXT PRIMARY KEY,connection TEXT,account TEXT REFERENCES accounts(id) ON DELETE CASCADE,chat TEXT,message TEXT,attempt INTEGER,due INTEGER); CREATE INDEX IF NOT EXISTS wake_due ON wake_queue(due)",
    );
  }
  private allowed(connection: string, account: string) {
    const grant = this.store.get<any>("access-key", "", connection);
    if (!grant) return false;
    const selected = grant.numbers ?? [
      { id: grant.accountId, epoch: grant.epoch },
    ];
    return (
      selected.some((n: any) => n.id === account) &&
      selected.every((n: any) =>
        this.store.db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND epoch=?")
          .get(n.id, n.epoch),
      )
    );
  }
  configure(id: string, settings: Settings | null) {
    if (settings) {
      receiver(settings.url);
      if (settings.mode === "contacts" && !settings.contacts.length)
        throw new Error("Indica al menos un contacto.");
    }
    this.store.transaction(() => {
      this.store.db
        .prepare("DELETE FROM wake_queue WHERE connection=?")
        .run(id);
      if (settings) this.store.put("wake", "", id, settings);
      else this.store.remove("wake", "", id);
    });
  }
  settings(id: string) {
    const s = this.store.get<Settings>("wake", "", id);
    return s
      ? { mode: s.mode, contacts: s.contacts, host: receiver(s.url).hostname }
      : null;
  }
  enqueue(account: string, m: StoredMessage, newChat: boolean) {
    const chat = this.store.canonical(account, m.chatId);
    for (const row of this.store.db
      .prepare("SELECT id FROM slots WHERE kind='wake'")
      .all()) {
      const id = String(row.id);
      if (!this.allowed(id, account)) continue;
      const s = this.store.get<Settings>("wake", "", id)!;
      if (s.mode === "new" && !newChat) continue;
      const sender = this.store.canonical(account, m.participant ?? m.chatId);
      if (
        s.mode === "contacts" &&
        !s.contacts.some(
          (n) =>
            this.store.canonical(
              account,
              n.replace(/^\+/, "") + "@s.whatsapp.net",
            ) === sender ||
            n.replace(/^\+/, "") + "@s.whatsapp.net" ===
              (m.participantAlt ?? m.remoteJidAlt),
        )
      )
        continue;
      this.store.db
        .prepare("INSERT INTO wake_queue VALUES(?,?,?,?,?,0,?)")
        .run(randomUUID(), id, account, chat, m.id, Date.now());
    }
  }
  async drain() {
    for (const r of this.store.db
      .prepare("SELECT * FROM wake_queue WHERE due<=? ORDER BY due LIMIT 10")
      .all(Date.now())) {
      const id = String(r.connection),
        s = this.store.get<Settings>("wake", "", id);
      try {
        if (s && this.allowed(id, String(r.account)))
          await this.send(s, {
            type: "whatsapp.message.received",
            eventId: r.id,
            account: r.account,
            chat: r.chat,
            messageId: r.message,
          });
      } catch {
        const attempt = Number(r.attempt) + 1;
        if (attempt < 6) {
          this.store.db
            .prepare("UPDATE wake_queue SET attempt=?,due=? WHERE id=?")
            .run(attempt, Date.now() + 1000 * 2 ** attempt, String(r.id));
          continue;
        }
      }
      this.store.db
        .prepare("DELETE FROM wake_queue WHERE id=?")
        .run(String(r.id));
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
