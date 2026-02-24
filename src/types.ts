export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  KNOCK_AUTH_URL: string;
  KNOCK_DASHBOARD_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  ASSETS: Fetcher;
  /** Set in .dev.vars to override the base URL when wrangler rewrites the domain */
  DEV_ORIGIN?: string;
}

export interface Props extends Record<string, unknown> {
  tokenId: string;
  clientId?: string;
  userId?: string;
  email?: string;
  selectedGroups?: string[];
}
