import * as jose from "jose";
import * as Sentry from "@sentry/cloudflare";

import { MCP_GRANT_TTL_SECONDS } from "./session-lifetimes";
import { nowSeconds } from "./time";

const TOKEN_REFRESH_BUFFER_SECONDS = 60;
const TRANSIENT_RETRY_DELAY_MS = 250;
const KV_WRITE_ATTEMPTS = 3;

/** Outlives the grant it belongs to; renewed whenever the grant slides forward. */
const KNOCK_TOKEN_KV_TTL_SECONDS = MCP_GRANT_TTL_SECONDS + 60 * 60 * 24;

/** Until a grant is issued nothing can use the record, so it expires with the consent flow. */
const PENDING_KNOCK_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Upstream failures that are not `invalid_grant` are retried for this long
 * before the session is declared dead, so a permanent upstream rejection
 * eventually reaches re-authentication while an outage does not log users out.
 */
const MAX_TRANSIENT_FAILURE_SECONDS = 24 * 60 * 60;

/** Errors on the shared upstream OAuth client, not on one user's session. */
const UPSTREAM_CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client"]);

export interface KnockTokenData {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // unix timestamp in seconds
  tokenEndpoint: string;
  upstreamClientId: string;
  /** Unix seconds of the first upstream failure since the last successful refresh. */
  failingSince?: number;
}

/**
 * - `missing`: no `knock-token:` record for this session.
 * - `terminal`: the upstream session is dead; the user has to authorize again.
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

const SESSION_ERROR_MESSAGES: Record<KnockSessionErrorKind, string> = {
  missing: "Knock session not found. Please re-authenticate.",
  terminal: "Knock token refresh failed. Please re-authenticate.",
  transient: "Knock token refresh is temporarily unavailable. Please retry.",
};

export type RefreshOutcome =
  | { ok: true; accessToken: string }
  | { ok: false; kind: KnockSessionErrorKind };

type RefreshOptions = { renewTtl?: boolean };

const tokenKey = (tokenId: string) => `knock-token:${tokenId}`;

const isFresh = (data: KnockTokenData) =>
  data.expiresAt - nowSeconds() > TOKEN_REFRESH_BUFFER_SECONDS;

export async function storeKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
  ttlSeconds = KNOCK_TOKEN_KV_TTL_SECONDS,
): Promise<void> {
  await env.OAUTH_KV.put(tokenKey(tokenId), JSON.stringify(data), { expirationTtl: ttlSeconds });
}

/** Stores the record written during sign-in, before any grant refers to it. */
export function storePendingKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
): Promise<void> {
  return storeKnockTokens(env, tokenId, data, PENDING_KNOCK_TOKEN_TTL_SECONDS);
}

/** Extends a pending record to the full grant lifetime once its grant exists. */
export async function activateKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<void> {
  const data = await readTokens(env, tokenId);
  if (!data) throw new KnockSessionError("missing", SESSION_ERROR_MESSAGES.missing);
  await storeKnockTokens(env, tokenId, data);
}

async function readTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<KnockTokenData | null> {
  const raw = await env.OAUTH_KV.get(tokenKey(tokenId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KnockTokenData;
  } catch {
    await env.OAUTH_KV.delete(tokenKey(tokenId));
    return null;
  }
}

export async function hasKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<boolean> {
  return (await readTokens(env, tokenId)) !== null;
}

type UpstreamFailure = {
  ok: false;
  kind: "terminal" | "transient";
  /** Error on the shared upstream client; needs an operator, not a user. */
  clientError: boolean;
  status?: number;
  body: string;
};

async function requestUpstreamRefresh(
  data: KnockTokenData,
  refreshToken: string,
): Promise<{ ok: true; data: KnockTokenData } | UpstreamFailure> {
  let response: Response;
  try {
    response = await fetch(data.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: data.upstreamClientId,
      }),
    });
  } catch (error) {
    return { ok: false, kind: "transient", clientError: false, body: String(error) };
  }

  if (!response.ok) {
    const body = await response.text();
    let errorCode: unknown;
    try {
      errorCode = (JSON.parse(body) as { error?: unknown }).error;
    } catch {
      errorCode = undefined;
    }
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
      refreshToken: tokenData.refresh_token ?? refreshToken,
      expiresAt,
      tokenEndpoint: data.tokenEndpoint,
      upstreamClientId: data.upstreamClientId,
    },
  };
}

/**
 * The upstream rotated the refresh token, so losing this write loses the
 * session. Retry, and if it still fails hand back the access token we have:
 * this request can proceed and the failure is loud in Sentry.
 */
