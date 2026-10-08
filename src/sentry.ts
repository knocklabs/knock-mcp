import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { CloudflareOptions, ErrorEvent, Event } from "@sentry/cloudflare";

import { CALLBACK_ERROR_CATEGORY, CALLBACK_ERROR_REASON } from "./callback-reasons";

const REDACTED = "[Filtered]";
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);
const SENSITIVE_OBJECT_KEYS = new Set([
  "authorization",
  "cookie",
  "servicetoken",
  "service_token",
  "accesstoken",
  "access_token",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_OBJECT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9_]/g, ""));
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED : value;
  }
  return redacted;
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : nested;
  }
  return redacted;
}

type OAuthProviderError = Parameters<NonNullable<OAuthProviderOptions["onError"]>>[0];

/** Callback 503s whose cause was already reported where it happened. */
const REPORTED_ELSEWHERE = new Set<string>([
  CALLBACK_ERROR_REASON.upstreamUnavailable,
  CALLBACK_ERROR_REASON.unexpectedError,
]);

/**
 * Expected MCP client protocol rejections (expired refresh tokens, stale
 * access tokens, resource/audience mismatch, malformed requests). Those are
 * useful as Cloudflare logs, not as Sentry issues.
 *
 * Since 1.x every provider error carries `internal`, so its mere presence no
 * longer marks an error as unexpected. Allowlist: 5xx / `server_error`, plus
 * CIMD document fetch failures (which reach the wire as a generic
 * `invalid_client`), minus the refresh-callback 503s that are reported by the
 * code that hit the underlying failure.
 */
export function shouldCaptureOAuthProviderError(error: OAuthProviderError): boolean {
  if (
    error.internal.category === CALLBACK_ERROR_CATEGORY &&
    REPORTED_ELSEWHERE.has(error.internal.reason)
  ) {
    return false;
  }
  return (
    error.status >= 500 ||
    error.code === "server_error" ||
    error.internal.category === "client-id-metadata-document"
  );
}

/** Drop bearer credentials and service tokens from Sentry event payloads. */
export function redactSentryEvent<T extends Event>(event: T): T {
  if (event.request?.headers) {
    event.request.headers = redactHeaders(event.request.headers);
  }
  if (event.extra && typeof event.extra === "object") {
    event.extra = redactObject(event.extra as Record<string, unknown>);
  }
  return event;
}

export function sentryConfig(env: Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.INFRA_ENV || "development",
    enabled: Boolean(env.SENTRY_DSN),
    // Sampling 100% for now; tune down in the future as needed.
    tracesSampleRate: 1.0,
    beforeSend(event: ErrorEvent) {
      return redactSentryEvent(event);
    },
    beforeSendTransaction(event) {
      return redactSentryEvent(event);
    },
  };
}
