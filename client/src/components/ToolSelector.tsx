import { useState } from "react";
import { Box, Stack } from "@telegraph/layout";
import { Heading, Text } from "@telegraph/typography";
import { Button } from "@telegraph/button";
import { Toggle } from "@telegraph/toggle";

import { useToolGroups, type ToolGroup } from "../hooks/useToolGroups";
import { useAuthorizeTools } from "../hooks/useAuthorizeTools";

interface Props {
  session: string;
}

export function ToolSelector({ session }: Props) {
  const { status: loadStatus, toolGroups, email, csrfToken, error: loadError } = useToolGroups(session);
  const { authorize, status: authStatus, error: authError } = useAuthorizeTools();

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [initializedDefaults, setInitializedDefaults] = useState(false);

  // Once tool groups load, initialise default selections once
  if (loadStatus === "ready" && !initializedDefaults) {
    setInitializedDefaults(true);
    setSelected(new Set(toolGroups.filter((g) => g.enabledByDefault).map((g) => g.key)));
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next; 
    });
  }

  function handleAuthorize() {
    authorize(session, csrfToken, [...selected]);
  }

  const isSubmitting = authStatus === "submitting";
  const error = loadError ?? authError;

  if (loadStatus === "loading") {
    return (
      <Stack className="tgph" direction="column" align="center" gap="3">
        <div className="spinner" aria-hidden />
        <Text as="span" size="2" color="gray">Loading…</Text>
      </Stack>
    );
  }

  return (
    <Stack className="tgph">
      <Box
        bg="surface-1"
        shadow="2"
        w="full"
        borderRadius="4"
        border="px"
        overflow="hidden"
        style={{
          maxWidth: "480px",
        }}
      >
        {/* Header */}
        <Stack direction="row" align="center" gap="2" px="5" py="4" className="card-header">
          <KnockLogo />
          <Text as="span" size="3" weight="medium" color="default">Knock</Text>
        </Stack>

        {/* Body */}
        <Stack direction="column" gap="5" p="6">
          {/* User email */}
          {email && (
            <Text as="p" size="2" color="gray">
              Authorizing as <strong>{email}</strong>
            </Text>
          )}

          {/* Heading */}
          <Stack direction="column" gap="1">
            <Heading as="h1" size="3">Select capabilities to grant</Heading>
            <Text as="p" size="2" color="gray">
              Choose which actions any AI using the MCP can perform on your behalf in your Knock account.
            </Text>
          </Stack>

          {/* Tool group cards */}
          {loadStatus === "ready" && (
            <Stack direction="column" gap="2">
              {toolGroups.map((group) => (
                <ToolGroupCard
                  key={group.key}
                  group={group}
                  selected={selected.has(group.key)}
                  onToggle={() => toggle(group.key)}
                />
              ))}
            </Stack>

          )}

          {/* Error */}
          {error && (
            <Text as="p" size="2" color="red">{error}</Text>
          )}

          {/* Actions */}
          <Stack direction="row" justify="flex-end" gap="2">
            <Button
              variant="ghost"
              color="default"
              size="2"
              onClick={() => window.history.back()}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="accent"
              size="2"
              onClick={handleAuthorize}
              state={isSubmitting ? "loading" : "default"}
              disabled={isSubmitting}
            >
              Authorize
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Stack>
  );
}

function ToolGroupCard({
  group,
  selected,
  onToggle,
}: {
  group: ToolGroup;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <Stack
      as="button"
      direction="row"
      align="center"
      gap="3"
      w="full"
      p="3"
      rounded="3"
      onClick={onToggle}
      aria-pressed={selected}
      border="px"
      borderColor={selected ? "accent-7" : "gray-4"}
      bg={selected ? "accent-2" : "surface-1"}
      style={{
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <Toggle.Root value={selected} color="accent" style={{ flex: 1, pointerEvents: "none" }}>
        <Stack direction="column" gap="0_5">
          <Text as="span" size="2" weight="medium" color="default">{group.name}</Text>
          <Text as="span" size="1" color="gray">{group.description}</Text>
        </Stack>
        <Toggle.Switch />
      </Toggle.Root>
    </Stack>
  );
}

function KnockLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <g clipPath="url(#knock-favicon-clip)">
        <rect width="32" height="32" fill="#101112" />
        <path d="M9.28003 25.92V6.07996H13.3091V17.4575H13.4218L17.8453 11.882H22.3534L17.451 17.6556L22.72 25.92H18.2396L15.0843 20.4576L13.3091 22.4671V25.92H9.28003Z" fill="#EDEEEF" />
        <path d="M22.72 8.31996C22.72 9.55708 21.7173 10.56 20.48 10.56C19.2427 10.56 18.24 9.55708 18.24 8.31996C18.24 7.08284 19.2427 6.07996 20.48 6.07996C21.7173 6.07996 22.72 7.08284 22.72 8.31996Z" fill="#FF573A" />
      </g>
      <defs>
        <clipPath id="knock-favicon-clip">
          <rect width="32" height="32" rx="4" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}
