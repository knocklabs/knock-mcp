#!/usr/bin/env bash
# Idempotent bootstrap for the Knock MCP Cloudflare Worker + Vite client.
# Safe to run repeatedly; installs deps, builds the client, and generates
# Wrangler runtime types. Also seeds a local .dev.vars for `wrangler dev`.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing root dependencies"
npm install

echo "==> Installing client dependencies and building the client UI"
npm run build:client

echo "==> Generating Wrangler runtime types (worker-configuration.d.ts)"
npm run cf-typegen

# `wrangler dev` reads local, non-production values from .dev.vars (gitignored).
# Seed it once from the example with a freshly generated cookie key so the local
# OAuth flow works out of the box. Never overwrite an existing file.
if [ ! -f .dev.vars ]; then
  echo "==> Seeding .dev.vars for local development"
  cp .dev.vars.example .dev.vars
  key="$(openssl rand -hex 32)"
  sed -i "s|your_random_32_byte_hex_secret_here|${key}|" .dev.vars
  sed -i "s|^INFRA_ENV=.*|INFRA_ENV=development|" .dev.vars
else
  echo "==> .dev.vars already present; leaving it untouched"
fi

echo "==> Install complete"
