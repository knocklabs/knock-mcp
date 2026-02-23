import { Box, Stack } from "@telegraph/layout";
import { Heading, Text } from "@telegraph/typography";
import { Button } from "@telegraph/button";
import { useApproveClient } from "../hooks/useApproveClient";
import { KnockCard } from "./KnockCard";

type ClientData = {
  clientName?: string;
  clientUri?: string;
  policyUri?: string;
  tosUri?: string;
  redirectUris?: string[];
  contacts?: string[];
};

interface Props {
  params: URLSearchParams;
}

export function ApprovalDialog({ params }: Props) {
  const { approve, status, error } = useApproveClient();

  const encodedState = params.get("state") ?? "";
  const csrfToken = params.get("csrf") ?? "";

  let client: ClientData = {};
  try {
    const encoded = params.get("client");
    if (encoded) client = JSON.parse(atob(encoded));
  } catch {
    // Leave client empty if decoding fails
  }

  const clientName = client.clientName ?? "Unknown MCP Client";
  const isSubmitting = status === "submitting";

  return (
    <KnockCard>
      <Stack direction="column" gap="1">
        <Heading as="h1" size="3">
          {clientName} is requesting access
        </Heading>
        <Text as="p" size="2" color="gray">
          Connect your AI assistant to Knock to manage notifications, workflows, and more.
        </Text>
      </Stack>

      {/* Client info */}
      <Box border="px" borderColor="gray-4" borderRadius="3" p="4">
        <Stack direction="column" gap="2">
          <Text as="span" size="2" weight="medium" color="default">
            {clientName}
          </Text>

          {client.clientUri && (
            <ClientRow label="Website">
              <a href={client.clientUri} target="_blank" rel="noopener noreferrer">
                {client.clientUri}
              </a>
            </ClientRow>
          )}
          {client.policyUri && (
            <ClientRow label="Privacy Policy">
              <a href={client.policyUri} target="_blank" rel="noopener noreferrer">
                {client.policyUri}
              </a>
            </ClientRow>
          )}
          {client.tosUri && (
            <ClientRow label="Terms of Service">
              <a href={client.tosUri} target="_blank" rel="noopener noreferrer">
                {client.tosUri}
              </a>
            </ClientRow>
          )}
          {client.redirectUris && client.redirectUris.length > 0 && (
            <ClientRow label="Redirect URIs">
              <Stack direction="column" gap="0_5">
                {client.redirectUris.map((uri) => (
                  <Text key={uri} as="span" size="1" color="gray">
                    {uri}
                  </Text>
                ))}
              </Stack>
            </ClientRow>
          )}
          {client.contacts && client.contacts.length > 0 && (
            <ClientRow label="Contact">{client.contacts.join(", ")}</ClientRow>
          )}
        </Stack>
      </Box>

      <Text as="p" size="2" color="gray">
        If you approve, you will be redirected to complete authentication with your Knock account.
      </Text>

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
          onClick={() => approve(encodedState, csrfToken)}
          state={isSubmitting ? "loading" : "default"}
          disabled={isSubmitting}
        >
          Approve
        </Button>
      </Stack>
    </KnockCard>
  );
}

function ClientRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" align="flex-start" gap="3">
      <Text as="span" size="2" color="default" style={{ minWidth: "120px" }}>
        {label}
      </Text>
      <Text as="span" size="2" color="gray" style={{ wordBreak: "break-all" }}>
        {children}
      </Text>
    </Stack>
  );
}
