import KnockMgmt from "@knocklabs/mgmt";
import { Knock } from "@knocklabs/node";

export function createKnockClient(config: {
  serviceToken: string;
  clientId: string;
  baseURL: string;
}) {
  const defaultHeaders: Record<string, string> = {
    "x-knock-client-id": config.clientId,
  };

  const client = new KnockMgmt({
    serviceToken: config.serviceToken,
    baseURL: config.baseURL,
    defaultHeaders,
  });

  return Object.assign(client, {
    publicApi: async (environmentSlug?: string): Promise<Knock> => {
      const { api_key } =
        environmentSlug === undefined
          ? await client.apiKeys.exchange()
          : await client.apiKeys.exchange({ environment: environmentSlug });
      return new Knock({ apiKey: api_key, defaultHeaders });
    },
  });
}
