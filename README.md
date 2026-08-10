# Knock MCP Server

Knock's MCP server lets AI coding assistants manage your notification infrastructure — workflows, channels, templates, users, and more — directly from tools like Cursor, Claude Code, and Claude Desktop.

This remote MCP server acts as middleware to the Knock API, authenticated via Knock's OAuth flow and optimized for developer workflows.

## Getting Started

Connect your AI assistant to Knock's MCP server in seconds. No local setup required.

### Cursor

Add the following to your Cursor MCP configuration (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "knock": {
      "type": "http",
      "url": "https://mcp.knock.app/mcp"
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "knock": {
      "type": "http",
      "url": "https://mcp.knock.app/mcp"
    }
  }
}
```

On first connection, your browser will open to authorize and select which capabilities to grant.

## Capabilities

When connecting, you choose exactly which tool groups to enable. **By default**, only **Management API (code mode)** is on; the classic per-resource tools are opt-in.

| Group | Description |
|---|---|
| **Management API (code mode)** | `search_mapi`, `execute_mapi` (GET), and `execute_mapi_write` (POST/PUT/PATCH/DELETE when Manage is enabled) — explore the [OpenAPI spec](https://control.knock.app/v1/openapi) and call the Knock Management API from sandboxed JavaScript ([Code Mode](https://blog.cloudflare.com/code-mode-mcp/)). On connect, choose **Read only** or **Read & write**. A future **public API** variant will use the `search_api` / `execute_api` prefix. |
| **Manage resources** | Create and manage notification workflows, channels, templates, email layouts, partials, and other configuration (classic toolkit) |
| **Commits** | Commit and promote changes across environments |
| **Debug** | Inspect environments and view sent message logs |
| **Manage data** | Manage users, tenants, and object data |
| **Documentation** | Search Knock documentation and guides |

## Authentication

The MCP server uses **OAuth 2.1 + PKCE** via Knock's AuthKit. When you first connect, you'll be directed to authorize the connection and select which capabilities to grant. Your credentials are never stored by the MCP server — it exchanges tokens with Knock's API on your behalf.

## Self-Hosting & Local Development

If you need to run the MCP server yourself (e.g. for development or custom deployments), read on.

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled
- A Knock account with AuthKit configured

### 1. Install dependencies

```bash
npm install
npm install --prefix client
```

The root [`.npmrc`](.npmrc) sets `legacy-peer-deps=true` because `agents` declares optional peer packages (for example `ai`) that this Worker does not use. `@modelcontextprotocol/sdk` is pinned to the same version as `agents` so TypeScript sees a single `McpServer` type.

### 2. Create a KV namespace

```bash
wrangler kv namespace create OAUTH_KV
```

Copy the returned `id` into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "your-namespace-id-here"
  }
]
```

### 3. Configure environment variables

```bash
cp .dev.vars.example .dev.vars
```

| Variable | Description |
|---|---|
| `KNOCK_AUTH_URL` | Your Knock AuthKit domain (e.g. `https://your-app.authkit.app`) |
| `KNOCK_DASHBOARD_URL` | Knock dashboard URL (e.g. `https://dashboard.knock.app`) |
| `KNOCK_CONTROL_URL` | Management API control plane (e.g. `https://control.knock.app`) — used for Code Mode OpenAPI fetch and `execute_mapi` / `execute_mapi_write` |
| `COOKIE_ENCRYPTION_KEY` | Random 32-byte hex string — generate with `openssl rand -hex 32` |
| `DEV_ORIGIN` | Set to `http://localhost:8788` for local dev only |
| `SENTRY_DSN` | Sentry DSN for error reporting; leave blank to disable |
| `INFRA_ENV` | Tag attached to Sentry events (`development`, `staging`, `production`) |

