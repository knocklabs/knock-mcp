/** Management API (control plane) base URL, e.g. https://control.knock.app */
export function getKnockControlBaseUrl(env: { KNOCK_CONTROL_URL: string }): string {
  return env.KNOCK_CONTROL_URL.replace(/\/$/, "");
}

export function getKnockControlOpenApiUrl(env: { KNOCK_CONTROL_URL: string }): string {
  return `${getKnockControlBaseUrl(env)}/v1/openapi`;
}
