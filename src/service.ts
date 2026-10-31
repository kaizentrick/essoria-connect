import express, { type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { Sessions } from "./sessions.js";
import { Access, type Principal } from "./access.js";
import { Tools } from "./mcp.js";
import { createOAuth } from "./oauth.mjs";
import type { DriverFactory } from "./driver.js";
import { adminHtml, adminCss, adminJs } from "./admin.js";
import { Portal, portalOptions, type PortalOptions } from "./portal.js";
import { siteRouter } from "./website.js";
import { codeModeServer } from "./codemode.js";

export class Service {
  readonly store: Store;
  readonly sessions: Sessions;
  readonly access: Access;
  readonly tools: Tools;
  readonly portal: Portal;
  readonly app = express();
  readonly http: HttpServer;
  private oauth: any;
  private heartbeat?: NodeJS.Timeout;
  private closing = false;
  constructor(
    readonly config: Config,
    driver?: DriverFactory,
    options: PortalOptions = portalOptions(),
  ) {
    this.store = new Store(
      join(config.dataDir, "whatsapp.sqlite"),
      config.masterKey,
    );
    try {
      this.store.acquireLease(randomUUID());
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.sessions = new Sessions(
      this.store,
      driver,
      config.maxMediaBytes,
      (account, requestId) => this.portal.checkSend(account, requestId),
    );
    this.access = new Access(this.store, config);
    this.tools = new Tools(this.store, this.sessions, (name, p) =>
      this.portal.guard(name, p),
    );
    this.portal = new Portal(
      this.store,
      this.access,
      this.sessions,
      this.tools,
      config,
      options,
    );
    this.oauth = createOAuth({
      config: { ...config, ownerProfileId: this.access.ownerProfileId },
      adminToken: config.adminToken,
      storePath: join(config.dataDir, "oauth.sqlite"),
      identify: async (key: string) => this.access.identify(key),
      resolvePrincipal: async (p: Principal) => this.access.resolve(p),
    });
    this.app.disable("x-powered-by");
    this.app.set("trust proxy", "loopback");
    this.app.use((req, res, next) => {
      if (
        ["www.essoria.app", "essoria.kaizentrick.com.mx"].includes(
          req.hostname,
        ) &&
        config.publicUrl === "https://essoria.app"
      )
        return void res.redirect(308, config.publicUrl + req.originalUrl);
      next();
    });
    this.app.use((_req, res, next) => {
      res.set({
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Cache-Control": "no-store",
      });
      next();
    });
    this.app.use((req, res, next) => {
      if (
        req.path.startsWith("/.well-known/") ||
        [
          "/authorize",
          "/token",
          "/register",
          "/revoke",
          "/oauth/consent",
        ].includes(req.path)
      )
        return this.oauth.app(req, res);
      next();
    });
    this.app.get("/health", (_req, res) => {
      try {
        this.store.assertLease();
        res.set(
          "X-Essoria-Revision",
          process.env.ESSORIA_REVISION ?? "development",
        );
        res.json({ status: "ok", version: "0.2.1" });
      } catch {
        res.status(503).json({ status: "unavailable" });
      }
    });
    this.app.get(["/operator", "/admin"], (_req, res) => {
      res.set(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      res.type("html").send(adminHtml);
    });
    this.app.get("/admin.js", (_req, res) => res.type("js").send(adminJs));
    this.app.get("/admin.css", (_req, res) => res.type("css").send(adminCss));
    this.app.use(this.portal.router);
    this.app.use(siteRouter(config));
    const body = express.json({
      limit: Math.ceil((config.maxMediaBytes * 4) / 3) + 1024 * 1024,
    });
    const requireAuth = async (
      req: Request,
      res: Response,
      next: () => void,
    ) => {
      try {
        if (req.headers.origin && req.headers.origin !== config.publicUrl)
          return void res.status(403).json({
            error:
              "Origin denied. Use a server-side MCP client or same-origin admin.",
          });
        const token = req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.slice(7)
          : "";
        let principal = token ? this.access.identify(token) : null;
        if (!principal && token) {
          try {
            const auth = await this.oauth.provider.verifyAccessToken(token);
            const expected =
              config.publicUrl +
              (req.path === "/mcp/code" ? "/mcp/code" : "/mcp");
            if (auth.resource !== expected)
              throw new Error("Wrong OAuth resource");
            principal = {
              ...auth.principal,
              permissions: auth.principal.permissions.filter((p: string) =>
                auth.scopes.includes("whatsapp:" + p),
              ),
            };
          } catch {}
        }
        if (!principal) {
          res.set(
            "WWW-Authenticate",
            req.path === "/mcp/code"
              ? this.oauth.challenge.replace(
                  "/oauth-protected-resource/mcp",
                  "/oauth-protected-resource/mcp/code",
                )
              : this.oauth.challenge,
          );
          return void res.status(401).json({ error: "Unauthorized" });
        }
        res.locals.resolve = async () => {
          const native = this.access.identify(token);
          if (native) return native;
          try {
            const auth = await this.oauth.provider.verifyAccessToken(token);
            return {
              ...auth.principal,
              permissions: auth.principal.permissions.filter((v: string) =>
                auth.scopes.includes("whatsapp:" + v),
              ),
            };
          } catch {
            return null;
          }
        };
        res.locals.principal = principal;
        next();
      } catch {
        res.status(401).json({ error: "Unauthorized" });
      }
    };
    this.app.post(
      ["/mcp", "/mcp/code"],
      requireAuth,
      body,
      async (req, res) => {
        const server =
            req.path === "/mcp/code"
              ? codeModeServer(this.tools, res.locals.principal, async (p) => {
                  const current = await res.locals.resolve();
                  return current
                    ? {
                        ...current,
                        permissions: current.permissions.filter((v: any) =>
                          p.permissions.includes(v),
                        ),
                      }
                    : null;
                })
              : this.tools.server(res.locals.principal),
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
        res.on("close", () => {
          void transport.close().catch(() => {});
          void server.close().catch(() => {});
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch {
          if (!res.headersSent)
            res.status(400).json({ error: "Invalid MCP request" });
          else res.end();
        }
      },
    );
    this.app.all(["/mcp", "/mcp/code"], requireAuth, (_req, res) =>
      res
        .set("Allow", "POST")
        .status(405)
        .json({ error: "Use MCP Streamable HTTP POST" }),
    );
    this.app.get("/api/tools/list", requireAuth, (_req, res) =>
      res.json({
        tools: this.tools.visible(res.locals.principal).map((t) => t.name),
      }),
    );
    this.app.post("/api/tools/call", requireAuth, body, async (req, res) => {
      if (typeof req.body?.name !== "string")
        return void res.status(400).json({ error: "Tool name required" });
      res.json(
        await this.tools.execute(
          req.body.name,
          req.body.arguments,
          res.locals.principal,
        ),
      );
    });
    this.app.use((_req, res) => res.status(404).json({ error: "Not found" }));
    this.app.use((error: any, _req: Request, res: Response, _next: any) =>
      res.status(error?.type === "entity.too.large" ? 413 : 400).json({
        error:
          error?.type === "entity.too.large"
            ? "Request too large"
            : "Invalid request",
      }),
    );
    this.http = createServer(this.app);
    this.http.requestTimeout = 60000;
    this.http.headersTimeout = 15000;
  }
  async start(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        this.http.once("error", reject);
        this.http.listen(this.config.port, this.config.host, () => {
          this.http.off("error", reject);
          resolve();
        });
      });
      this.heartbeat = setInterval(() => {
        try {
          this.store.heartbeat();
        } catch {
          void this.close();
        }
      }, 5000);
      this.heartbeat.unref();
      if (this.config.autoStart) await this.sessions.resume();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  address(): string {
    const a = this.http.address();
    if (!a || typeof a === "string")
      throw new Error("Service is not listening");
    return `http://127.0.0.1:${a.port}`;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http.close(() => r()));
    await this.sessions.shutdown();
    this.oauth.store.db.close();
    this.store.close();
  }
}
