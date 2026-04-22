import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import * as jose from "jose";
import * as Sentry from "@sentry/cloudflare";

import type { Props } from "./types";
import { toolGroups } from "./tool-groups";
import { storeKnockTokens } from "./token-store";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  validateOAuthState,
} from "./workers-oauth-utils";

type HonoEnv = {
  Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers };
};

const app = new Hono<HonoEnv>();

type KnockOAuthMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

async function getKnockOAuthMetadata(authUrl: string): Promise<KnockOAuthMetadata> {
  const response = await fetch(`${authUrl}/.well-known/oauth-authorization-server`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Knock OAuth metadata: ${response.status}`);
  }
  return response.json() as Promise<KnockOAuthMetadata>;
}

// Dynamically registers our worker as an OAuth client with AuthKit for the
// given redirect URI. The client_id is cached in KV so we only register once
// per redirect URI (e.g. once for localhost:8788/callback, once for prod).
async function registerUpstreamClient(
  env: Env & { OAUTH_KV: KVNamespace },
  redirectUri: string,
): Promise<string> {
  const kvKey = `upstream:client:${redirectUri}`;
  const cached = await env.OAUTH_KV.get(kvKey);
  if (cached) return cached;

  const metadata = await getKnockOAuthMetadata(env.KNOCK_AUTH_URL);
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Knock MCP",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: "openid email offline_access",
    }),
  });

  if (!res.ok) {
    throw new Error(`Upstream DCR failed: ${await res.text()}`);
  }

  const { client_id } = (await res.json()) as { client_id: string };
  await env.OAUTH_KV.put(kvKey, client_id);
  return client_id;
}

async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const codeVerifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return { codeVerifier, codeChallenge };
}

async function buildKnockAuthorizationUrl(
  env: Env & { OAUTH_PROVIDER: OAuthHelpers; OAUTH_KV: KVNamespace },
  stateToken: string,
  requestUrl: string,
): Promise<string> {
  // Use DEV_ORIGIN when set — wrangler rewrites request.url to mcp.knock.app
  // which would produce an http:// non-localhost redirect URI that WorkOS rejects.
  const origin = env.DEV_ORIGIN || new URL(requestUrl).origin;
  const redirectUri = `${origin}/callback`;
  const [metadata, clientId, { codeVerifier, codeChallenge }] = await Promise.all([
    getKnockOAuthMetadata(env.KNOCK_AUTH_URL),
    registerUpstreamClient(env, redirectUri),
    generatePKCE(),
  ]);

  await env.OAUTH_KV.put(`oauth:pkce:${stateToken}`, codeVerifier, { expirationTtl: 600 });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: stateToken,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "openid email offline_access",
  });

  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

// RFC 9728 — OAuth 2.0 Protected Resource Metadata
// Required by newer MCP clients (e.g. MCP Inspector v0.20+) to discover
// which authorization server protects this resource before starting OAuth.
app.options("/.well-known/oauth-protected-resource", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
});

app.get("/.well-known/oauth-protected-resource", (c) => {
  const origin = c.env.DEV_ORIGIN || new URL(c.req.url).origin;
  return c.json(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    },
    200,
    { "Access-Control-Allow-Origin": "*" },
  );
});

app.get("/authorize", async (c) => {
  let oauthReqInfo;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[authorize] parseAuthRequest failed:", message);
    Sentry.captureException(err, { tags: { route: "GET /authorize", stage: "parseAuthRequest" } });
    return c.text(`Authorization error: ${message}`, 400);
  }

  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    const authUrl = await buildKnockAuthorizationUrl(c.env, stateToken, c.req.url);

    return new Response(null, {
      status: 302,
      headers: { Location: authUrl, "Set-Cookie": sessionBindingCookie },
    });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();
  const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId);

  const state = btoa(JSON.stringify({ oauthReqInfo }));
  const clientData = btoa(
    JSON.stringify({
      clientName: client?.clientName,
      clientUri: client?.clientUri,
      policyUri: client?.policyUri,
      tosUri: client?.tosUri,
      redirectUris: client?.redirectUris,
      contacts: client?.contacts,
    }),
  );

  const approvalUrl = new URL("/approval", c.req.url);
  approvalUrl.searchParams.set("state", state);
  approvalUrl.searchParams.set("csrf", csrfToken);
  approvalUrl.searchParams.set("client", clientData);

  return new Response(null, {
    status: 302,
    headers: { Location: approvalUrl.toString(), "Set-Cookie": setCookie },
  });
});

app.get("/approval", async (c) => {
  const assetUrl = new URL("/index.html", c.req.url);
  return c.env.ASSETS.fetch(assetUrl);
});

app.post("/authorize", async (c) => {
  try {
    const body = await c.req.json<{ state: string; csrfToken: string }>();
    const { state: encodedState, csrfToken } = body;

    if (!encodedState || !csrfToken) {
      return c.text("Missing state or csrfToken in request body", 400);
    }

    // Validate CSRF token: body token must match __Host-CSRF_TOKEN cookie
    const csrfCookieName = "__Host-CSRF_TOKEN";
    const cookieHeader = c.req.header("cookie") ?? "";
    const csrfCookie = cookieHeader
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${csrfCookieName}=`));
    const tokenFromCookie = csrfCookie ? csrfCookie.substring(csrfCookieName.length + 1) : null;

    if (!tokenFromCookie) {
      return c.text("Missing CSRF token cookie", 400);
    }
    if (csrfToken !== tokenFromCookie) {
      return c.text("CSRF token mismatch", 403);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo?.clientId) {
      return c.text("Invalid request", 400);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    const authUrl = await buildKnockAuthorizationUrl(c.env, stateToken, c.req.url);

    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return new Response(JSON.stringify({ redirectTo: authUrl }), { status: 200, headers });
  } catch (error: unknown) {
    console.error("POST /authorize error:", error);
    Sentry.captureException(error, { tags: { route: "POST /authorize" } });
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Internal server error: ${message}`, 500);
  }
});

app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: unknown) {
    Sentry.captureException(error, {
      tags: { route: "GET /callback", stage: "validateOAuthState" },
    });
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  // Retrieve and consume the PKCE code verifier stored during authorize
  const stateToken = new URL(c.req.url).searchParams.get("state");
  if (!stateToken) {
    return c.text("Missing state parameter", 400);
  }

  const codeVerifier = await c.env.OAUTH_KV.get(`oauth:pkce:${stateToken}`);
  if (!codeVerifier) {
    return c.text("Missing or expired PKCE verifier", 400);
  }
  await c.env.OAUTH_KV.delete(`oauth:pkce:${stateToken}`);

  // Exchange authorization code for tokens via Knock's token endpoint
  // Must match the redirect URI used during authorization — use DEV_ORIGIN to
  // avoid the wrangler-rewritten mcp.knock.app domain in local dev.
  const origin = c.env.DEV_ORIGIN || new URL(c.req.url).origin;
  const redirectUri = `${origin}/callback`;
  const [metadata, clientId] = await Promise.all([
    getKnockOAuthMetadata(c.env.KNOCK_AUTH_URL),
    registerUpstreamClient(c.env, redirectUri),
  ]);

  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("Token exchange failed:", errorText);
    Sentry.captureMessage("Knock token exchange failed", {
      level: "error",
      tags: { route: "GET /callback", stage: "token_exchange" },
      extra: { status: tokenResponse.status, body: errorText },
    });
    return c.text("Failed to exchange authorization code", 400);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token ?? null;

  // Decode the JWT to extract the user ID, email, and token expiry
  let userId: string | undefined;
  let email: string | undefined;
  let expiresAt: number = Math.floor(Date.now() / 1000) + 300; // default 5 minutes
  try {
    const claims = jose.decodeJwt(accessToken);
    userId = typeof claims.sub === "string" ? claims.sub : undefined;
    email = typeof claims.email === "string" ? claims.email : undefined;
    if (typeof claims.exp === "number") expiresAt = claims.exp;
  } catch {
    // Non-JWT access token; proceed without claims
  }

  // Persist the Knock tokens in KV so they can be refreshed transparently on expiry
  const tokenId = crypto.randomUUID();
  await storeKnockTokens(c.env, tokenId, {
    accessToken,
    refreshToken,
    expiresAt,
    tokenEndpoint: metadata.token_endpoint,
    upstreamClientId: clientId,
  });

  // Store session data in KV temporarily, then redirect to tool selection
  const sessionKey = crypto.randomUUID();
  await c.env.OAUTH_KV.put(
    `tool-auth:${sessionKey}`,
    JSON.stringify({ tokenId, userId, email, clientId, oauthReqInfo }),
    { expirationTtl: 300 },
  );

  const toolsUrl = new URL("/tools", c.req.url);
  toolsUrl.searchParams.set("session", sessionKey);

  const headers = new Headers({ Location: toolsUrl.toString() });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }

  return new Response(null, { status: 302, headers });
});

// Serve the tool selection SPA — validates session exists before serving the asset
app.get("/tools", async (c) => {
  const session = c.req.query("session");
  if (!session) return c.text("Missing session", 400);

  const data = await c.env.OAUTH_KV.get(`tool-auth:${session}`);
  if (!data) return c.text("Session expired or invalid", 400);

  const assetUrl = new URL("/index.html", c.req.url);
  return c.env.ASSETS.fetch(assetUrl);
});

const TOOL_CSRF_COOKIE = "knock_tool_csrf";

// Return tool group definitions and a CSRF token for the tool selection UI
app.get("/api/tool-groups", async (c) => {
  const session = c.req.query("session");
  if (!session) return c.json({ error: "Missing session" }, 400);

  const raw = await c.env.OAUTH_KV.get(`tool-auth:${session}`);
  if (!raw) return c.json({ error: "Session expired or invalid" }, 400);

  const { email } = JSON.parse(raw) as { email?: string };

  const csrfToken = crypto.randomUUID();
  // No Secure flag so this works over HTTP in local dev. SameSite=Strict
  // prevents cross-site requests from including the cookie.
  const csrfCookie = `${TOOL_CSRF_COOKIE}=${csrfToken}; HttpOnly; Path=/api; SameSite=Strict; Max-Age=600`;

  return new Response(JSON.stringify({ toolGroups, email, csrfToken }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": csrfCookie,
    },
  });
});

// Accept selected tool groups, complete authorization, and return redirect URL
app.post("/api/authorize-tools", async (c) => {
  try {
    const body = await c.req.json<{
      session: string;
      csrfToken: string;
      selectedGroups: string[];
    }>();

    const { session, csrfToken, selectedGroups } = body;

    if (!session || !csrfToken || !Array.isArray(selectedGroups)) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // Validate CSRF token against cookie
    const cookieHeader = c.req.header("cookie") ?? "";
    const csrfCookieMatch = cookieHeader.match(new RegExp(`${TOOL_CSRF_COOKIE}=([^;]+)`));
    const csrfCookieValue = csrfCookieMatch ? decodeURIComponent(csrfCookieMatch[1]) : null;

    if (!csrfCookieValue || csrfCookieValue !== csrfToken) {
      return c.json({ error: "Invalid CSRF token" }, 403);
    }

    // Retrieve and delete stored session data
    const raw = await c.env.OAUTH_KV.get(`tool-auth:${session}`);
    if (!raw) return c.json({ error: "Session expired or invalid" }, 400);
    await c.env.OAUTH_KV.delete(`tool-auth:${session}`);

    const { tokenId, userId, email, clientId, oauthReqInfo } = JSON.parse(raw) as {
      tokenId: string;
      clientId?: string;
      userId?: string;
      email?: string;
      oauthReqInfo: AuthRequest;
    };

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: userId ?? "unknown",
      metadata: {},
      scope: [],
      props: { tokenId, clientId, userId, email, selectedGroups } satisfies Props,
    });

    return c.json({ redirectTo });
  } catch (error: unknown) {
    console.error("POST /api/authorize-tools error:", error);
    Sentry.captureException(error, { tags: { route: "POST /api/authorize-tools" } });
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Internal server error: ${message}` }, 500);
  }
});

export { app as AuthHandler };
