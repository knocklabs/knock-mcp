import { Result } from "better-result";

import type { Props } from "../types";
import {
  NetworkError,
  RequestValidationError,
  toNetworkError,
  toRequestValidationError,
} from "./errors";
import {
  ALLOWED_HTTP_METHODS,
  BLOCKED_CLIENT_HEADERS,
  type CodeModeAccessMode,
  resolveVariantApiUrl,
  validateHttpMethod,
} from "./utils";

/** Matches the request shape documented in @cloudflare/codemode's OpenAPI code-mode examples. */
export interface CodeModeRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
  headers?: Record<string, string>;
}

export interface CodeModeRequestResponse {
  status: number;
  ok: boolean;
  result: unknown;
}

export function parseRequestOptions(
  args: unknown,
): Result<CodeModeRequestOptions, RequestValidationError> {
  const opts = args as CodeModeRequestOptions;
  if (!opts || typeof opts !== "object" || !opts.path || !opts.method) {
    return Result.err(
      new RequestValidationError({ message: "request() expects { method, path, ... }" }),
    );
  }
  if (!ALLOWED_HTTP_METHODS.has(opts.method)) {
    return Result.err(
      new RequestValidationError({ message: `unsupported HTTP method: ${opts.method}` }),
    );
  }
  return Result.ok(opts);
}

export function applyQueryParams(url: URL, query?: CodeModeRequestOptions["query"]): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
}

export function mergeHeaders(
  clientHeaders: Record<string, string> | undefined,
  authHeaders: Record<string, string>,
): Headers {
  const headers = new Headers();
  if (clientHeaders) {
    for (const [key, value] of Object.entries(clientHeaders)) {
      if (value === undefined) continue;
      if (BLOCKED_CLIENT_HEADERS.has(key.toLowerCase())) continue;
      headers.set(key, value);
    }
  }
  // Auth from the host always wins — sandbox code must not override OAuth tokens.
  for (const [key, value] of Object.entries(authHeaders)) {
    if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

function setContentType(headers: Headers, contentType?: string): void {
  if (contentType) {
    headers.set("Content-Type", contentType);
    return;
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
}

export function buildRequestBody(
  opts: CodeModeRequestOptions,
  headers: Headers,
): string | ArrayBuffer | undefined {
  if (opts.method === "GET" || opts.body === undefined) {
    if (opts.contentType) headers.set("Content-Type", opts.contentType);
    return undefined;
  }
  if (opts.rawBody && (typeof opts.body === "string" || opts.body instanceof ArrayBuffer)) {
    return opts.body;
  }
  setContentType(headers, opts.contentType);
  return typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
}

export async function parseResponseBody(
  response: Response,
): Promise<Result<unknown, NetworkError>> {
  const textResult = await Result.tryPromise({
    try: () => response.text(),
    catch: toNetworkError,
  });
  if (Result.isError(textResult)) return textResult;

  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return Result.ok(textResult.value);
  }

  const parsed = Result.try(() => (textResult.value ? JSON.parse(textResult.value) : null));
  if (Result.isOk(parsed)) return Result.ok(parsed.value);
  return Result.ok(textResult.value);
}

export interface ExecuteHostRequestConfig {
  baseUrl: string;
  accessMode: CodeModeAccessMode;
  resolveAuth: (env: Env, props: Props) => Promise<{ headers: Record<string, string> }>;
  env: Env;
  props: Props;
}

export async function executeHostRequest(
  args: unknown,
  config: ExecuteHostRequestConfig,
): Promise<CodeModeRequestResponse> {
  const result = await Result.gen(async function* () {
    const opts = yield* parseRequestOptions(args);
    yield* validateHttpMethod(config.accessMode, opts.method);
    const url = yield* resolveVariantApiUrl(config.baseUrl, opts.path);
    applyQueryParams(url, opts.query);
    const { headers: authHeaders } = yield* Result.await(
      Result.tryPromise({
        try: () => config.resolveAuth(config.env, config.props),
        catch: toRequestValidationError,
      }),
    );
    const headers = mergeHeaders(opts.headers, authHeaders);
    const body = buildRequestBody(opts, headers);
    const response = yield* Result.await(
      Result.tryPromise({
        try: () => fetch(url.toString(), { method: opts.method, headers, body }),
        catch: toNetworkError,
      }),
    );
    const parsed = yield* Result.await(parseResponseBody(response));
    return Result.ok({
      status: response.status,
      ok: response.ok,
      result: parsed,
    });
  });

  if (Result.isError(result)) throw result.error;
  return result.value;
}
