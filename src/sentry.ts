import type { CloudflareOptions, ErrorEvent, Event } from "@sentry/cloudflare";

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

/**
 * OAuth provider `onError` payload. `internal` is server-only diagnostic
 * the library keeps off the wire (e.g. CIMD metadata fetch failures).
 */
export type OAuthProviderErrorInfo = {
  code: string;
  description: string;
  status: number;
  internal?: { category: string; reason: string; detail?: unknown };
};

/**
 * Expected MCP client protocol rejections (expired refresh tokens, stale
 * access tokens, resource/audience mismatch, malformed requests). Those are
 * useful as Cloudflare logs, not as Sentry issues.
 *
 * Still report 5xx / `server_error`, and any error with `internal` — that is
 * why `onError` was added (CIMD fetch failures at `/token` land as a generic
 * `invalid_client` on the wire).
 */
export function shouldCaptureOAuthProviderError(error: OAuthProviderErrorInfo): boolean {
  if (error.status >= 500 || error.code === "server_error") return true;
  return Boolean(error.internal);
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
