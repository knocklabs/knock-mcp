import type { KnockClientApplicationInfo } from "./knock-client-user-agent";

export type { KnockClientApplicationInfo };

/** OAuth / tool-selection props stored on the MCP Durable Object (see workers-oauth-provider). */
export type MapiAccessMode = "read" | "read_write";

export type AuthKind = "oauth" | "service_token";

/**
 * Persistence bag on the MCP Durable Object.
 *
 * Dual auth is encoded as optional fields because workers-oauth-provider
 * stores a flat `Record` and legacy OAuth sessions omit `authKind`.
 * Do not branch on `tokenId` / `serviceToken` at call sites — use
 * `sessionAuthFromProps` / `resolveKnockAccessToken` in `session-auth.ts`.
 */
export interface Props extends Record<string, unknown> {
  /** KV pointer for AuthKit tokens. Absent on service-token sessions. */
  tokenId?: string;
  clientId: string;
  userId?: string;
  email?: string;
  selectedGroups?: string[];
  /** Set when Management API (code mode) is enabled; defaults to read_write for legacy sessions. */
  mapiAccessMode?: MapiAccessMode;
  /** OAuth MCP client (e.g. Cursor, Claude Desktop) for partner attribution on outbound API calls. */
  clientApplication?: KnockClientApplicationInfo;
  /** How this MCP session authenticated. Omitted on legacy OAuth sessions. */
  authKind?: AuthKind;
  /**
   * Knock Management API service token (`knock_st_…`), set per request for
   * service-token sessions. Never persist this in `knock-token:` KV.
   */
  serviceToken?: string;
  /** Account slug from Management API `/v1/whoami` (service-token sessions). */
  accountSlug?: string;
  /** Account display name from Management API `/v1/whoami` (service-token sessions). */
  accountName?: string;
}
