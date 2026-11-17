const MAX_FIELD_LENGTH = 200;

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

/** `/token` is unauthenticated, so every field logged from it is clipped. */
function clip(value: string | null | undefined): string | undefined {
  return value ? value.slice(0, MAX_FIELD_LENGTH) : undefined;
}

/** Refresh tokens are `userId:grantId:secret`; only the grant id is safe to log. */
function grantIdFromRefreshToken(refreshToken: string | null): string | undefined {
  const parts = refreshToken?.split(":");
  return parts?.length === 3 ? clip(parts[1]) : undefined;
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
    error: clip(body.error),
    errorDescription: clip(body.error_description),
    grantType: clip(form?.get("grant_type")),
    clientId: clip(form?.get("client_id")),
    grantId: grantIdFromRefreshToken(form?.get("refresh_token") ?? null),
    resource: clip(form?.get("resource")),
    userAgent: clip(request.headers.get("user-agent")),
    colo: (request.cf as { colo?: string } | undefined)?.colo,
  };

  console.warn("token-endpoint-failure", JSON.stringify(entry));
}

type FetchHandler<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;

/** Logs every failed POST to `tokenPath` served by `handler`. */
export function withTokenEndpointLogging<E>(
  tokenPath: string,
  handler: FetchHandler<E>,
): FetchHandler<E> {
  return async (request, env, ctx) => {
    const isTokenPost = request.method === "POST" && new URL(request.url).pathname === tokenPath;
    const logRequest = isTokenPost ? request.clone() : null;
    const response = await handler(request, env, ctx);

    if (logRequest && response.status >= 400) {
      ctx.waitUntil(logTokenEndpointFailure(logRequest, response.clone()));
    }
    return response;
  };
}
