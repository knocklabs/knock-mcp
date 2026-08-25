import * as jose from "jose";
import * as Sentry from "@sentry/cloudflare";

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
  const raw = await env.OAUTH_KV.get(`knock-token:${tokenId}`);
  if (!raw) {
    throw new Error("Knock session not found. Please re-authenticate.");
  }

  const data = JSON.parse(raw) as KnockTokenData;
  const now = Math.floor(Date.now() / 1000);

  if (data.expiresAt - now > TOKEN_REFRESH_BUFFER_SECONDS) {
    return data.accessToken;
  }

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

  let expiresAt: number = now + (tokenData.expires_in ?? 300);
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
