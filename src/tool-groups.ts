export interface ToolGroup {
  key: string;
  name: string;
  description: string;
  categories: string[];
  enabledByDefault: boolean;
  /** Omit from the main consent list (e.g. code mode is driven by Read/Manage toggles). */
  hidden?: boolean;
  /** Show under a collapsed "Deprecated" section (legacy toolkit groups). */
  deprecated?: boolean;
}

/** Sentinel category: registers \`search_mapi\` / \`execute_mapi\` (Code Mode) — not a @knocklabs/agent-toolkit category. */
export const CODE_MODE_MAPI_CATEGORY = "__codeMode:mapi" as const;

/** Consent UI group key for Management API code mode (must match client). */
export const CODE_MODE_MAPI_GROUP_KEY = "code-mode-mapi" as const;

/** Reserved for a future public-API Code Mode group (\`search_api\` / \`execute_api\`). */
export const CODE_MODE_API_CATEGORY = "__codeMode:api" as const;

/** Sentinel category: registers \`use_knock_agent\` — not a @knocklabs/agent-toolkit category. */
export const AGENT_CATEGORY = "__agent" as const;

/** Consent UI group key for the Knock agent tool. */
export const AGENT_GROUP_KEY = "knock-agent" as const;

export const toolGroups: ToolGroup[] = [
  {
    key: CODE_MODE_MAPI_GROUP_KEY,
    name: "Management API (code mode)",
    description:
      "search_mapi + execute_mapi — full Knock Management API access in ~1k tokens (OpenAPI + sandboxed code)",
    categories: [CODE_MODE_MAPI_CATEGORY],
    enabledByDefault: true,
    hidden: true,
  },
  {
    key: AGENT_GROUP_KEY,
    name: "Knock agent",
    description:
      "use_knock_agent — delegate creating/updating workflows, broadcasts, partials, guides, and email layouts to Knock's hosted agent",
    categories: [AGENT_CATEGORY],
    enabledByDefault: true,
  },
  {
    key: "manage-resources",
    name: "Manage resources",
    description:
      "Legacy MCP tools for workflows, channels, templates, and configuration (superseded by code mode)",
    categories: [
      "channels",
      "emailLayouts",
      "environments",
      "guides",
      "messageTypes",
      "partials",
      "workflows",
    ],
    enabledByDefault: false,
    deprecated: true,
  },
  {
    key: "commits",
    name: "Commits",
    description: "Legacy MCP tools to commit and promote changes (superseded by code mode)",
    categories: ["commits"],
    enabledByDefault: false,
    deprecated: true,
  },
  {
    key: "debug",
    name: "Debug",
    description: "Inspect environments and view sent message logs",
    categories: ["environments", "messages"],
    enabledByDefault: false,
  },
  {
    key: "manage-data",
    name: "Manage data",
    description: "Manage users, tenants, and object data",
    categories: ["users", "tenants", "objects"],
    enabledByDefault: false,
  },
  {
    key: "documentation",
    name: "Documentation",
    description: "Search Knock documentation and guides",
    categories: ["documentation"],
    enabledByDefault: false,
  },
];

export function resolveGroupsToCategories(selectedGroupKeys: string[]): string[] {
  const categories = new Set<string>();
  for (const group of toolGroups) {
    if (selectedGroupKeys.includes(group.key)) {
      for (const cat of group.categories) {
        categories.add(cat);
      }
    }
  }
  return [...categories];
}

const knownToolGroupKeys = new Set(toolGroups.map((g) => g.key));

/** Group keys selected on the consent screen when `enabledByDefault` is true. */
export function defaultSelectedGroupKeys(): string[] {
  return toolGroups.filter((g) => g.enabledByDefault).map((g) => g.key);
}

/**
 * Normalize OAuth props: missing, empty, or all-unknown selections fall back to defaults
 * so MCP sessions never initialize with zero tools.
 */
export function resolveEffectiveSelectedGroups(
  selectedGroups: string[] | undefined | null,
): string[] {
  if (!selectedGroups?.length) {
    return defaultSelectedGroupKeys();
  }
  const valid = selectedGroups.filter((key) => knownToolGroupKeys.has(key));
  return valid.length > 0 ? valid : defaultSelectedGroupKeys();
}
