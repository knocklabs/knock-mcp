export interface ToolGroup {
  key: string;
  name: string;
  description: string;
  categories: string[];
  enabledByDefault: boolean;
}

export const toolGroups: ToolGroup[] = [
  {
    key: "manage-resources",
    name: "Manage resources",
    description:
      "Create and manage notification workflows, channels, templates, and other configuration",
    categories: ["channels", "emailLayouts", "environments", "guides", "messageTypes", "partials", "workflows"],
    enabledByDefault: true,
  },
  {
    key: "commits",
    name: "Commits",
    description: "Commit and promote changes across environments",
    categories: ["commits"],
    enabledByDefault: false,
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
