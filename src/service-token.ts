import type { ResolveExternalTokenResult } from "@cloudflare/workers-oauth-provider";

import { getKnockControlBaseUrl } from "./knock-control-url";
import { defaultSelectedGroupKeys } from "./tool-groups";
import type { Props } from "./types";

/** Knock Management API service tokens (`https://docs.knock.app/developer-tools/service-tokens`). */
export const KNOCK_SERVICE_TOKEN_PREFIX = "knock_st_";

/** Sentinel `x-knock-client-id` for service-token MCP sessions (no AuthKit client). */
export const SERVICE_TOKEN_CLIENT_ID = "knock-mcp-service-token";

const IDENTITY_CACHE_TTL_SECONDS = 15 * 60;
const IDENTITY_CACHE_KEY_PREFIX = "service-token-identity:v2:";

export interface ServiceTokenIdentity {
  accountSlug: string;
  accountName: string;
  serviceTokenName?: string | null;
}

type ServiceTokenKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type ServiceTokenEnv = {
  OAUTH_KV: ServiceTokenKv;
  KNOCK_CONTROL_URL: string;
};

export function isKnockServiceToken(token: string): boolean {
  return token.startsWith(KNOCK_SERVICE_TOKEN_PREFIX);
}

export function buildServiceTokenProps(
  serviceToken: string,
  identity?: ServiceTokenIdentity,
): Props {
  return {
    authKind: "service_token",
    serviceToken,
    clientId: SERVICE_TOKEN_CLIENT_ID,
    selectedGroups: defaultSelectedGroupKeys(),
    mapiAccessMode: "read_write",
    ...(identity ? { accountSlug: identity.accountSlug, accountName: identity.accountName } : {}),
  };
}

export async function hashServiceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function identityCacheKey(tokenHash: string): string {
  return `${IDENTITY_CACHE_KEY_PREFIX}${tokenHash}`;
}

export function parseWhoamiIdentity(body: unknown): ServiceTokenIdentity | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.account_slug !== "string" || !record.account_slug) return null;
  if (record.type === "oauth_context") return null;
  return {
    accountSlug: record.account_slug,
    accountName: typeof record.account_name === "string" ? record.account_name : record.account_slug,
    serviceTokenName:
      typeof record.service_token_name === "string" ? record.service_token_name : null,
  };
}

async function readCachedIdentity(
  kv: ServiceTokenKv,
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
  kv: ServiceTokenKv,
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

  if (response.status >= 500) {
    throw new Error(`Knock service token validation failed (${response.status})`);
  }

  if (!response.ok) {
    return null;
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
