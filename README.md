# Knock MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for [Knock](https://knock.app) that lets AI assistants manage notifications, workflows, channels, and more — all authenticated via Knock's OAuth flow.

## Features

- **OAuth 2.1 + PKCE** — secure authorization using Knock's AuthKit, with dynamic client registration so no redirect URIs need pre-configuring
- **Tool selection consent screen** — users choose exactly which capabilities to grant before authorizing
- **Granular tool groups** — five intent-based groups map to the underlying Knock API categories:

  | Group | What it does |
  |---|---|
  | Manage resources | Create and manage workflows, channels, templates, and other configuration |
  | Commits | Commit and promote changes across environments |
  | Debug | Inspect environments and view sent message logs |
  | Manage data | Manage users, tenants, and object data |
  | Documentation | Search Knock documentation and guides |

- **Deployed on Cloudflare Workers** with Durable Objects for stateful MCP sessions

## Architecture

```
MCP Client (e.g. Claude Desktop)
    │
    ▼ OAuth 2.1 + PKCE
Cloudflare Worker (this repo)
    │  ├─ /mcp          — MCP endpoint (Durable Object)
    │  ├─ /authorize    — OAuth consent + tool selection UI
    │  └─ /callback     — Token exchange with Knock AuthKit
    │
    ▼ Dynamic Client Registration
Knock AuthKit (WorkOS)
```

The worker acts as both the OAuth authorization server (to MCP clients) and an OAuth client (to Knock's AuthKit). Dynamic client registration means the worker registers itself with AuthKit at runtime with the exact callback URL it's using — no static client IDs or pre-registered redirect URIs needed.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled
- A Knock account with AuthKit configured

### 1. Install dependencies

```bash
npm install
npm install --prefix client
```

### 2. Create a KV namespace

```bash
wrangler kv namespace create MCP_OAUTH_KV
```

Copy the returned `id` into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "MCP_OAUTH_KV",
    "id": "your-namespace-id-here"
  }
]
```

### 3. Configure environment variables

Copy `.dev.vars.example` to `.dev.vars` and fill in the values:

```bash
cp .dev.vars.example .dev.vars
```

| Variable | Description |
|---|---|
| `KNOCK_AUTH_URL` | Your Knock AuthKit domain (e.g. `https://your-app.authkit.app`) |
| `KNOCK_DASHBOARD_URL` | Knock dashboard URL — used for branding (`https://dashboard.knock.app`) |
| `COOKIE_ENCRYPTION_KEY` | Random 32-byte hex string — generate with `openssl rand -hex 32` |
| `DEV_ORIGIN` | Set to `http://localhost:8788` for local dev only |

For production, set these as Wrangler secrets:

```bash
wrangler secret put KNOCK_AUTH_URL
wrangler secret put KNOCK_DASHBOARD_URL
wrangler secret put COOKIE_ENCRYPTION_KEY
```

### 4. Local development

```bash
# Build the consent UI and start the worker
npm run build:client
npm run dev
```

The server starts at `http://localhost:8788`. Test with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector
```

Connect with transport `Streamable HTTP` at `http://localhost:8788/mcp`.

### 5. Deploy

```bash
npm run deploy
```

This builds the client, then deploys to Cloudflare Workers. Update `wrangler.jsonc` with your custom domain:

```jsonc
"routes": [
  {
    "pattern": "mcp.your-domain.com",
    "custom_domain": true
  }
]
```

## Connecting an MCP client

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "knock": {
      "type": "http",
      "url": "https://mcp.your-domain.com/mcp"
    }
  }
}
```

On first connection, Claude will open a browser window to authorize and select which capabilities to grant.

## License

MIT — see [LICENSE](LICENSE).
