/**
 * Cached OpenAPI documents for Code Mode, keyed by API variant.
 * "mapi" = Knock Management API; "api" = public API (URL reserved for a future code-mode group).
 */
import { getKnockControlOpenApiUrl } from "./knock-control-url";

export type OpenAPIVariant = "mapi" | "api";

/** Placeholder — wired when the public-API code-mode group ships. */
const PUBLIC_API_OPENAPI_URL = "https://api.knock.app/v1/openapi";

const KV_TTL_SECONDS = 24 * 60 * 60;
const VERSION = "v1";

type OpenAPIEnv = Pick<Env, "OAUTH_KV"> & { KNOCK_CONTROL_URL: string };

interface ResolvedSpecMemo {
  spec: Record<string, unknown>;
  fetchedAt: number;
}

/** In-memory resolved spec (refs flattened), keyed by KV `fetchedAt` for invalidation. */
const resolvedMemo = new Map<OpenAPIVariant, ResolvedSpecMemo>();

function cacheKey(variant: OpenAPIVariant, env: OpenAPIEnv): string {
  if (variant === "mapi") {
    const host = new URL(getKnockControlOpenApiUrl(env)).hostname;
    return `openapi:mapi:${host}:${VERSION}`;
  }
  return `openapi:${variant}:${VERSION}`;
}

function openApiUrlForVariant(variant: OpenAPIVariant, env: OpenAPIEnv): string {
  if (variant === "mapi") return getKnockControlOpenApiUrl(env);
  return PUBLIC_API_OPENAPI_URL;
}

/**
 * Resolve internal `#/...` $ref pointers in a JSON object. External refs are left as-is.
 * Matches @cloudflare/codemode's openApiMcpServer behaviour.
 */
export function resolveRefs(
  obj: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>(),
): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => resolveRefs(item, root, seen));
  const record = obj as Record<string, unknown>;
  if ("$ref" in record && typeof record.$ref === "string") {
    const ref = record.$ref;
    if (seen.has(ref)) return { $circular: ref };
    if (!ref.startsWith("#/")) return record;
    seen.add(ref);
    const parts = ref
      .slice(2)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let resolved: unknown = root;
    for (const part of parts) {
      if (resolved === null || resolved === undefined) break;
      resolved = (resolved as Record<string, unknown>)[part];
    }
    const result = resolveRefs(resolved, root, seen);
    seen.delete(ref);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, root, seen);
  }
  return result;
}

export interface CachedOpenAPIDoc {
  fetchedAt: number;
  spec: Record<string, unknown>;
}

async function fetchOpenAPISpecFromNetwork(
  env: OpenAPIEnv,
  variant: OpenAPIVariant,
): Promise<{ spec: Record<string, unknown>; fetchedAt: number }> {
  const url = openApiUrlForVariant(variant, env);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenAPI from ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const spec = (await response.json()) as Record<string, unknown>;
  return { spec, fetchedAt: Date.now() };
}

async function loadOpenAPISpec(
  env: OpenAPIEnv,
  variant: OpenAPIVariant,
): Promise<{ spec: Record<string, unknown>; fetchedAt: number }> {
  const key = cacheKey(variant, env);
  const raw = await env.OAUTH_KV.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CachedOpenAPIDoc;
      if (parsed.spec && typeof parsed.spec === "object" && typeof parsed.fetchedAt === "number") {
        return { spec: parsed.spec, fetchedAt: parsed.fetchedAt };
      }
    } catch {
      // Re-fetch below
    }
    await env.OAUTH_KV.delete(key);
  }

  const loaded = await fetchOpenAPISpecFromNetwork(env, variant);
  resolvedMemo.delete(variant);
  const payload: CachedOpenAPIDoc = { fetchedAt: loaded.fetchedAt, spec: loaded.spec };
  await env.OAUTH_KV.put(key, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS });
  return loaded;
}

/**
 * Fetches the raw spec from the network or KV cache, returns the parsed object.
 */
export async function getRawOpenAPISpec(
  env: OpenAPIEnv,
  variant: OpenAPIVariant,
): Promise<Record<string, unknown>> {
  const { spec } = await loadOpenAPISpec(env, variant);
  return spec;
}

/**
 * Returns the OpenAPI spec with all `#/` refs pre-resolved (same as Cloudflare's Code Mode MCP).
 */
export async function getResolvedOpenAPISpec(
  env: OpenAPIEnv,
  variant: OpenAPIVariant,
): Promise<Record<string, unknown>> {
  const { spec, fetchedAt } = await loadOpenAPISpec(env, variant);
  const memo = resolvedMemo.get(variant);
  if (memo && memo.fetchedAt === fetchedAt) {
    return memo.spec;
  }

  const resolved = resolveRefs(spec, spec) as Record<string, unknown>;
  resolvedMemo.set(variant, { spec: resolved, fetchedAt });
  return resolved;
}

const HTTP_METHOD_KEYS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/**
 * Returns a copy of the OpenAPI document containing only GET operations per path.
 * Used by read-only code mode so search_mapi does not surface write endpoints.
 */
export function filterOpenAPISpecToReadOnly(spec: Record<string, unknown>): Record<string, unknown> {
  const paths = spec.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return spec;
  }
  const filteredPaths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const methods = item as Record<string, unknown>;
    if (methods.get !== undefined) {
      const readOnly: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(methods)) {
        if (!HTTP_METHOD_KEYS.has(key)) {
          readOnly[key] = value;
        }
      }
      readOnly.get = methods.get;
      filteredPaths[path] = readOnly;
    }
  }
  return { ...spec, paths: filteredPaths };
}
