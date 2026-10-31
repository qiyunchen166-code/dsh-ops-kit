// 读写本机桥接的 /api/whitelist：列、加群、移群、加私聊、移私聊。
// 桥接的控制台 API 用 x-console-token 鉴权，token 在 app/state/console-token。
// 用法：
//   node src/whitelist.mjs --list
//   node src/whitelist.mjs --add-group 123456789
//   node src/whitelist.mjs --remove-group 123456789
//   node src/whitelist.mjs --add-private 10001 --dry
import http from "node:http";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function makeClient({ baseUrl = "http://127.0.0.1:3100", token = "" } = {}) {
  const url = new URL(baseUrl);
  function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request(
        {
          host: url.hostname,
          port: url.port || 80,
          path: pathname,
          method,
          agent: false,
          headers: {
            ...(token ? { "x-console-token": token } : {}),
            ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
          },
        },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (buf += d));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode, json: JSON.parse(buf) });
            } catch {
              resolve({ status: res.statusCode, json: { raw: buf.slice(0, 300) } });
            }
          });
        }
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }
  return {
    get: () => request("GET", "/api/whitelist"),
    set: (payload) => request("POST", "/api/whitelist", payload),
  };
}

export function withEntry(list, value, add) {
  const out = (list || []).map(String);
  return add ? [...new Set([...out, String(value)])] : out.filter((v) => v !== String(value));
}

export async function mutate(client, { kind, value, add }) {
  const current = (await client.get()).json;
  const allow = current?.allow || { private: [], groups: [] };
  const key = kind === "group" ? "groups" : "private";
  const next = {
    allow: { ...allow, [key]: withEntry(allow[key], value, add) },
    deny: current?.deny || { private: [], groups: [] },
    ownerQQ: current?.ownerQQ,
  };
  const res = await client.set(next);
  const after = (await client.get()).json;
  const got = (after?.allow?.[key] || []).map(String);
  return { res, ok: add ? got.includes(String(value)) : !got.includes(String(value)), got };
}

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = arg("--url", process.env.BRIDGE_URL || "http://127.0.0.1:3100");
  const tokenFile = arg("--token-file", process.env.BRIDGE_TOKEN_FILE || "");
  const token = tokenFile && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const dry = process.argv.includes("--dry");
  const client = makeClient({ baseUrl, token });

  if (process.argv.includes("--list")) {
    const r = await client.get();
    console.log(JSON.stringify(r.json, null, 2));
    process.exitCode = r.status === 200 ? 0 : 1;
  } else {
    const map = {
      "--add-group": ["group", true],
      "--remove-group": ["group", false],
      "--add-private": ["private", true],
      "--remove-private": ["private", false],
    };
    const hit = Object.keys(map).find((k) => process.argv.includes(k));
    const value = hit ? process.argv[process.argv.indexOf(hit) + 1] : "";
    if (!hit || !value) {
      console.error("用法：--list | --add-group N | --remove-group N | --add-private N | --remove-private N [--dry]");
      process.exitCode = 2;
    } else {
      const [kind, add] = map[hit];
      if (dry) {
        const cur = (await client.get()).json;
        const key = kind === "group" ? "groups" : "private";
        console.log(`will set allow.${key} = [${withEntry(cur?.allow?.[key], value, add).join(", ")}]`);
      } else {
        const { res, ok, got } = await mutate(client, { kind, value, add });
        console.log(`HTTP ${res.status}; allow.${kind === "group" ? "groups" : "private"} = [${got.join(", ")}]`);
        process.exitCode = ok ? 0 : 1;
      }
    }
  }
}
