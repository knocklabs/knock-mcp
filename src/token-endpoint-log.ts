type TokenFailureLog = {
  status: number;
  error?: string;
  errorDescription?: string;
  grantType?: string;
  clientId?: string;
  grantId?: string;
  resource?: string;
  userAgent?: string;
  colo?: string;
};

/** Refresh tokens are `userId:grantId:secret`; only the grant id is safe to log. */
function grantIdFromRefreshToken(refreshToken: string | null): string | undefined {
  const parts = refreshToken?.split(":");
  return parts?.length === 3 ? parts[1] : undefined;
}

async function readFormBody(request: Request): Promise<URLSearchParams | null> {
  if (!(request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    return null;
  }
  try {
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

async function readErrorBody(
  response: Response,
): Promise<{ error?: string; error_description?: string }> {
  try {
    return (await response.json()) as { error?: string; error_description?: string };
  } catch {
    return {};
  }
}

/**
 * The OAuth provider keeps expected 4xx responses out of Sentry, which leaves
 * Workers Logs as the only record of why a client's refresh failed. This adds
 * the fields needed to tell concurrent refreshes from stuck clients apart
 * (grant id, grant type, user agent, colo) without logging any secret.
 */
export async function logTokenEndpointFailure(request: Request, response: Response): Promise<void> {
  const [form, body] = await Promise.all([readFormBody(request), readErrorBody(response)]);

  const entry: TokenFailureLog = {
    status: response.status,
    error: body.error,
    errorDescription: body.error_description,
    grantType: form?.get("grant_type") ?? undefined,
    clientId: form?.get("client_id") ?? undefined,
    grantId: grantIdFromRefreshToken(form?.get("refresh_token") ?? null),
    resource: form?.get("resource") ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
    colo: (request as Request & { cf?: { colo?: string } }).cf?.colo,
  };

  console.warn("token-endpoint-failure", JSON.stringify(entry));
}
