// 配置驱动的健康检查：HTTP 状态/JSON 字段/正则，加上 TCP 端口探测。
// 用法：node src/healthcheck.mjs config/checks.example.json
// 配置文件里可以用 {{env:NAME}} 引用环境变量。
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

function expand(value) {
  if (typeof value === "string") {
    return value.replace(/\{\{env:([A-Z0-9_]+)\}\}/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

function getJson(url, timeoutMs, headers = {}, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        agent: false,
        timeout: timeoutMs,
        headers: {
          ...headers,
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

function pick(obj, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

export async function runCheck(check) {
  const c = expand(check);
  const t0 = performance.now();
  try {
    if (c.type === "tcp") {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: c.host || "127.0.0.1", port: c.port }, () => {
          socket.end();
          resolve();
        });
        socket.setTimeout(c.timeoutMs || 2000, () => socket.destroy(new Error("timeout")));
        socket.on("error", reject);
      });
      return { name: c.name, ok: true, ms: performance.now() - t0 };
    }

    const res = await getJson(c.url, c.timeoutMs || 3000, c.headers || {}, c.method || "GET", c.body ?? null);
    const expect = c.expect || {};
    let ok = true;
    let detail = `HTTP ${res.status}`;
    if (expect.status != null && res.status !== expect.status) ok = false;
    if (expect.contains && !res.body.includes(expect.contains)) ok = false;
    if (expect.jsonPath) {
      const body = JSON.parse(res.body);
      const value = pick(body, expect.jsonPath);
      if ("equals" in expect) ok = ok && JSON.stringify(value) === JSON.stringify(expect.equals);
      else ok = ok && value != null && value !== "";
      detail += ` ${expect.jsonPath}=${JSON.stringify(value)}`;
    }
    if (expect.regex && !new RegExp(expect.regex).test(res.body)) ok = false;
    return { name: c.name, ok, ms: performance.now() - t0, detail };
  } catch (e) {
    return { name: c.name, ok: false, ms: performance.now() - t0, detail: String(e.message || e) };
  }
}

export async function runChecks(checks) {
  const out = [];
  for (const check of checks) out.push(await runCheck(check));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] || "config/checks.example.json";
  if (!fs.existsSync(file)) {
    console.error(`找不到配置：${file}`);
    process.exitCode = 2;
  } else {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const results = await runChecks(cfg.checks || []);
    for (const r of results) {
      console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ms.toFixed(0)}ms${r.detail ? `  ${r.detail}` : ""}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} 通过`);
    process.exitCode = failed ? 1 : 0;
  }
}
