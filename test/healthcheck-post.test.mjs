// 这条测试是给「端口探测要 POST + Cookie」那个坑上锁的：
// GET 拿不到 describe，POST 带 body 和 header 才拿得到。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runChecks } from "../src/healthcheck.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const bodyOk = (req, body) =>
  req.method === "POST" &&
  req.headers.cookie === "sid=1" &&
  body?.type === "client-request" &&
  body?.method === "settings/describe";

test("healthcheck 支持 POST body 与自定义 header", async () => {
  const { server, url } = await serve((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      if (!bodyOk(req, body)) {
        res.statusCode = 401;
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: "server-response", result: { ok: true } }));
    });
  });

  const check = {
    name: "dsh-style",
    type: "http",
    method: "POST",
    url: `${url}/api/settings/describe`,
    headers: { cookie: "sid=1" },
    body: { type: "client-request", rpcId: "t1", method: "settings/describe", payload: { args: {} } },
    expect: { status: 200, jsonPath: "result.ok", equals: true },
  };
  const [ok] = await runChecks([check]);
  assert.equal(ok.ok, true, ok.detail);

  const [bad] = await runChecks([{ ...check, headers: { cookie: "sid=2" } }]);
  assert.equal(bad.ok, false);

  server.close();
});
