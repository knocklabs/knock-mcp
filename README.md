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

When connecting, you choose exactly which tool groups to enable:

| Group | Description |
|---|---|
| **Manage resources** | Create and manage notification workflows, channels, templates, email layouts, partials, and other configuration |
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

```bash
cp .dev.vars.example .dev.vars
```

| Variable | Description |
|---|---|
| `KNOCK_AUTH_URL` | Your Knock AuthKit domain (e.g. `https://your-app.authkit.app`) |
| `KNOCK_DASHBOARD_URL` | Knock dashboard URL (e.g. `https://dashboard.knock.app`) |
| `COOKIE_ENCRYPTION_KEY` | Random 32-byte hex string — generate with `openssl rand -hex 32` |
| `DEV_ORIGIN` | Set to `http://localhost:8788` for local dev only |

For production, set these as Wrangler secrets:

```bash
wrangler secret put KNOCK_AUTH_URL
wrangler secret put KNOCK_DASHBOARD_URL
wrangler secret put COOKIE_ENCRYPTION_KEY
```

### 4. Run locally

```bash
npm run build:client
npm run dev
```

The server starts at `http://localhost:8788`. Test with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector
```

Connect using transport `Streamable HTTP` at `http://localhost:8788/mcp`.

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
    │
    ▼
Knock API
```

The worker is deployed on Cloudflare Workers with Durable Objects for stateful MCP sessions. It acts as both the OAuth authorization server (to MCP clients) and an OAuth client (to Knock's AuthKit). Dynamic client registration means the worker registers itself with AuthKit at runtime — no static client IDs or pre-registered redirect URIs needed.

## License

MIT — see [LICENSE](LICENSE).