**Dynamic Worker loader (Code Mode):** this Worker declares a [`worker_loaders`](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) binding named `LOADER` in [`wrangler.jsonc`](wrangler.jsonc) for [`@cloudflare/codemode`](https://github.com/cloudflare/agents/tree/main/packages/codemode). Use a current `compatibility_date` and a recent `wrangler` / Workers runtime.

Production URLs are set in [`wrangler.jsonc`](wrangler.jsonc) under `vars` (`KNOCK_AUTH_URL`, `KNOCK_DASHBOARD_URL`). Override them with secrets only if you need per-environment values.

**`COOKIE_ENCRYPTION_KEY` must be a Wrangler secret** — do not add it to `vars`. Cloudflare rejects the same binding name as both a var and a secret.

```bash
wrangler secret put COOKIE_ENCRYPTION_KEY
```

**`SENTRY_DSN` should be a Wrangler secret** in any environment where errors are reported:

```bash
wrangler secret put SENTRY_DSN
```

Use a random 32-byte hex value (e.g. `openssl rand -hex 32`). After changing config, deploy so the Worker no longer declares a conflicting var.

The generated [`worker-configuration.d.ts`](worker-configuration.d.ts) (from `wrangler types`) types `Env` including secrets such as `COOKIE_ENCRYPTION_KEY` and optional `.dev.vars` entries. See [`src/env.d.ts`](src/env.d.ts) for notes. You do not need a production `DEV_ORIGIN` unless you use the same origin-rewrite pattern as local dev.

### 4. Run locally

```bash
npm run build:client
npm run dev
```

The worker serves MCP at `http://localhost:8788/mcp`. Ensure `.dev.vars` sets `DEV_ORIGIN=http://localhost:8788` so OAuth redirects and metadata match your machine.

### 4b. Debug with MCP Inspector

The repo includes [`mcp-inspector.json`](mcp-inspector.json), which points the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at your local Streamable HTTP endpoint.

1. **Terminal A** — run the worker (after a client build, if assets changed):

   ```bash
   npm run build:client
   npm run dev
   ```

2. **Terminal B** — start the inspector (installs via devDependency on first `npm install`):

   ```bash
   npm run inspector
   ```

3. Open **http://localhost:6274** in your browser. The UI should open with **Streamable HTTP** and `http://localhost:8788/mcp` already selected (from the config).

4. Click **Connect**. Complete the Knock OAuth and tool-selection flow in the browser when prompted.

The inspector also runs an MCP proxy on **http://localhost:6277** by default. Override ports if needed, for example:

```bash
CLIENT_PORT=8080 SERVER_PORT=9000 npm run inspector
```

**Note:** `@modelcontextprotocol/inspector` currently recommends **Node.js 22.7.5+**; use a recent Node version for the inspector UI.

### 5. Deploy

```bash
npm run deploy
```

This builds the client UI and deploys to Cloudflare Workers. Update `wrangler.jsonc` with your custom domain:

```jsonc
"routes": [
  {
    "pattern": "mcp.your-domain.com",
    "custom_domain": true
  }
]
```

## Architecture

```
MCP Client (e.g. Cursor, Claude Desktop)
    │
    ▼ OAuth 2.1 + PKCE
Cloudflare Worker (this repo)
    │  ├─ /mcp          — MCP endpoint (Durable Object)
    │  ├─ /authorize    — OAuth consent + tool selection UI
    │  └─ /callback     — Token exchange with Knock AuthKit
    │       search_mapi / execute_mapi / execute_mapi_write  — Code Mode
    │       optional classic toolkit tools
    │
    ▼
Knock Management API (control.knock.app) and other Knock APIs
```

The worker is deployed on Cloudflare Workers with Durable Objects for stateful MCP sessions. It acts as both the OAuth authorization server (to MCP clients) and an OAuth client (to Knock's AuthKit). Dynamic client registration means the worker registers itself with AuthKit at runtime — no static client IDs or pre-registered redirect URIs needed. **Code Mode** uses [`@cloudflare/codemode`](https://github.com/cloudflare/agents/tree/main/packages/codemode) with a [Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) so LLM-generated code runs in an isolated sub-worker; `mapi.request()` on the host applies your OAuth token to `https://control.knock.app`.

## License

MIT — see [LICENSE](LICENSE).
