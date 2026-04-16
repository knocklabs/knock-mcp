import type { CloudflareOptions } from "@sentry/cloudflare";

export function sentryConfig(env: Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT || "development",
    enabled: Boolean(env.SENTRY_DSN),
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  };
}
