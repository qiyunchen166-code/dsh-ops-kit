# dsh-ops-kit

Three small tools for keeping a local agent stack honest. They came out of running [DeepSeek Harness](https://github.com/deepseek-ai) next to a QQ bridge on one Windows box, where the web port changes on every restart and "is it up?" has four different answers.

No dependencies. Node 23+ (`node:sqlite` isn't used here; anything modern works, but `fetch`/`node:http` behavior is tested on 24).

## Tools

### 1. `src/dsh-endpoint.mjs` — find the web port

DSH starts with `--port 0`, so the port is random. This probes candidates and then every listening localhost port by POSTing a `settings/describe` RPC to `/api/settings/describe`, accepting `{"type":"server-response","result":{"ok":true}}`. DSH authenticates with a signed session cookie, so pass one via `DSH_COOKIE` (the bridge that launches DSH can mint it offline):

```bash
DSH_COOKIE='...' node src/dsh-endpoint.mjs
# http://127.0.0.1:49954
```

```js
import { discoverDshBaseUrl } from "./src/dsh-endpoint.mjs";
const base = await discoverDshBaseUrl({ candidates: ["http://127.0.0.1:3000"] });
```

### 2. `src/whitelist.mjs` — read/update a bridge allowlist

For a local bridge exposing `GET/POST /api/whitelist` with an `x-console-token` header:

```bash
node src/whitelist.mjs --url http://127.0.0.1:3100 --token-file app/state/console-token --list
node src/whitelist.mjs --token-file app/state/console-token --add-group 123456789
node src/whitelist.mjs --token-file app/state/console-token --remove-group 123456789
```

The POST replaces `allow`/`deny` wholesale (that is how the bridge's endpoint behaves), so the tool reads the current state, merges one entry, writes back, then re-reads to confirm. `--dry` prints the payload without sending.

### 3. `src/healthcheck.mjs` — config-driven checks

```json
{
  "checks": [
    { "name": "dsh", "type": "http", "method": "POST",
      "url": "{{env:DSH_WEB_URL}}/api/settings/describe",
      "headers": { "cookie": "{{env:DSH_COOKIE}}" },
      "body": { "type": "client-request", "rpcId": "probe-kit",
                "method": "settings/describe", "payload": { "args": {} } },
      "expect": { "status": 200, "jsonPath": "result.ok", "equals": true } },
    { "name": "bridge", "type": "tcp", "host": "127.0.0.1", "port": 3100 },
    { "name": "memory", "type": "http", "url": "http://127.0.0.1:3505/stats",
      "expect": { "jsonPath": "total" } }
  ]
}
```

```bash
node src/healthcheck.mjs config/checks.example.json
PASS  dsh  12ms  HTTP 200 result.ok=true
PASS  bridge  3ms
PASS  memory  21ms  HTTP 200 total=5433

3/3 通过
```

`expect` supports `status`, `contains`, `regex`, `jsonPath` + `equals`. `{{env:NAME}}` is substituted from the environment. Exit code is 1 if any check fails, 2 if the config is missing.

## Tests

```bash
npm test    # node --test test/ops.test.mjs
```

The tests spin up throwaway HTTP servers on ephemeral ports: they never touch a real bridge or DSH.

## Notes from the field

- **Probe with a real endpoint, not a TCP connect.** A listening port can belong to anything; `/settings/describe` distinguishes DSH from a random dev server. A connect-only check also passes while the app is still booting.
- **Don't use `fetch` in short-lived CLIs on Windows.** A keep-alive socket still closing at exit trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in libuv and the process exits 1 despite succeeding. `http.request` with `agent: false` avoids it.
- **Read-modify-write the allowlist, then read again.** The endpoint's `Number()` conversion turns `"123"` into `123`, so a byte-for-byte comparison of the config file will lie to you; compare semantics.
- **Timeouts are part of the check.** A health check without one turns an outage into a hang.

## License

MIT.
