/**
 * Bindings not declared in `worker-configuration.d.ts` (from `wrangler types`).
 * - `COOKIE_ENCRYPTION_KEY` is a Wrangler secret — do not add it to `wrangler.jsonc` vars
 *   (same binding name cannot be both a var and a secret).
 * - `DEV_ORIGIN` is local-only; set in `.dev.vars` when using `wrangler dev`.
 */
interface Env {
  DEV_ORIGIN: string;
  COOKIE_ENCRYPTION_KEY: string;
}
