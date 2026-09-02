const RESOURCE_REWRITE_PATHS = new Set(["/authorize", "/token"]);

/** Canonical MCP resource identifier (RFC 9728) for this worker. */
export function canonicalMcpResource(origin: string): string {
  return `${origin.replace(/\/$/, "")}/mcp`;
}

/**
 * Compare resource URIs the way MCP clients actually send them: scheme/host
 * are case-insensitive, and a trailing slash on the path is not meaningful.
 */
function resourceKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hash) return null;
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/**
 * Map origin-only / trailing-slash aliases onto the configured `/mcp` resource.
 *
 * workers-oauth-provider 0.10 exact-matches `resourceMetadata.resource`. MCP
 * clients often send the issuer origin (`https://mcp.knock.app`) or a
 * trailing slash instead of `https://mcp.knock.app/mcp`, which fails token
 * exchange with `invalid_target`. This host has a single MCP resource, so
 * those aliases are safe; anything else is left for the provider to reject.
 */
export function canonicalizeMcpResource(requested: string, canonical: string): string {
  const requestedKey = resourceKey(requested);
  const canonicalKey = resourceKey(canonical);
  if (!requestedKey || !canonicalKey) return requested;

  const originKey = resourceKey(new URL(canonical).origin);
  if (requestedKey === canonicalKey || requestedKey === originKey) return canonical;
  return requested;
}

function rewriteResourceParams(params: URLSearchParams, canonical: string): boolean {
  const values = params.getAll("resource");
  if (values.length === 0) return false;

  let changed = false;
  const next = values.map((value) => {
    const canonicalized = canonicalizeMcpResource(value, canonical);
    if (canonicalized !== value) changed = true;
    return canonicalized;
  });
  if (!changed) return false;

  params.delete("resource");
  for (const value of next) params.append("resource", value);
  return true;
}

function cloneRequest(request: Request, url: URL, body?: string): Request {
  const headers = new Headers(request.headers);
  if (body !== undefined) headers.delete("content-length");
  return new Request(url, {
    method: request.method,
    headers,
    body,
    redirect: request.redirect,
  });
}

/**
 * Rewrite `resource` on `/authorize` (query) and `/token` (form body) to the
 * canonical MCP URI before the OAuth provider sees the request.
 *
 * Form bodies are always re-attached after `text()` so `/token` stays readable
 * even when `resource` is absent. `Content-Length` is dropped so the runtime
 * recomputes it for a rewritten body.
 */
export async function withCanonicalMcpResource(
  request: Request,
  canonical: string,
): Promise<Request> {
  const url = new URL(request.url);
  if (!RESOURCE_REWRITE_PATHS.has(url.pathname)) return request;

  const queryChanged = rewriteResourceParams(url.searchParams, canonical);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return queryChanged ? new Request(url, request) : request;
  }

  const body = await request.text();
  const params = new URLSearchParams(body);
  const bodyChanged = rewriteResourceParams(params, canonical);
  return cloneRequest(
    request,
    queryChanged ? url : new URL(request.url),
    bodyChanged ? params.toString() : body,
  );
}
