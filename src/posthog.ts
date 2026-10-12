import { instrument, PostHogMCPAnalyticsEvent, type BeforeSendFn } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";

import type { Props } from "./types";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Events that are never sent to PostHog because they carry no usage signal at our volume.
 * Clients re-run `initialize` several times per session (Claude Code does it roughly every 3-4
 * minutes), and each one also fires a standalone `$identify` and usually a `tools/list`, so these
 * three were ~99% of our event volume. Every event we still send carries `distinct_id`, `$set`
 * person properties and `$groups`, so `$identify` adds nothing that tool calls do not already
 * provide. Dropping `$mcp_tools_list` gives up `$mcp_listed_tool_names`; the advertised tool set
 * is static per tool-group config, so it can be derived from code when needed.
 */
const DROPPED_EVENTS: ReadonlySet<string> = new Set([
  PostHogMCPAnalyticsEvent.Initialize,
  PostHogMCPAnalyticsEvent.Identify,
  PostHogMCPAnalyticsEvent.ToolsList,
]);

export const dropLowSignalEvents: BeforeSendFn = (event) =>
  DROPPED_EVENTS.has(event.event) ? null : event;

type PostHogEnv = {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
};
type PostHogIdentity = Pick<Props, "accountName" | "accountSlug" | "authKind" | "email" | "userId">;

export function instrumentPostHogMcp(
  server: McpServer,
  env: PostHogEnv,
  identity: PostHogIdentity,
  waitUntil: (promise: Promise<unknown>) => void,
): PostHog | undefined {
  if (!env.POSTHOG_PROJECT_TOKEN) {
    return undefined;
  }

  const posthog = new PostHog(env.POSTHOG_PROJECT_TOKEN, {
    host: env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
    waitUntil,
  });

  const distinctId =
    identity.userId ?? (identity.accountSlug ? `account:${identity.accountSlug}` : undefined);

  instrument(server, posthog, {
    captureModel: true,
    context: {
      description:
        "Describe the user's underlying goal in one sentence, rather than the tool being called.",
    },
    enableConversationId: true,
    // Sentry is the source of truth for exception details; tool-call events still include error state.
    enableExceptionAutocapture: false,
    reportMissing: true,
    beforeSend: dropLowSignalEvents,
    identify: distinctId
      ? {
          distinctId,
          properties: {
            authKind: identity.authKind ?? (identity.accountSlug ? "service_token" : "oauth"),
            ...(identity.email ? { email: identity.email } : {}),
            ...(identity.accountSlug ? { accountSlug: identity.accountSlug } : {}),
            ...(identity.accountName ? { accountName: identity.accountName } : {}),
          },
          ...(identity.accountSlug ? { groups: { account: identity.accountSlug } } : {}),
        }
      : null,
  });

  return posthog;
}
