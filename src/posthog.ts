import { instrument } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";

import type { Props } from "./types";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

type PostHogEnv = Pick<Env, "POSTHOG_PROJECT_API_KEY" | "POSTHOG_HOST">;
type PostHogIdentity = Pick<Props, "userId" | "email">;

export function instrumentPostHogMcp(
  server: McpServer,
  env: PostHogEnv,
  identity: PostHogIdentity,
  waitUntil: (promise: Promise<unknown>) => void,
): PostHog | undefined {
  if (!env.POSTHOG_PROJECT_API_KEY) {
    return undefined;
  }

  const posthog = new PostHog(env.POSTHOG_PROJECT_API_KEY, {
    host: env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
    waitUntil,
  });

  instrument(server, posthog, {
    context: {
      description:
        "Describe the user's underlying goal in one sentence, rather than the tool being called.",
    },
    identify: identity.userId
      ? {
          distinctId: identity.userId,
          properties: identity.email ? { email: identity.email } : undefined,
        }
      : null,
  });

  return posthog;
}
