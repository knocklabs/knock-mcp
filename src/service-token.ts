import type { ResolveExternalTokenResult } from "@cloudflare/workers-oauth-provider";

import { getKnockControlBaseUrl } from "./knock-control-url";
import { defaultSelectedGroupKeys } from "./tool-groups";
import type { Props } from "./types";

/** Knock Management API service tokens (`https://docs.knock.app/developer-tools/service-tokens`). */
export const KNOCK_SERVICE_TOKEN_PREFIX = "knock_st_";

/** Sentinel `x-knock-client-id` for service-token MCP sessions (no AuthKit client). */
export const SERVICE_TOKEN_CLIENT_ID = "knock-mcp-service-token";

const IDENTITY_CACHE_TTL_SECONDS = 15 * 60;
const IDENTITY_CACHE_KEY_PREFIX = "service-token-identity:v1:";

interface CachedIdentity {
  valid: true;
}

export function isKnockServiceToken(token: string): boolean {
  return token.startsWith(KNOCK_SERVICE_TOKEN_PREFIX);
}

export function buildServiceTokenProps(serviceToken: string): Props {
  return {
    authKind: "service_token",
    serviceToken,
    clientId: SERVICE_TOKEN_CLIENT_ID,
    selectedGroups: defaultSelectedGroupKeys(),
    mapiAccessMode: "read_write",
  };
}

export async function hashServiceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ServiceTokenKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type ServiceTokenEnv = {
  OAUTH_KV: ServiceTokenKv;
  KNOCK_CONTROL_URL: string;
};

function identityCacheKey(tokenHash: string): string {
  return `${IDENTITY_CACHE_KEY_PREFIX}${tokenHash}`;
}

async function readCachedIdentity(kv: ServiceTokenKv, tokenHash: string): Promise<boolean> {
  try {
    const raw = await kv.get(identityCacheKey(tokenHash));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as CachedIdentity;
    return parsed.valid === true;
  } catch {
    return false;
  }
}

async function writeCachedIdentity(kv: ServiceTokenKv, tokenHash: string): Promise<void> {
  try {
    await kv.put(identityCacheKey(tokenHash), JSON.stringify({ valid: true } satisfies CachedIdentity), {
      expirationTtl: IDENTITY_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("Service-token identity cache write failed", error);
  }
}

/**
 * Validates a Knock service token against the Management API.
 * Caches identity (not the token) so repeat MCP requests skip the probe.
 */
export async function validateKnockServiceToken(
  token: string,
  env: ServiceTokenEnv,
): Promise<boolean> {
  const tokenHash = await hashServiceToken(token);
  if (await readCachedIdentity(env.OAUTH_KV, tokenHash)) {
    return true;
  }

  const url = `${getKnockControlBaseUrl(env)}/v1/environments`;
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
    return false;
  }

  await writeCachedIdentity(env.OAUTH_KV, tokenHash);
  return true;
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

  const valid = await validateKnockServiceToken(token, env);
  if (!valid) {
    return null;
  }

  return { props: buildServiceTokenProps(token) };
}
