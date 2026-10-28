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

When connecting, you choose exactly which tool groups to enable. **By default**, **Management API (code mode)**, **Knock agent**, **Debug**, and **Documentation** are on. **Manage data** and the deprecated classic per-resource tools remain opt-in.

| Group | Description |
|---|---|
| **Management API (code mode)** | `search_mapi`, `execute_mapi_read` (GET), and `execute_mapi_write` (POST/PUT/PATCH/DELETE when Manage is enabled) — explore the [OpenAPI spec](https://control.knock.app/v1/openapi) and call the Knock Management API from sandboxed JavaScript ([Code Mode](https://blog.cloudflare.com/code-mode-mcp/)). On connect, choose **Read only** or **Read & write**. A future **public API** variant will use the `search_api` / `execute_api_read` / `execute_api_write` prefix. |
| **Manage resources** | Create and manage notification workflows, channels, templates, email layouts, partials, and other configuration (classic toolkit) |
| **Commits** | Commit and promote changes across environments |
| **Debug** | Inspect environments and view sent message logs |
| **Manage data** | Manage users, tenants, and object data |
| **Documentation** | Search Knock documentation and guides |

## Authentication

Interactive clients should use **OAuth 2.1 + PKCE** via Knock's AuthKit. When you first connect, you'll be directed to authorize the connection and select which capabilities to grant. The MCP server exchanges tokens with Knock's API on your behalf.

### OAuth session lifetimes

Lifetimes live in [`src/session-lifetimes.ts`](src/session-lifetimes.ts).

- The MCP access token lasts 12 hours. Each refresh rotates the refresh token.
- A grant lasts 90 days and slides forward 90 days on every refresh, so it only expires after 90 days without use. Grants are also ended after one year regardless of use.
- Every authorization creates its own grant, so signing in from a second device or client does not sign out the first. Grants are not cleaned up when a user authorizes again; they expire on their own.
- On each MCP refresh the server checks the Knock session behind the grant. If that session is gone, the refresh fails with `invalid_grant`, the provider revokes the grant, and the client starts a new authorization. If Knock is briefly unavailable, the refresh returns `503 temporarily_unavailable` and the client keeps its tokens.
- A request on a valid MCP token whose Knock session no longer exists gets `401 invalid_token` with the RFC 9728 challenge instead of a tool error, so clients re-authorize on their own. A grant less than two minutes old is exempt, because KV reads can lag a fresh write.
- WorkOS rotates its refresh token on every use, so every upstream refresh for a session runs through that session's `KnockTokenLock` Durable Object, one at a time. Upstream calls time out after 8 seconds so a hung upstream cannot hold that queue.
- Only `invalid_grant` from WorkOS ends a session at once. Other failures are retried, and after 24 hours of continuous failure the session is treated as dead. `invalid_client` and `unauthorized_client` are errors on the shared Knock MCP client, not on a user's session, so they never end a session and never count toward the 24 hours; they are reported to Sentry at error level.
- Anything unexpected during the refresh check (KV or Durable Object errors) is answered `503 temporarily_unavailable`, not a 500, because SDK clients discard their tokens on a 500.
- The upstream tokens are stored in KV for 15 minutes while consent is in progress, and for the lifetime of the grant once it is issued.

### Service token (CI / headless)

For environments that cannot complete a browser OAuth flow (CI, unattended agents), you can pass a Knock [service token](https://docs.knock.app/developer-tools/service-tokens) (`knock_st_…`) as a bearer credential. MCP clients that set `Authorization` skip OAuth.

This is token passthrough: the same Management API token authenticates the MCP session and outbound Knock calls. It is a CI/headless compatibility path, not MCP-conformant OAuth. Prefer OAuth for interactive use. A service token is a high-privilege account credential — treat it like a secret, and use a scoped token when you can.

```json
{
  "mcpServers": {
    "knock": {
      "url": "https://mcp.knock.app/mcp",
      "headers": {
        "Authorization": "Bearer ${KNOCK_SERVICE_TOKEN}"
      }
    }
  }
}
```

Service-token sessions skip the consent screen and enable **all** MCP tool groups (Management API code mode with read/write, the Knock agent, resource management, commits, debug, data management, and documentation). Least privilege comes from the token's Management API scopes, not MCP checkboxes. OAuth consent still uses the default subset unless the user explicitly selects more.

## Self-Hosting & Local Development

If you need to run the MCP server yourself (e.g. for development or custom deployments), read on.

### Prerequisites

- [Node.js](https://nodejs.org) 20.20+ or 22.22+
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
| `KNOCK_CONTROL_URL` | Management API control plane (e.g. `https://control.knock.app`) — used for Code Mode OpenAPI fetch and `execute_mapi_read` / `execute_mapi_write` |
| `COOKIE_ENCRYPTION_KEY` | Random 32-byte hex string — generate with `openssl rand -hex 32` |
| `DEV_ORIGIN` | Set to `http://localhost:8788` for local dev only |
| `POSTHOG_PROJECT_TOKEN` | PostHog project token (`phc_…`) for MCP analytics; leave unset to disable analytics |
| `POSTHOG_HOST` | PostHog ingestion host; defaults to `https://us.i.posthog.com` (use `https://eu.i.posthog.com` for EU projects) |
| `SENTRY_DSN` | Sentry DSN for error reporting; leave blank to disable |
| `INFRA_ENV` | Tag attached to Sentry events (`development`, `staging`, `production`) |

**Dynamic Worker loader (Code Mode):** this Worker declares a [`worker_loaders`](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) binding named `LOADER` in [`wrangler.jsonc`](wrangler.jsonc) for [`@cloudflare/codemode`](https://github.com/cloudflare/agents/tree/main/packages/codemode). Use a current `compatibility_date` and a recent `wrangler` / Workers runtime.

Production URLs are set in [`wrangler.jsonc`](wrangler.jsonc) under `vars`. Override them
for other deployment environments as needed.

**`COOKIE_ENCRYPTION_KEY` must be a Wrangler secret** — do not add it to `vars`. Cloudflare rejects the same binding name as both a var and a secret.

```bash
wrangler secret put COOKIE_ENCRYPTION_KEY
```

Use a random 32-byte hex value (e.g. `openssl rand -hex 32`).

**`SENTRY_DSN` should be a Wrangler secret** in any environment where errors are reported:

```bash
wrangler secret put SENTRY_DSN
```

**`POSTHOG_PROJECT_TOKEN` should be a Wrangler secret**. When configured, the server
records MCP initialization, listing, read, and tool-call events (including error state) and
attributes them to the authenticated Knock user or service-token account:

```bash
wrangler secret put POSTHOG_PROJECT_TOKEN
```

MCP analytics is disabled when the token is absent. Following the PostHog MCP Analytics
defaults, tool schemas also capture agent intent and model and support conversation
correlation. Detailed exception autocapture is disabled because Sentry is the source of truth
for errors. The SDK redacts sensitive-key values and binary content, but ordinary personal
data in tool parameters and responses is not automatically removed; use PostHog's
[`beforeSend` guidance](https://posthog.com/docs/mcp-analytics/privacy) if your deployment
requires stricter payload filtering.

The generated [`worker-configuration.d.ts`](worker-configuration.d.ts) (from `wrangler types`) types `Env` including secrets such as `COOKIE_ENCRYPTION_KEY` and `POSTHOG_PROJECT_TOKEN`, plus optional `.dev.vars` entries. See [`src/env.d.ts`](src/env.d.ts) for notes. You do not need a production `DEV_ORIGIN` unless you use the same origin-rewrite pattern as local dev.

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
    │       search_mapi / execute_mapi_read / execute_mapi_write  — Code Mode
    │       optional classic toolkit tools
    │
    ▼
Knock Management API (control.knock.app) and other Knock APIs
```

The worker is deployed on Cloudflare Workers with Durable Objects for stateful MCP sessions. It acts as both the OAuth authorization server (to MCP clients) and an OAuth client (to Knock's AuthKit). Dynamic client registration means the worker registers itself with AuthKit at runtime — no static client IDs or pre-registered redirect URIs needed. **Code Mode** uses [`@cloudflare/codemode`](https://github.com/cloudflare/agents/tree/main/packages/codemode) with a [Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) so LLM-generated code runs in an isolated sub-worker; `mapi.request()` on the host applies your OAuth token to `https://control.knock.app`.

## License

MIT — see [LICENSE](LICENSE).