async function persistRotatedTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
): Promise<void> {
  for (let attempt = 1; attempt <= KV_WRITE_ATTEMPTS; attempt++) {
    try {
      await storeKnockTokens(env, tokenId, data);
      return;
    } catch (error) {
      if (attempt === KV_WRITE_ATTEMPTS) {
        console.error("Failed to persist rotated Knock tokens:", error);
        Sentry.captureException(error, { tags: { stage: "persist_rotated_tokens" } });
      }
    }
  }
}

function reportRefreshFailure(failure: UpstreamFailure, data: KnockTokenData): void {
  console.error("Knock token refresh failed:", failure.body);
  Sentry.captureMessage("Knock token refresh failed", {
    level: failure.clientError ? "error" : "warning",
    tags: { "knock.refresh_failure": failure.clientError ? "client_error" : failure.kind },
    extra: { status: failure.status, body: failure.body, tokenEndpoint: data.tokenEndpoint },
  });
}

async function handleRefreshFailure(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
  failure: UpstreamFailure,
): Promise<RefreshOutcome> {
  reportRefreshFailure(failure, data);

  const failingSince = data.failingSince ?? nowSeconds();
  const exhausted =
    failure.kind === "transient" &&
    !failure.clientError &&
    nowSeconds() - failingSince > MAX_TRANSIENT_FAILURE_SECONDS;

  if (failure.kind === "terminal" || exhausted) {
    // Dropping the record lets the MCP endpoint answer 401 on the next request
    // so the client starts a new authorization instead of retrying tool calls.
    await env.OAUTH_KV.delete(tokenKey(tokenId));
    return { ok: false, kind: "terminal" };
  }

  if (data.failingSince === undefined && !failure.clientError) {
    await storeKnockTokens(env, tokenId, { ...data, failingSince }).catch(() => undefined);
  }
  return { ok: false, kind: "transient" };
}

/**
 * Returns a usable upstream access token for the session, refreshing it
 * upstream when it is stale. The upstream rotates refresh tokens on every use,
 * so callers must reach this through `getOrRefreshKnockToken`, which funnels
 * every refresh for a session through a single Durable Object.
 */
export async function refreshKnockSession(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const data = await readTokens(env, tokenId);
  if (!data) return { ok: false, kind: "missing" };

  if (isFresh(data)) {
    // The MCP grant slides forward on every refresh; keep this record's KV
    // expiry ahead of it. Renewal is best-effort and never fails the refresh.
    if (options.renewTtl) await storeKnockTokens(env, tokenId, data).catch(() => undefined);
    return { ok: true, accessToken: data.accessToken };
  }

  if (!data.refreshToken) {
    await env.OAUTH_KV.delete(tokenKey(tokenId));
    return { ok: false, kind: "terminal" };
  }

  let result = await requestUpstreamRefresh(data, data.refreshToken);
  if (!result.ok && result.kind === "transient") {
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
    result = await requestUpstreamRefresh(data, data.refreshToken);
  }

  if (result.ok) {
    await persistRotatedTokens(env, tokenId, result.data);
    return { ok: true, accessToken: result.data.accessToken };
  }

  return handleRefreshFailure(env, tokenId, data, result);
}

/** Runs tasks one at a time, so a Durable Object serializes work for its session. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * The upstream access token for an OAuth session, refreshed when stale.
 * Throws `KnockSessionError` when the session is gone or cannot be refreshed.
 *
 * Fresh tokens are served straight from KV. Anything that may call the
 * upstream, or write the record, goes through the session's lock Durable
 * Object because the upstream invalidates the old refresh token on each use.
 */
export async function getOrRefreshKnockToken(
  env: Pick<Env, "OAUTH_KV" | "KNOCK_TOKEN_LOCK">,
  tokenId: string,
  options: RefreshOptions = {},
): Promise<string> {
  const data = await readTokens(env, tokenId);
  if (!data) throw new KnockSessionError("missing", SESSION_ERROR_MESSAGES.missing);

  if (isFresh(data) && !options.renewTtl) return data.accessToken;

  const lock = env.KNOCK_TOKEN_LOCK.get(env.KNOCK_TOKEN_LOCK.idFromName(tokenId));
  const outcome = await lock.refresh(tokenId, options);
  if (outcome.ok) return outcome.accessToken;
  throw new KnockSessionError(outcome.kind, SESSION_ERROR_MESSAGES[outcome.kind]);
}
