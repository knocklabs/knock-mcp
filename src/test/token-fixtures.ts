import { nowSeconds } from "../time";
import type { KnockTokenData } from "../token-store";

/** A stale upstream record: its access token expired ten seconds ago. */
export function tokenData(overrides: Partial<KnockTokenData> = {}): KnockTokenData {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: nowSeconds() - 10,
    tokenEndpoint: "https://signin.example.com/oauth2/token",
    upstreamClientId: "client_upstream",
    ...overrides,
  };
}

export const upstreamOk = () =>
  new Response(
    JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }),
    { status: 200 },
  );

export const upstreamError = (status: number, error?: string) =>
  new Response(error ? JSON.stringify({ error }) : "Bad Gateway", { status });
