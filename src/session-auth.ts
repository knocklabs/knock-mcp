import * as Sentry from "@sentry/cloudflare";

import { getOrRefreshKnockToken } from "./token-store";
import { allToolGroupKeys } from "./tool-groups";
import {
  SERVICE_TOKEN_CLIENT_ID,
  type AuthKind,
  type KnockClientApplicationInfo,
  type MapiAccessMode,
  type Props,
  type ServiceTokenIdentity,
} from "./types";

export const MISSING_SESSION_CREDENTIALS =
  "MCP session missing Knock credentials; please re-authenticate.";

/**
 * Operational credential model for an MCP session.
 * `Props` is the Durable Object persistence bag; this is what call sites should switch on.
 */
export type SessionAuth =
  | { kind: "oauth"; tokenId: string }
  | { kind: "service_token"; serviceToken: string };

export type SessionCredentialFields = Pick<Props, "serviceToken" | "tokenId" | "authKind">;

export function sessionAuthFromProps(
  props: SessionCredentialFields | null | undefined,
): SessionAuth | null {
  if (props?.serviceToken) {
    return { kind: "service_token", serviceToken: props.serviceToken };
  }
  if (props?.tokenId) {
    return { kind: "oauth", tokenId: props.tokenId };
  }
  return null;
}

export function requireSessionAuth(props: SessionCredentialFields | null | undefined): SessionAuth {
  const auth = sessionAuthFromProps(props);
  if (!auth) {
    throw new Error(MISSING_SESSION_CREDENTIALS);
  }
  return auth;
}

export function sessionAuthKind(props: SessionCredentialFields): AuthKind {
  return sessionAuthFromProps(props)?.kind ?? props.authKind ?? "oauth";
}

/** Build MCP session props after AuthKit consent. */
export function buildOauthProps(input: {
  tokenId: string;
  clientId: string;
  userId?: string;
  email?: string;
  selectedGroups: string[];
  mapiAccessMode?: MapiAccessMode;
  clientApplication?: KnockClientApplicationInfo;
}): Props {
  return {
    tokenId: input.tokenId,
    clientId: input.clientId,
    userId: input.userId,
    email: input.email,
    selectedGroups: input.selectedGroups,
    ...(input.mapiAccessMode !== undefined ? { mapiAccessMode: input.mapiAccessMode } : {}),
    ...(input.clientApplication ? { clientApplication: input.clientApplication } : {}),
  };
}

/**
 * Build MCP session props for a validated service token.
 * Service-token sessions enable every tool group with read/write Management
 * API access; the token's own scopes are the real authorization boundary.
 */
export function buildServiceTokenProps(
  serviceToken: string,
  identity?: ServiceTokenIdentity,
): Props {
  return {
    authKind: "service_token",
    serviceToken,
    clientId: SERVICE_TOKEN_CLIENT_ID,
    selectedGroups: allToolGroupKeys(),
    mapiAccessMode: "read_write",
    ...(identity ? { accountSlug: identity.accountSlug, accountName: identity.accountName } : {}),
  };
}

/** Resolve the Knock Management API bearer token for this MCP session. */
export async function resolveKnockAccessToken(
  env: Pick<Env, "OAUTH_KV">,
  props: SessionCredentialFields,
): Promise<string> {
  const auth = requireSessionAuth(props);
  return auth.kind === "service_token"
    ? auth.serviceToken
    : getOrRefreshKnockToken(env, auth.tokenId);
}

/** Tag the current Sentry scope from persisted session props. */
export function applySessionSentryContext(props: Props): void {
  Sentry.setUser({ id: props.userId ?? props.accountSlug, email: props.email });
  Sentry.setTag("knock.client_id", props.clientId);
  Sentry.setTag("knock.auth_kind", sessionAuthKind(props));
  if (props.accountSlug) Sentry.setTag("knock.account_slug", props.accountSlug);
}
