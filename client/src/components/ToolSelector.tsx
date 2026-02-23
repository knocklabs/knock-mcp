import { useEffect, useState } from "react";
import { Stack } from "@telegraph/layout";
import { Heading, Text } from "@telegraph/typography";
import { Button } from "@telegraph/button";
import { Toggle } from "@telegraph/toggle";

import { useToolGroups, type ToolGroup } from "../hooks/useToolGroups";
import { useAuthorizeTools } from "../hooks/useAuthorizeTools";
import { KnockCard } from "./KnockCard";

interface Props {
  session: string;
}

export function ToolSelector({ session }: Props) {
  const {
    status: loadStatus,
    toolGroups,
    email,
    csrfToken,
    error: loadError,
  } = useToolGroups(session);
  const { authorize, status: authStatus, redirectTo, error: authError } = useAuthorizeTools();

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

  if (authStatus === "done" && redirectTo) {
    return <AuthorizationComplete redirectTo={redirectTo} />;
  }

  if (loadStatus === "loading") {
    return (
      <Stack className="tgph" direction="column" align="center" gap="3">
        <div className="spinner" aria-hidden />
        <Text as="span" size="2" color="gray">
          Loading…
        </Text>
      </Stack>
    );
  }

  return (
    <KnockCard>
      {/* User email */}
      {email && (
        <Text as="p" size="2" color="gray">
          Authorizing as <strong>{email}</strong>
        </Text>
      )}

      {/* Heading */}
      <Stack direction="column" gap="1">
        <Heading as="h1" size="3">
          Select capabilities to grant
        </Heading>
        <Text as="p" size="2" color="gray">
          Choose which actions any AI using the MCP can perform on your behalf in your Knock
          account.
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
        <Text as="p" size="2" color="red">
          {error}
        </Text>
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
    </KnockCard>
  );
}

function AuthorizationComplete({ redirectTo }: { redirectTo: string }) {
  useEffect(() => {
    window.location.href = redirectTo;
  }, [redirectTo]);

  return (
    <KnockCard>
      <Stack direction="column">
        <Stack direction="column" gap="1">
          <Heading as="h1" size="3">
            You're all set!
          </Heading>
          <Text as="p" size="2" color="gray">
            Authorization complete. You can close this window.
          </Text>
        </Stack>
      </Stack>
    </KnockCard>
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
          <Text as="span" size="2" weight="medium" color="default">
            {group.name}
          </Text>
          <Text as="span" size="1" color="gray">
            {group.description}
          </Text>
        </Stack>
        <Toggle.Switch />
      </Toggle.Root>
    </Stack>
  );
}
