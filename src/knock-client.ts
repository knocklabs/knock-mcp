import KnockMgmt from "@knocklabs/mgmt";
import { Knock } from "@knocklabs/node";

export interface KnockClientConfig {
  serviceToken: string;
  clientId: string;
  baseURL: string;
}

function createManagementClient(config: KnockClientConfig): KnockMgmt {
  const defaultHeaders: Record<string, string> = {
    "x-knock-client-id": config.clientId,
  };

  return new KnockMgmt({
    serviceToken: config.serviceToken,
    baseURL: config.baseURL,
    defaultHeaders,
  });
}

async function exchangePublicApiKey(client: KnockMgmt, environmentSlug?: string): Promise<string> {
  const { api_key } =
    environmentSlug === undefined
      ? await client.apiKeys.exchange()
      : await client.apiKeys.exchange({ environment: environmentSlug });
  return api_key;
}

/** Exchange the session's Management API credential for an environment-scoped API key. */
export async function exchangeKnockApiKey(
  config: KnockClientConfig,
  environmentSlug?: string,
): Promise<string> {
  return exchangePublicApiKey(createManagementClient(config), environmentSlug);
}

export function createKnockClient(config: KnockClientConfig) {
  const defaultHeaders: Record<string, string> = {
    "x-knock-client-id": config.clientId,
  };
  const client = createManagementClient(config);

  return Object.assign(client, {
    publicApi: async (environmentSlug?: string): Promise<Knock> => {
      const apiKey = await exchangePublicApiKey(client, environmentSlug);
      return new Knock({ apiKey, defaultHeaders });
    },
  });
}
