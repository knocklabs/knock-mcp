import type { CloudflareOptions } from "@sentry/cloudflare";

export function sentryConfig(env: Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.INFRA_ENV || "development",
    enabled: Boolean(env.SENTRY_DSN),
    // Sampling 100% for now; tune down in the future as needed.
    tracesSampleRate: 1.0,
  };
}
