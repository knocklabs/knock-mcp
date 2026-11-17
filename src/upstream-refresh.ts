import * as jose from "jose";

import { nowSeconds } from "./time";
import type { KnockTokenData } from "./token-store";

const UPSTREAM_TIMEOUT_MS = 8_000;

/** Errors on the shared upstream OAuth client, not on one user's session. */
const UPSTREAM_CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client"]);

export type UpstreamFailure = {
  ok: false;
  /** `terminal` means the upstream refresh token is dead; everything else is worth retrying. */
  kind: "terminal" | "transient";
  /** Error on the shared upstream client; needs an operator, not a user. */
  clientError: boolean;
  status?: number;
  body: string;
};

export type UpstreamRefreshResult = { ok: true; data: KnockTokenData } | UpstreamFailure;

function transient(body: string, status?: number): UpstreamFailure {
  return { ok: false, kind: "transient", clientError: false, status, body };
}

function parseErrorCode(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

/**
 * Exchanges the upstream refresh token for a new access token. Never throws:
 * network errors, timeouts and malformed responses come back as transient
 * failures, and only `invalid_grant` is terminal. The timeout covers reading
 * the body, so a hung upstream cannot hold the session's refresh queue.
 */
export async function requestUpstreamRefresh(
  data: KnockTokenData,
  refreshToken: string,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<UpstreamRefreshResult> {
  try {
    const response = await fetch(data.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: data.upstreamClientId,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      const errorCode = parseErrorCode(body);
      const rejected = response.status === 400 || response.status === 401;
      return {
        ok: false,
        kind: rejected && errorCode === "invalid_grant" ? "terminal" : "transient",
        clientError:
          rejected && typeof errorCode === "string" && UPSTREAM_CLIENT_ERRORS.has(errorCode),
        status: response.status,
        body,
      };
    }

    const tokenData = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
      return transient("Upstream token response had no access_token", response.status);
    }

    let expiresAt =
      nowSeconds() + (typeof tokenData.expires_in === "number" ? tokenData.expires_in : 300);
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
        refreshToken:
          typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : refreshToken,
        expiresAt,
        tokenEndpoint: data.tokenEndpoint,
        upstreamClientId: data.upstreamClientId,
      },
    };
  } catch (error) {
    return transient(String(error));
  }
}
