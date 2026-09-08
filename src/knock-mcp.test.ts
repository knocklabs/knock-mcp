import { beforeEach, describe, expect, it, vi } from "vitest";

const { exchangeMock, getMessageMock } = vi.hoisted(() => ({
  exchangeMock: vi.fn().mockResolvedValue({ api_key: "secret-api-key" }),
  getMessageMock: vi.fn().mockResolvedValue({ id: "message-1" }),
}));

vi.mock("@knocklabs/mgmt", () => ({
  default: class {
    apiKeys = { exchange: exchangeMock };
  },
}));

vi.mock("@knocklabs/node", () => ({
  Knock: class {
    messages = { get: getMessageMock };
  },
}));

import { tools } from "@knocklabs/agent-toolkit/core";

import { createKnockClient, exchangeKnockApiKey } from "./knock-client";

const config = {
  serviceToken: "service-token",
  clientId: "client-id",
  baseURL: "https://control.knock.app",
};

describe("createKnockClient public API exchange", () => {
  beforeEach(() => {
    exchangeMock.mockClear();
    getMessageMock.mockClear();
  });

  it("omits exchange parameters when no environment is supplied", async () => {
    const client = createKnockClient(config);

    await client.publicApi();

    expect(exchangeMock).toHaveBeenCalledWith();
  });

  it("exchanges for an explicitly supplied environment", async () => {
    const client = createKnockClient(config);

    await client.publicApi("staging");

    expect(exchangeMock).toHaveBeenCalledWith({ environment: "staging" });
  });

  it("returns exchanged API keys for Code Mode without persisting them", async () => {
    await expect(exchangeKnockApiKey(config)).resolves.toBe("secret-api-key");
    await expect(exchangeKnockApiKey(config, "production")).resolves.toBe("secret-api-key");

    expect(exchangeMock).toHaveBeenNthCalledWith(1);
    expect(exchangeMock).toHaveBeenNthCalledWith(2, { environment: "production" });
  });

  it("preserves omitted and explicit environments through legacy toolkit binding", async () => {
    const client = createKnockClient(config);
    const getMessage = tools.messages.getMessage.bindExecute(
      client as unknown as Parameters<typeof tools.messages.getMessage.bindExecute>[0],
      config,
    );

    await getMessage({ messageId: "message-1" });
    await getMessage({ messageId: "message-1", environment: "production" });

    expect(exchangeMock).toHaveBeenNthCalledWith(1);
    expect(exchangeMock).toHaveBeenNthCalledWith(2, { environment: "production" });
    expect(getMessageMock).toHaveBeenCalledTimes(2);
  });
});
