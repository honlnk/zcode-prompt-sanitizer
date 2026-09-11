# zcode-prompt-sanitizer

A local reverse proxy that **sanitizes ZCode-injected prompt fragments before they reach third-party API providers**, preventing WAF false positives that block legitimate coding requests.

[![Tests](https://img.shields.io/badge/tests-36%20passing-brightgreen)](#testing)

## The problem

When you use a third-party API provider (e.g. Tencent Copilot / WorkBuddy) in ZCode, **every request sent from inside a git repository gets blocked** by the provider's WAF content filter, returning a message like:

> 系统检测到您当前输入的信息存在敏感内容

This is a **WAF false positive**, not a real safety issue. The root cause: ZCode automatically injects git context into the system prompt — specifically the line:

```
Main branch (you will usually use this for PRs): master
```

The provider's WAF pattern-matches `"you will usually use this for PRs"` as a prompt-injection / jailbreak attempt and rejects the whole request before it ever reaches the model (you can confirm this: blocked requests report `tokens = 0`).

## The solution

`zcode-prompt-sanitizer` runs as a **local reverse proxy** between ZCode and your provider. It:

1. Intercepts outgoing chat-completion requests.
2. **Rewrites** the injected fragments that trigger WAF (configurable, substring-based, applied to `system`-role content by default).
3. Forwards the cleaned request to the real upstream.
4. Streams the response back verbatim — **SSE chunk-by-chunk, no buffering**.

For the known trigger above, the built-in default rule rewrites it to:

```
Default git branch: master
```

The model still sees the branch name; the WAF no longer sees the trigger phrase.

---

## Quick start

```bash
# Install globally (or use npx)
npm install -g @honlnk/zcode-prompt-sanitizer

# Start the proxy (uses built-in defaults that cover the known trigger)
zps
```

You'll see:

```
  🛡  zcode-prompt-sanitizer v0.1.1
     Proxy      →  http://127.0.0.1:18790
     Dashboard  →  http://127.0.0.1:18790/__zps__
     Rules      →  2 active / 2 total
     Upstreams  →  none configured (passthrough by Host header)
```

### …or run with Docker

```bash
# Build and run with docker compose (recommended)
docker compose up -d
```

Put your config at `./config.yaml` next to `docker-compose.yml` (see [`examples/docker-compose.example.yml`](examples/docker-compose.example.yml)). The proxy is then reachable at `http://127.0.0.1:18790`, dashboard at `http://127.0.0.1:18790/__zps__`.

<details>
<summary>Or run with plain <code>docker</code></summary>

```bash
# Build
docker build -t zcode-prompt-sanitizer .

# Run — mount your config, map the port
docker run -d --name zps \
  -p 18790:18790 \
  -v "$PWD/config.yaml:/data/config.yaml" \
  zcode-prompt-sanitizer

# Or run with zero config (built-in defaults)
docker run -d --name zps -p 18790:18790 zcode-prompt-sanitizer \
  node dist/cli.js --no-dashboard
```

> **Note:** Inside a container the proxy binds `0.0.0.0` (set via `ZPS_HOST` in the Dockerfile), because `127.0.0.1` in a container refers to its own loopback and is unreachable from the host. Port mapping (`-p 18790:18790`) makes it accessible from your machine as usual.
</details>

### Point ZCode at the proxy

Configure your provider in ZCode to use the proxy address. Exactly how depends on how your provider is set up:

**Option A — Provider with a fixed base URL**

Set the provider's base URL to the proxy, and configure an `upstream` in your sanitizer config so the proxy knows where to forward:

```yaml
# ~/.zcode-prompt-sanitizer/config.yaml
upstreams:
  workbuddy:
    target: https://copilot.tencent.com
    headers:
      # Optional: inject the real Authorization if ZCode only knows the proxy
      # authorization: Bearer sk-xxxx
```

In ZCode, set the provider base URL to `http://127.0.0.1:18790` and send the header `x-zps-provider: workbuddy` (or name the provider so it's matched against the Authorization value / Host).

**Option B — Host-header passthrough (zero config)**

If your provider setup lets you control the `Host` header, point it at `127.0.0.1:18790` with the real upstream as Host. The proxy forwards based on the Host header with no upstream config needed.

---

## Configuration

The proxy loads config from the first of these it finds:

1. `--config <path>` CLI flag
2. `ZPS_CONFIG` env var
3. `~/.zcode-prompt-sanitizer/config.yaml`

If none exists, built-in defaults are used. Dashboard edits are persisted to the same path (`~/.zcode-prompt-sanitizer/config.yaml` by default, or `/data/config.yaml` in Docker).

### Full example

```yaml
# ~/.zcode-prompt-sanitizer/config.yaml
port: 18790
host: 127.0.0.1            # always bind locally
verbose: false
maxBodyBytes: 8388608      # 8 MiB request body cap

dashboard:
  enabled: true
  port: 0                  # 0 = serve on the proxy port under /__zps__

# Response-side normalizations (all default OFF; toggle in the dashboard too).
responseFixes:
  # Strip empty-string placeholder fields from SSE chat-chunk deltas
  # (content:"" / reasoning_content:"" / empty function_call). Tencent hunyuan
  # (copilot.tencent.com) sends these on every chunk, which makes ZCode split
  # one thinking phase into dozens of "思考" segments. Enable if you see that.
  stripEmptyDeltaFields: false

upstreams:
  workbuddy:
    target: https://copilot.tencent.com
    changeHost: true
    headers:
      x-custom-header: value

rules:
  - id: zcode-git-pr-hint
    description: Neutralize the git hint that triggers WAF
    enabled: true
    scopes: [system]
    match: "Main branch (you will usually use this for PRs):"
    replacement: "Default git branch:"
  - id: redact-internal-token
    enabled: true
    scopes: [system, user]
    match: "INTERNAL-TOKEN-"
    replacement: ""        # empty = delete the match
```

### Rule semantics

| Field         | Type     | Notes                                                              |
| ------------- | -------- | ----------------------------------------------------------------- |
| `id`          | string   | Unique. Used in stats/logs.                                        |
| `enabled`     | boolean  | Skip when `false`. Defaults to `true`.                            |
| `scopes`      | string[] | One or more of `system`, `user`, `assistant`, `tool`. Default `["system"]`. |
| `match`       | string   | **Literal substring** — no regex. Matched with `indexOf`.         |
| `replacement` | string   | Literal replacement. Empty string deletes the match.              |
| `description` | string   | Optional, shown in the dashboard.                                 |

Rules apply **in order**; replacements can chain (rule A's output is visible to rule B in the same pass). **All** occurrences of a match are replaced.

### Response fixes

Response-side normalizations, each off by default and toggleable live from the
dashboard (**Response Fixes** section) — changes apply immediately and are
persisted to the config file.

| Flag                             | What it does |
| -------------------------------- | ------------ |
| `responseFixes.stripEmptyDeltaFields` | For `text/event-stream` responses, remove empty-string placeholder fields from chat-chunk deltas: `content: ""`, `reasoning_content: ""`, and the empty `function_call: {name:"", arguments:""}` placeholder. Events that don't parse as chat chunks (`[DONE]`, comments, other shapes) pass through byte-identical. |

Why it exists: Tencent hunyuan (copilot.tencent.com) sends `content: ""`
alongside every `reasoning_content` delta. Clients built on the Vercel AI SDK
(ZCode) treat any text delta — even an empty one — as the end of the current
reasoning block, so one thinking phase renders as a long stack of tiny
"思考/thinking" segments. With this fix on, the stream arrives clean and the
client merges the reasoning into a single block. When enabled, verbose logs
annotate affected requests with `[sse-fix: N]` (N = fields stripped).


### CLI flags & env vars

| Flag             | Env var         | Default  | Description                       |
| ---------------- | --------------- | -------- | --------------------------------- |
| `--config <path>`| `ZPS_CONFIG`    | —        | Config file path                  |
| `--port <n>`     | `ZPS_PORT`      | `18790`  | Listen port                       |
| `--host <addr>`  | `ZPS_HOST`      | `127.0.0.1` | Bind address                   |
| `--verbose`      | `ZPS_VERBOSE=1` | off      | Log every proxied request         |
| `--no-dashboard` | `ZPS_DASHBOARD=0` | on     | Disable the management dashboard  |
| `-d, --daemon`   | `ZPS_DAEMON=1`  | off      | Run in background (see below)     |
| `--stop`         | —               | —        | Stop the background daemon        |
| `-v, --version`  | —               | —        | Print version                     |
| `-h, --help`     | —               | —        | Show help                         |

### Running in the background (daemon mode)

`zps --daemon` starts the proxy as a detached background process: it prints the
startup banner, then returns your terminal while the server keeps running —
including after the terminal is closed.

```bash
zps --daemon     # start in background
zps --stop       # stop it (SIGTERM via the pidfile, graceful shutdown)
```

Daemon state lives next to the config:

| File                                    | Contents                        |
| --------------------------------------- | ------------------------------- |
| `~/.zcode-prompt-sanitizer/zps.log`     | daemon stdout/stderr (banner, request logs) |
| `~/.zcode-prompt-sanitizer/zps.log.1`   | previous log generation         |
| `~/.zcode-prompt-sanitizer/zps.pid`     | pidfile (JSON: pid, host, port) |

**Log rotation is built in**: when `zps.log` exceeds 5 MiB it is rotated to
`zps.log.1` (replacing any older file) — checked at every daemon start and once
per hour while running. Total log footprint stays under ~10 MiB, no external
logrotate tooling or scheduled cleanup needed.

Notes:

- Re-running `zps --daemon` while an instance is alive is a no-op — it prints
  the running instance's address instead of starting a conflicting one.
- A stale pidfile (e.g. after a crash) is detected and cleaned up on the next
  `--daemon` / `--stop`.
- Don't use `--daemon` inside Docker — containers need the foreground process.


---

## Dashboard

Open `http://127.0.0.1:18790/__zps__` in a browser to:

- View live stats (uptime, rule match counts, enabled/total).
- Toggle, add, edit, and delete rules — changes apply immediately and persist to your config file.
- Inspect the active ruleset as JSON.

The dashboard binds to `127.0.0.1` only. As a purely local tool, it intentionally does not implement authentication.

---

## How it works

```
ZCode  ──►  [zcode-prompt-sanitizer :18790]  ──►  Provider (e.g. copilot.tencent.com)
                 │
                 ├─ parse JSON body
                 ├─ apply rewrite rules (system-role content)
                 ├─ rebuild body
                 └─ forward request ──────────────────────┐
                                                            │
            ◄──── stream response verbatim (SSE-aware) ─────┘
```

Key design decisions:

- **Request bodies only** are inspected/rewritten. Responses pass through untouched.
- **SSE is streamed chunk-by-chunk** (`upstreamRes.pipe(clientRes)`), never buffered — so streaming model output stays real-time.
- **Substring matching, no regex** — predictable and safe against metacharacter surprises.
- **Zero hard-coded provider logic** — rules and upstreams are fully configurable; the built-in defaults just happen to cover the known Tencent WAF trigger.

---

## Programmatic API

```typescript
import { Sanitizer } from '@honlnk/zcode-prompt-sanitizer';

const sanitizer = new Sanitizer([
  {
    id: 'pr-hint',
    enabled: true,
    scopes: ['system'],
    match: 'Main branch (you will usually use this for PRs):',
    replacement: 'Default git branch:',
  },
]);

const result = sanitizer.rewrite({
  messages: [
    { role: 'system', content: 'Main branch (you will usually use this for PRs): master' },
    { role: 'user', content: '你好' },
  ],
});

console.log(result.changed);        // true
console.log(result.firedRuleIds);   // ['pr-hint']
```

See [`src/index.ts`](src/index.ts) for the full export surface.

---

## Development

```bash
npm install
npm run build         # compile TypeScript
npm test              # run the 36-test suite
npm run typecheck     # type-check without emitting
npm run dev           # watch mode via tsx
```

### Project layout

```
src/
  types.ts              # shared types
  sanitizer.ts          # the rewrite engine (pure, testable)
  proxy.ts              # reverse proxy + SSE passthrough (Node http)
  server.ts             # wires proxy + dashboard together
  cli.ts                # CLI entrypoint (bin)
  index.ts              # library exports
  config/
    defaults.ts         # built-in rules + default config
    loader.ts           # YAML/JSON load + validation
    persist.ts          # write config back to disk (dashboard edits)
  dashboard/
    api.ts              # management REST API under /__zps__/api
    html.ts             # self-contained dashboard HTML
test/
  sanitizer.test.ts     # rewrite engine unit tests
  config.test.ts        # config loading/validation tests
  proxy.test.ts         # end-to-end proxy + SSE tests
  dashboard.test.ts     # management API tests
```

---

## Testing

The test suite (36 tests) covers:

- **Rewrite engine** — exact substring matching, multi-occurrence, empty-replacement deletion, literal (non-regex) matching, scope filtering, vision-style array content, rule chaining, stats.
- **Config** — YAML/JSON loading, default merging, validation errors (duplicate ids, empty matches, invalid scopes, malformed YAML).
- **Proxy end-to-end** — trigger phrase is rewritten before reaching upstream, user-role content is preserved, SSE streaming verified (chunks arrive incrementally, not buffered), 502 on unreachable upstream, Host-header passthrough fallback.
- **Dashboard API** — status, list/add/update/delete/replace rules, validation rejection, HTML serving.

Run with:

```bash
npm test
```

---

## License

MIT © [honlnk](https://github.com/honlnk)
