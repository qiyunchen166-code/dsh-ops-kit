// 找到本机正在跑的 DSH Web 端口。
// DSH 每次启动端口都会变（--port 0），所以别把地址写死，探测就好。
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const pexec = promisify(execFile);

export function probe(baseUrl, timeoutMs = 1500, cookie = "") {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL("/api/settings/describe", baseUrl);
    } catch {
      resolve(false);
      return;
    }
    const payload = JSON.stringify({
      type: "client-request",
      rpcId: `probe-${Math.random().toString(36).slice(2, 8)}`,
      method: "settings/describe",
      payload: { args: {} },
    });
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        agent: false,
        timeout: timeoutMs,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            const body = JSON.parse(buf);
            resolve(body?.type === "server-response" && body?.result?.ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end(payload);
  });
}

export async function listListeningPorts() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await pexec("netstat", ["-ano", "-p", "tcp"], { timeout: 5000 });
    const ports = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)\s/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function discoverDshBaseUrl(options = {}) {
  const { candidates = [], timeoutMs = 1500, includePortScan = true, cookie = process.env.DSH_COOKIE || "" } = options;
  const tried = new Set();
  const tryOne = async (base) => {
    if (!base || tried.has(base)) return null;
    tried.add(base);
    if (await probe(base, timeoutMs, cookie)) return base.replace(/\/$/, "");
    return null;
  };

  for (const base of candidates) {
    const hit = await tryOne(base);
    if (hit) return hit;
  }
  if (!includePortScan) return null;

  const ports = await listListeningPorts();
  for (const port of ports) {
    const hit = await tryOne(`http://127.0.0.1:${port}`);
    if (hit) return hit;
  }
  return null;
}

// CLI: node src/dsh-endpoint.mjs [http://candidate ...]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = await discoverDshBaseUrl({ candidates: process.argv.slice(2) });
  if (found) {
    console.log(found);
    process.exitCode = 0;
  } else {
    console.error("没找到 DSH Web 端口（试过候选和本机监听端口）");
    process.exitCode = 1;
  }
}
