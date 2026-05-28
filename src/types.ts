/** OAuth / tool-selection props stored on the MCP Durable Object (see workers-oauth-provider). */
export type MapiAccessMode = "read" | "read_write";

export interface Props extends Record<string, unknown> {
  tokenId: string;
  clientId: string;
  userId?: string;
  email?: string;
  selectedGroups?: string[];
  /** Set when Management API (code mode) is enabled; defaults to read_write for legacy sessions. */
  mapiAccessMode?: MapiAccessMode;
}
