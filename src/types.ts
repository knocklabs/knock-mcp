/** OAuth / tool-selection props stored on the MCP Durable Object (see workers-oauth-provider). */
export interface Props extends Record<string, unknown> {
  tokenId: string;
  clientId?: string;
  userId?: string;
  email?: string;
  selectedGroups?: string[];
}
