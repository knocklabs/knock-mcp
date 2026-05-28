import { Result } from "better-result";

import { HttpMethodError, RequestValidationError } from "./errors";

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6_000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

export function truncateCodeModeResponse(content: unknown): string {
  const text =
    typeof content === "string" ? content : (JSON.stringify(content, null, 2) ?? "undefined");
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n\n--- TRUNCATED ---\nResponse was ~${Math.ceil(
    text.length / CHARS_PER_TOKEN,
  ).toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use a smaller or more specific result.`;
}

/** Reject absolute URLs and protocol-relative paths before building a request URL. */
export function resolveVariantApiUrl(
  baseUrl: string,
  path: string,
): Result<URL, RequestValidationError> {
  if (typeof path !== "string" || !path.trim()) {
    return Result.err(
      new RequestValidationError({ message: "request() expects a non-empty path" }),
    );
  }
  const trimmed = path.trim();
  if (trimmed.includes("://") || trimmed.startsWith("//")) {
    return Result.err(
      new RequestValidationError({
        message: "path must be a relative API path (e.g. /v1/workflows), not a full URL",
      }),
    );
  }
  if (trimmed.includes("..")) {
    return Result.err(new RequestValidationError({ message: "path must not contain .." }));
  }
  const pathname = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}${pathname}`);
  const expectedOrigin = new URL(base.endsWith("/") ? base : `${base}/`).origin;
  if (url.origin !== expectedOrigin) {
    return Result.err(
      new RequestValidationError({ message: "path must stay on the configured API host" }),
    );
  }
  return Result.ok(url);
}

export const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export type CodeModeAccessMode = "read" | "read_write";

export const READ_ONLY_HTTP_METHODS = new Set(["GET"]);

export function validateHttpMethod(
  accessMode: CodeModeAccessMode,
  method: string,
): Result<void, HttpMethodError> {
  if (accessMode === "read_write") return Result.ok(undefined);
  if (!READ_ONLY_HTTP_METHODS.has(method)) {
    return Result.err(
      new HttpMethodError({
        message: `This MCP session is read-only. "${method}" is not allowed — use GET only, or reconnect and allow read & write access.`,
      }),
    );
  }
  return Result.ok(undefined);
}

/** Headers the sandbox must not supply — host auth always sets these. */
export const BLOCKED_CLIENT_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-knock-client-id",
  "host",
]);

export function formatCodeModeToolResult(result: { result: unknown; logs?: string[] }): string {
  const body = truncateCodeModeResponse(result.result);
  if (!result.logs?.length) return body;
  return `${body}\n\n--- console ---\n${result.logs.join("\n")}`;
}
