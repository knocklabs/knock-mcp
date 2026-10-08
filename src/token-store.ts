import { MCP_GRANT_TTL_SECONDS } from "./session-lifetimes";
import { nowSeconds } from "./time";
import { requestUpstreamRefresh, type UpstreamFailure } from "./upstream-refresh";
import * as Sentry from "@sentry/cloudflare";

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

const SESSION_ERROR_MESSAGES: Record<KnockSessionErrorKind, string> = {
  missing: "Knock session not found. Please re-authenticate.",
  terminal: "Knock token refresh failed. Please re-authenticate.",
  transient: "Knock token refresh is temporarily unavailable. Please retry.",
};

export class KnockSessionError extends Error {
  constructor(readonly kind: KnockSessionErrorKind) {
    super(SESSION_ERROR_MESSAGES[kind]);
    this.name = "KnockSessionError";
  }
}

/** What went wrong upstream. Plain data, so it survives the trip back from the lock Durable Object. */
export type RefreshReport = { status?: number; body: string; clientError: boolean };

/**
 * Result of a refresh. Returned instead of thrown because error classes do not
 * survive Durable Object RPC. The lock Durable Object has no Sentry client, so
 * anything worth reporting travels in the outcome and is reported by the caller.
 */
export type RefreshOutcome =
  | { ok: true; accessToken: string; persistFailed?: boolean }
  | { ok: false; kind: KnockSessionErrorKind; report?: RefreshReport };

export type RefreshOptions = { renewTtl?: boolean };

const tokenKey = (tokenId: string) => `knock-token:${tokenId}`;

const isFresh = (data: KnockTokenData) =>
  data.expiresAt - nowSeconds() > TOKEN_REFRESH_BUFFER_SECONDS;

const isRecord = (value: unknown): value is KnockTokenData =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as KnockTokenData).accessToken === "string" &&
  typeof (value as KnockTokenData).expiresAt === "number" &&
  typeof (value as KnockTokenData).tokenEndpoint === "string";

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
  if (!data) throw new KnockSessionError("missing");
  await storeKnockTokens(env, tokenId, data);
}

async function readTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<KnockTokenData | null> {
  const raw = await env.OAUTH_KV.get(tokenKey(tokenId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Falls through: an unreadable record is as good as none.
  }
  return null;
}

/** Whether a readable record exists. Read-only, so the per-request guard never writes. */
export async function hasKnockTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<boolean> {
  return (await readTokens(env, tokenId)) !== null;
}

type FailureDecision =
  | { action: "drop" }
  | { action: "remember"; failingSince: number }
  | { action: "keep" };

/**
 * What to do with a session after a failed upstream refresh. Only
 * `invalid_grant` kills a session at once. Errors on the shared client never
 * count toward the failure bound, because they are not this user's fault.
 * Anything else is retried until it has been failing for a full day.
 */
export function decideFailure(
  data: Pick<KnockTokenData, "failingSince">,
  failure: Pick<UpstreamFailure, "kind" | "clientError">,
  now: number,
): FailureDecision {
  if (failure.kind === "terminal") return { action: "drop" };
  if (failure.clientError) return { action: "keep" };

  const failingSince = data.failingSince ?? now;
  if (now - failingSince > MAX_TRANSIENT_FAILURE_SECONDS) return { action: "drop" };
  return data.failingSince === undefined
    ? { action: "remember", failingSince }
    : { action: "keep" };
}

/** Removing the record makes the MCP endpoint answer 401 on the next request, so the client re-authorizes. */
async function dropSession(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
): Promise<Extract<RefreshOutcome, { ok: false }>> {
  await env.OAUTH_KV.delete(tokenKey(tokenId));
  return { ok: false, kind: "terminal" };
}

/**
 * The upstream rotated the refresh token, so losing this write loses the
 * session. Retry, and report whether it stuck so the caller can raise the alarm
 * while this request still proceeds with the access token it has.
 */
async function persistRotatedTokens(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
): Promise<boolean> {
  for (let attempt = 1; attempt <= KV_WRITE_ATTEMPTS; attempt++) {
    try {
      await storeKnockTokens(env, tokenId, data);
      return true;
    } catch (error) {
      if (attempt === KV_WRITE_ATTEMPTS)
        console.error("Failed to persist rotated Knock tokens:", error);
    }
  }
  return false;
}

async function handleRefreshFailure(
  env: Pick<Env, "OAUTH_KV">,
  tokenId: string,
  data: KnockTokenData,
  failure: UpstreamFailure,
): Promise<RefreshOutcome> {
  console.error("Knock token refresh failed:", failure.body);
  const report: RefreshReport = {
    status: failure.status,
    body: failure.body,
    clientError: failure.clientError,
  };

  const decision = decideFailure(data, failure, nowSeconds());
  if (decision.action === "drop") return { ...(await dropSession(env, tokenId)), report };

  if (decision.action === "remember") {
    await storeKnockTokens(env, tokenId, { ...data, failingSince: decision.failingSince }).catch(
      () => undefined,
    );
  }
  return { ok: false, kind: "transient", report };
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

  if (!data.refreshToken) return dropSession(env, tokenId);

  let result = await requestUpstreamRefresh(data, data.refreshToken);
  if (!result.ok && result.kind === "transient") {
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
    result = await requestUpstreamRefresh(data, data.refreshToken);
  }

  if (!result.ok) return handleRefreshFailure(env, tokenId, data, result);

  const persisted = await persistRotatedTokens(env, tokenId, result.data);
  return {
    ok: true,
    accessToken: result.data.accessToken,
    ...(persisted ? {} : { persistFailed: true }),
  };
}

function reportOutcome(outcome: RefreshOutcome): void {
  if (outcome.ok) {
    if (outcome.persistFailed) {
      Sentry.captureMessage("Failed to persist rotated Knock tokens", {
        level: "error",
        tags: { stage: "persist_rotated_tokens" },
      });
    }
    return;
  }
  if (!outcome.report) return;

  Sentry.captureMessage("Knock token refresh failed", {
    level: outcome.report.clientError ? "error" : "warning",
    tags: { "knock.refresh_failure": outcome.report.clientError ? "client_error" : outcome.kind },
    extra: { status: outcome.report.status, body: outcome.report.body },
  });
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
  if (!data) throw new KnockSessionError("missing");

  if (isFresh(data) && !options.renewTtl) return data.accessToken;

  const lock = env.KNOCK_TOKEN_LOCK.get(env.KNOCK_TOKEN_LOCK.idFromName(tokenId));
  const outcome = await lock.refresh(tokenId, options);
  reportOutcome(outcome);
  if (outcome.ok) return outcome.accessToken;
  throw new KnockSessionError(outcome.kind);
}
