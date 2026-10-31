import test from "node:test";
import assert from "node:assert/strict";
import { WasmExecutor } from "../dist/codemode.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../dist/service.js";
import { initialize, loadConfig } from "../dist/config.js";
import { fakeDriver } from "./helpers.mjs";
test("WASM isolation blocks Node/network globals, CPU loops, excessive calls and large output", async () => {
  const ex = new WasmExecutor(100, 1000, 2);
  assert.deepEqual(
    (
      await ex.execute(
        "async()=>[typeof process,typeof fetch,typeof require]",
        [],
      )
    ).result,
    ["undefined", "undefined", "undefined"],
  );
  assert((await ex.execute("async()=>{while(true){}}", [])).error);
  assert((await ex.execute('async()=>"a".repeat(65000)', [])).error);
  assert(
    (
      await ex.execute(
        "async()=>{await codemode.f();await codemode.f();return await codemode.f();}",
        { f: async () => 1 },
      )
    ).error,
  );
  const short = new WasmExecutor(100, 100, 2);
  const held = Array.from({ length: 4 }, () =>
    short.execute("async()=>new Promise(()=>{})", {}),
  );
  assert.match((await short.execute("async()=>1", {})).error, /busy/);
  assert((await Promise.all(held)).every((r) => r.error));
  assert.equal(
    (
      await ex.execute("async()=>await codemode.f({n:5})", {
        f: async (a) => a.n + 1,
      })
    ).result,
    6,
  );
});
test("Cloudflare search/execute preserves permissions and account scope, supports composition, and has a smaller discovery payload", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "essoria-code-"));
  initialize(dir);
  const config = loadConfig({
      WA_DATA_DIR: dir,
      WA_PORT: "0",
      WA_AUTO_START: "false",
    }),
    fake = fakeDriver(),
    service = new Service(config, fake.factory);
  await service.start();
  t.after(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = service.store.createAccount("A"),
    b = service.store.createAccount("B"),
    key = service.access.issue(a.id, ["read"]);
  const code = new Client({ name: "Code client", version: "1" }),
    standard = new Client({ name: "Standard client", version: "1" });
  const headers = { Authorization: "Bearer " + key.token };
  await code.connect(
    new StreamableHTTPClientTransport(
      new URL(service.address() + "/mcp/code"),
      { requestInit: { headers } },
    ),
  );
  await standard.connect(
    new StreamableHTTPClientTransport(new URL(service.address() + "/mcp"), {
      requestInit: { headers },
    }),
  );
  t.after(() => code.close());
  t.after(() => standard.close());
  const catalog = await code.listTools(),
    normal = await standard.listTools();
  assert.deepEqual(
    catalog.tools.map((t) => t.name),
    ["search", "execute"],
  );
  const discovery = await code.callTool({
    name: "search",
    arguments: { code: "async()=>Object.keys((await codemode.spec()).paths)" },
  });
  assert(!discovery.isError);
  assert(!discovery.content[0].text.includes("message_send"));
  const composed = await code.callTool({
    name: "execute",
    arguments: {
      code: `async()=>{const a=await codemode.request({method:'POST',path:'/tools/whatsapp_account_list',body:{}});const p=await codemode.request({method:'POST',path:'/tools/whatsapp_profile_get',body:{}});return {accounts:a.accounts.length,profile:p.id};}`,
    },
  });
  assert(!composed.isError);
  assert.equal(JSON.parse(composed.content[0].text).accounts, 1);
  assert(
    (
      await code.callTool({
        name: "execute",
        arguments: {
          code: `async()=>await codemode.request({method:'POST',path:'/tools/whatsapp_account_status',body:{account:${JSON.stringify(b.id)}}})`,
        },
      })
    ).isError,
  );
  assert(
    (
      await code.callTool({
        name: "execute",
        arguments: {
          code: `async()=>await codemode.request({method:'POST',path:'/tools/whatsapp_message_send',body:{account:${JSON.stringify(a.id)},to:'15550000001',text:'Denied',requestId:'test-denied-00001'}})`,
        },
      })
    ).isError,
  );
  assert(
    (
      await code.callTool({
        name: "execute",
        arguments: {
          code: 'async()=>await codemode.request({method:"GET",path:"https://evil.example/"})',
        },
      })
    ).isError,
  );
  const ratio = JSON.stringify(catalog).length / JSON.stringify(normal).length;
  console.log("Code Mode tool-discovery character ratio:", ratio.toFixed(3));
  assert(ratio < 1);
  assert.equal(fake.sockets.length, 0);
  service.access.revoke(key.id);
  await assert.rejects(() => code.listTools());
  await code.close();
  await standard.close();
});
