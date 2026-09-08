const DEFAULT_KNOCK_API_URL = "https://api.knock.app";

/** Knock public API (data plane) base URL, e.g. https://api.knock.app */
export function getKnockApiBaseUrl(env: { KNOCK_API_URL?: string }): string {
  return (env.KNOCK_API_URL || DEFAULT_KNOCK_API_URL).replace(/\/$/, "");
}

export function getKnockApiOpenApiUrl(env: { KNOCK_API_URL?: string }): string {
  return `${getKnockApiBaseUrl(env)}/v1/openapi`;
}
