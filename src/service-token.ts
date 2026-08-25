import type { ResolveExternalTokenResult } from "@cloudflare/workers-oauth-provider";

import { getKnockControlBaseUrl } from "./knock-control-url";
import { buildServiceTokenProps } from "./session-auth";
import { sha256Hex } from "./sha256";
import {
  KNOCK_SERVICE_TOKEN_PREFIX,
  SERVICE_TOKEN_CLIENT_ID,
  type ServiceTokenIdentity,
} from "./types";

export { KNOCK_SERVICE_TOKEN_PREFIX, SERVICE_TOKEN_CLIENT_ID, type ServiceTokenIdentity };

export { buildServiceTokenProps } from "./session-auth";

const IDENTITY_CACHE_TTL_SECONDS = 15 * 60;
const IDENTITY_CACHE_KEY_PREFIX = "service-token-identity:v2:";

type IdentityCacheKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type ServiceTokenEnv = {
  OAUTH_KV: IdentityCacheKv;
  KNOCK_CONTROL_URL: string;
};

export function isKnockServiceToken(token: string): boolean {
  return token.startsWith(KNOCK_SERVICE_TOKEN_PREFIX);
}

export async function hashServiceToken(token: string): Promise<string> {
  return sha256Hex(token);
}

function identityCacheKey(tokenHash: string): string {
  return `${IDENTITY_CACHE_KEY_PREFIX}${tokenHash}`;
}

export function parseWhoamiIdentity(body: unknown): ServiceTokenIdentity | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.type !== "service_token") return null;
  if (typeof record.account_slug !== "string" || !record.account_slug) return null;
  return {
    accountSlug: record.account_slug,
    accountName:
      typeof record.account_name === "string" ? record.account_name : record.account_slug,
    serviceTokenName:
      typeof record.service_token_name === "string" ? record.service_token_name : null,
  };
}

async function readCachedIdentity(
  kv: IdentityCacheKv,
  tokenHash: string,
): Promise<ServiceTokenIdentity | null> {
  try {
    const raw = await kv.get(identityCacheKey(tokenHash));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ServiceTokenIdentity;
    if (typeof parsed.accountSlug !== "string" || !parsed.accountSlug) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedIdentity(
  kv: IdentityCacheKv,
  tokenHash: string,
  identity: ServiceTokenIdentity,
): Promise<void> {
  try {
    await kv.put(identityCacheKey(tokenHash), JSON.stringify(identity), {
      expirationTtl: IDENTITY_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("Service-token identity cache write failed", error);
  }
}

/**
 * Validates a Knock service token via Management API `/v1/whoami`.
 * Caches identity (not the token) so repeat MCP requests skip the probe.
 */
export async function validateKnockServiceToken(
  token: string,
  env: ServiceTokenEnv,
): Promise<ServiceTokenIdentity | null> {
  const tokenHash = await hashServiceToken(token);
  const cached = await readCachedIdentity(env.OAUTH_KV, tokenHash);
  if (cached) return cached;

  const url = `${getKnockControlBaseUrl(env)}/v1/whoami`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-knock-client-id": SERVICE_TOKEN_CLIENT_ID,
    },
  });

  // Only auth failures should look like "not a service token" (OAuth 401).
  // 429 / 5xx / other errors must throw so headless clients retry instead of
  // starting a browser consent flow.
  if (response.status === 401 || response.status === 403) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Knock service token validation failed (${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const identity = parseWhoamiIdentity(body);
  if (!identity) return null;

  await writeCachedIdentity(env.OAUTH_KV, tokenHash, identity);
  return identity;
}

/**
 * `resolveExternalToken` callback: accept `knock_st_…` after the OAuth provider's
 * own token lookup misses. Other bearers return null so MCP OAuth 401s still work.
 */
export async function resolveKnockServiceToken(
  token: string,
  env: ServiceTokenEnv,
): Promise<ResolveExternalTokenResult | null> {
  if (!isKnockServiceToken(token)) {
    return null;
  }

  const identity = await validateKnockServiceToken(token, env);
  if (!identity) {
    return null;
  }

  return { props: buildServiceTokenProps(token, identity) };
}
