/**
 * `worker-configuration.d.ts` (from `wrangler types`) is the source of truth for `Env` bindings.
 * - `COOKIE_ENCRYPTION_KEY` and `SENTRY_DSN` are Wrangler secrets — do not add them to
 *   `wrangler.jsonc` vars (same binding name cannot be both a var and a secret).
 * - `DEV_ORIGIN` is local-only; set in `.dev.vars` when using `wrangler dev`.
 * - `LOADER` is the `worker_loaders` binding for @cloudflare/codemode (see `wrangler.jsonc`).
 * - `KNOCK_CONTROL_URL` is the Management API base URL (see `wrangler.jsonc` vars).
 *
 * CI `wrangler types` omits `.dev.vars` / secrets. The oauth provider types `fetch`
 * as `Cloudflare.Env`, so declare the missing bindings there and point `Env` at it.
 */
declare namespace Cloudflare {
  interface Env {
    DEV_ORIGIN: string;
    COOKIE_ENCRYPTION_KEY: string;
    SENTRY_DSN: string;
  }
}

interface Env extends Cloudflare.Env {}
