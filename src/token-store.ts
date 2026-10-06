import * as jose from "jose";
import * as Sentry from "@sentry/cloudflare";

import { KNOCK_TOKEN_KV_TTL_SECONDS } from "./session-lifetimes";

const TOKEN_REFRESH_BUFFER_SECONDS = 60;
const TRANSIENT_RETRY_DELAY_MS = 250;
const TERMINAL_UPSTREAM_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

export interface KnockTokenData {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // unix timestamp in seconds
  tokenEndpoint: string;
  upstreamClientId: string;
}

/**
 * - `missing`: no `knock-token:` record for this session.
 * - `terminal`: the upstream refresh token is dead; the user has to authorize again.
 * - `transient`: the upstream call failed in a way that is worth retrying.
 */
export type KnockSessionErrorKind = "missing" | "terminal" | "transient";

export class KnockSessionError extends Error {
  readonly kind: KnockSessionErrorKind;

  constructor(kind: KnockSessionErrorKind, message: string) {
    super(message);
    this.name = "KnockSessionError";
    this.kind = kind;
  }
}

const tokenKey = (tokenId: string) => `knock-token:${tokenId}`;

export async function storeKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
): Promise<void> {
  await env.OAUTH_KV.put(tokenKey(tokenId), JSON.stringify(data), {
    expirationTtl: KNOCK_TOKEN_KV_TTL_SECONDS,
  });
}

export async function hasKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<boolean> {
  return (await env.OAUTH_KV.get(tokenKey(tokenId))) !== null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const isFresh = (data: KnockTokenData) =>
  data.expiresAt - nowSeconds() > TOKEN_REFRESH_BUFFER_SECONDS;

async function readTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<KnockTokenData | null> {
  const raw = await env.OAUTH_KV.get(tokenKey(tokenId));
  return raw ? (JSON.parse(raw) as KnockTokenData) : null;
}

type UpstreamRefreshResult =
  | { ok: true; data: KnockTokenData }
  | { ok: false; kind: "terminal" | "transient"; status?: number; body: string };

async function requestUpstreamRefresh(data: KnockTokenData): Promise<UpstreamRefreshResult> {
  let response: Response;
  try {
    response = await fetch(data.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: data.refreshToken as string,
        client_id: data.upstreamClientId,
      }),
    });
  } catch (error) {
    return { ok: false, kind: "transient", body: String(error) };
  }

  if (!response.ok) {
    const body = await response.text();
    let errorCode: unknown;
    try {
      errorCode = (JSON.parse(body) as { error?: unknown }).error;
    } catch {
      errorCode = undefined;
    }
    const terminal =
      (response.status === 400 || response.status === 401) &&
      typeof errorCode === "string" &&
      TERMINAL_UPSTREAM_ERRORS.has(errorCode);
    return { ok: false, kind: terminal ? "terminal" : "transient", status: response.status, body };
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

  return {
    ok: true,
    data: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? data.refreshToken,
      expiresAt,
      tokenEndpoint: data.tokenEndpoint,
      upstreamClientId: data.upstreamClientId,
    },
  };
}

async function refreshKnockToken(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
): Promise<string> {
  let result = await requestUpstreamRefresh(data);
  if (!result.ok && result.kind === "transient") {
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
    result = await requestUpstreamRefresh(data);
  }

  if (result.ok) {
    await storeKnockTokens(env, tokenId, result.data);
    return result.data.accessToken;
  }

  // Another isolate may have rotated the refresh token while we were in
  // flight; if so the stored record, not our stale copy, is the source of truth.
  const rotatedElsewhere =
    result.kind === "terminal"
      ? await readTokens(env, tokenId).then((latest) =>
          latest && latest.refreshToken !== data.refreshToken ? latest : null,
        )
      : null;
  if (rotatedElsewhere && isFresh(rotatedElsewhere)) {
    return rotatedElsewhere.accessToken;
  }

  console.error("Knock token refresh failed:", result.body);
  Sentry.captureMessage("Knock token refresh failed", {
    level: result.kind === "terminal" ? "warning" : "error",
    tags: { "knock.refresh_failure": result.kind },
    extra: { status: result.status, body: result.body, tokenEndpoint: data.tokenEndpoint },
  });

  if (result.kind === "terminal" && !rotatedElsewhere) {
    // Dropping the record lets the MCP endpoint answer 401 on the next request
    // so the client starts a new authorization instead of retrying tool calls.
    await env.OAUTH_KV.delete(tokenKey(tokenId));
    throw new KnockSessionError("terminal", "Knock token refresh failed. Please re-authenticate.");
  }

  throw new KnockSessionError(
    "transient",
    "Knock token refresh is temporarily unavailable. Please retry.",
  );
}

/** One upstream refresh per tokenId at a time within an isolate. */
const inflightRefreshes = new Map<string, Promise<string>>();

export async function getOrRefreshKnockToken(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  options: { renewTtl?: boolean } = {},
): Promise<string> {
  const data = await readTokens(env, tokenId);
  if (!data) {
    throw new KnockSessionError("missing", "Knock session not found. Please re-authenticate.");
  }

  if (isFresh(data)) {
    // The MCP grant slides forward on every refresh; keep this record's KV
    // expiry ahead of it even when no upstream refresh was needed.
    if (options.renewTtl) await storeKnockTokens(env, tokenId, data);
    return data.accessToken;
  }

  if (!data.refreshToken) {
    throw new KnockSessionError("terminal", "No refresh token available. Please re-authenticate.");
  }

  const existing = inflightRefreshes.get(tokenId);
  if (existing) return existing;

  const refresh = refreshKnockToken(env, tokenId, data).finally(() => {
    inflightRefreshes.delete(tokenId);
  });
  inflightRefreshes.set(tokenId, refresh);
  return refresh;
}
