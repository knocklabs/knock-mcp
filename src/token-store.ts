import * as jose from "jose";
import * as Sentry from "@sentry/cloudflare";

import { keepAlive } from "./keep-alive";

const TOKEN_REFRESH_BUFFER_SECONDS = 60;
const TOKEN_KV_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface KnockTokenData {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // unix timestamp in seconds
  tokenEndpoint: string;
  upstreamClientId: string;
}

export async function storeKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
): Promise<void> {
  await env.OAUTH_KV.put(`knock-token:${tokenId}`, JSON.stringify(data), {
    expirationTtl: TOKEN_KV_TTL_SECONDS,
  });
}

export async function getOrRefreshKnockToken(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<string> {
  const data = await readKnockTokens(env, tokenId);
  if (!data) {
    throw new Error("Knock session not found. Please re-authenticate.");
  }
  if (isFresh(data)) return data.accessToken;

  // Refreshing uses up the stored refresh token, so once started it has to finish and be stored.
  return keepAlive(refreshKnockToken(env, tokenId, data));
}

async function readKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<KnockTokenData | undefined> {
  const raw = await env.OAUTH_KV.get(`knock-token:${tokenId}`);
  return raw ? (JSON.parse(raw) as KnockTokenData) : undefined;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const isFresh = (data: KnockTokenData) =>
  data.expiresAt - nowSeconds() > TOKEN_REFRESH_BUFFER_SECONDS;

/** Waits between looks for a token that a parallel request refreshed first. */
const PARALLEL_REFRESH_WAITS_MS = [100, 400, 1_000];

/**
 * The token a parallel request stored, when it used up our refresh token
 * first. It may still be storing it, so this looks a few times.
 */
async function tokenRefreshedElsewhere(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  used: KnockTokenData,
): Promise<string | undefined> {
  for (const wait of PARALLEL_REFRESH_WAITS_MS) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const stored = await readKnockTokens(env, tokenId);
    if (stored && stored.refreshToken !== used.refreshToken && isFresh(stored)) {
      return stored.accessToken;
    }
  }
  return undefined;
}

async function refreshKnockToken(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
): Promise<string> {
  if (!data.refreshToken) {
    throw new Error("No refresh token available. Please re-authenticate.");
  }

  const response = await fetch(data.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: data.refreshToken,
      client_id: data.upstreamClientId,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const elsewhere = await tokenRefreshedElsewhere(env, tokenId, data);
    if (elsewhere) return elsewhere;
    console.error("Knock token refresh failed:", errorText);
    Sentry.captureMessage("Knock token refresh failed", {
      level: "error",
      extra: { status: response.status, body: errorText, tokenEndpoint: data.tokenEndpoint },
    });
    throw new Error("Knock token refresh failed. Please re-authenticate.");
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  let expiresAt: number = nowSeconds() + (tokenData.expires_in ?? 300);
  try {
    const claims = jose.decodeJwt(tokenData.access_token);
    if (typeof claims.exp === "number") expiresAt = claims.exp;
  } catch {
    // Non-JWT access token; fall back to expires_in or default
  }

  const updated: KnockTokenData = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? data.refreshToken,
    expiresAt,
    tokenEndpoint: data.tokenEndpoint,
    upstreamClientId: data.upstreamClientId,
  };

  await storeKnockTokens(env, tokenId, updated);
  return updated.accessToken;
}
