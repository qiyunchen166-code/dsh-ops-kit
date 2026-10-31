import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { discoverDshBaseUrl, probe } from "../src/dsh-endpoint.mjs";
import { makeClient, withEntry, mutate } from "../src/whitelist.mjs";
import { runChecks } from "../src/healthcheck.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("probe 认 DSH 的 settings/describe", async () => {
  const { server, url } = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "server-response", result: { ok: true } }));
  });
  assert.equal(await probe(url), true);
  server.close();
});

test("discover 会跳过死地址、找到活的", async () => {
  const { server, url } = await serve((req, res) => {
    res.end(JSON.stringify({ type: "server-response", result: { ok: true } }));
  });
  const found = await discoverDshBaseUrl({
    candidates: ["http://127.0.0.1:9", url],
    timeoutMs: 500,
    includePortScan: false,
  });
  assert.equal(found, url);
  server.close();
});

test("withEntry 去重且不移除别的项", () => {
  assert.deepEqual(withEntry(["1", "2"], "3", true), ["1", "2", "3"]);
  assert.deepEqual(withEntry(["1", "2"], "1", true), ["1", "2"]);
  assert.deepEqual(withEntry(["1", "2"], "1", false), ["2"]);
});

test("whitelist 的 GET/POST 走通并能回读", async () => {
  let state = { allow: { private: [], groups: [] }, deny: { private: [], groups: [] }, ownerQQ: 1 };
  const { server, url } = await serve((req, res) => {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      if (req.headers["x-console-token"] !== "t") {
        res.statusCode = 401;
        res.end("{}");
        return;
      }
      if (req.method === "POST") {
        const body = JSON.parse(buf);
        state = { ...state, ...body };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state));
    });
  });
  const client = makeClient({ baseUrl: url, token: "t" });
  const { ok, got } = await mutate(client, { kind: "group", value: "123", add: true });
  assert.equal(ok, true);
  assert.deepEqual(got, ["123"]);
  const removed = await mutate(client, { kind: "group", value: "123", add: false });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.got, []);
  server.close();
});

test("healthcheck 三路断言", async () => {
  const { server, url } = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, total: 3, name: "demo" }));
  });
  const results = await runChecks([
    { name: "status", type: "http", url, expect: { status: 200 } },
    { name: "json", type: "http", url, expect: { jsonPath: "total", equals: 3 } },
    { name: "regex", type: "http", url, expect: { regex: "demo" } },
    { name: "bad", type: "http", url, expect: { jsonPath: "total", equals: 4 } },
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
  server.close();
});
