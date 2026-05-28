import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { z } from "zod";

import type { Props } from "../types";
import { filterOpenAPISpecToReadOnly, type OpenAPIVariant, getResolvedOpenAPISpec } from "../openapi-cache";
import { runCodeModeExecution } from "./execution";
import { runCodeModeTool } from "./mcp-response";
import { executeHostRequest } from "./request";
import { type CodeModeAccessMode } from "./utils";

export type { CodeModeRequestOptions } from "./request";
export { resolveVariantApiUrl, truncateCodeModeResponse } from "./utils";

export type CodeModeVariant = OpenAPIVariant;

export interface CodeModeVariantConfig {
  variant: CodeModeVariant;
  /** Sandbox namespace, e.g. "mapi" -> `mapi.spec()`, `mapi.request()` */
  namespace: string;
  baseUrl: string;
  description: string;
  /** Host-enforced HTTP access for execute_* sandbox requests. Defaults to read_write. */
  accessMode?: CodeModeAccessMode;
  resolveAuth: (env: Env, props: Props) => Promise<{ headers: Record<string, string> }>;
}

interface RequestHandlerConfig {
  baseUrl: string;
  resolveAuth: CodeModeVariantConfig["resolveAuth"];
  env: Env;
  props: Props;
  accessMode: CodeModeAccessMode;
}

function createRequestHandler(config: RequestHandlerConfig) {
  return (args: unknown) => executeHostRequest(args, config);
}

const SPEC_TYPES = (namespace: string) =>
  `
// OpenAPI 3.x spec with $refs resolved inline.
interface OperationObject {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: "query" | "header" | "path" | "cookie";
    required?: boolean;
    schema?: unknown;
    description?: string;
  }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
interface PathItem {
  get?: OperationObject; post?: OperationObject; put?: OperationObject;
  patch?: OperationObject; delete?: OperationObject;
}
interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, PathItem>;
  servers?: Array<{ url: string }>;
  components?: Record<string, unknown>;
  tags?: Array<{ name: string; description?: string }>;
}
declare const ${namespace}: { spec(): Promise<OpenApiSpec> };
`.trim();

const REQUEST_TYPES = (namespace: string) =>
  `
interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
  headers?: Record<string, string>;
}
/** Wrapper returned by ${namespace}.request() — the API body is in \`result\`, not at the top level. */
interface RequestResponse {
  status: number;
  ok: boolean;
  result: unknown;
}
declare const ${namespace}: { request(options: RequestOptions): Promise<RequestResponse> };
`.trim();

const REQUEST_RESPONSE_GUIDE = (namespace: string) =>
  `
**${namespace}.request() response shape:** does NOT return the API JSON body directly. It wraps it:

\`\`\`json
{ "status": 200, "ok": true, "result": { /* actual API response body */ } }
\`\`\`

Always read API fields from \`res.result\`, not from \`res\` (e.g. \`res.result.entries\`, not \`res.entries\`).

When the user asks for the "exact result," return the full \`${namespace}.request(...)\` value unless they ask for a projection.
`.trim();

/**
 * Registers \`search_<variant>\` and \`execute_<variant>\` on the given MCP server.
 * Auth and HTTP I/O run on the host; the sandbox only invokes ${namespace}.spec() / ${namespace}.request().
 */
export function registerCodeModeVariant(
  server: McpServer,
  env: Env,
  props: Props,
  config: CodeModeVariantConfig,
): void {
  const { namespace, variant, baseUrl, description, resolveAuth, accessMode = "read_write" } =
    config;
  const v = variant;
  const searchName = `search_${v}`;
  const executeName = `execute_${v}`;
  const accessNote =
    accessMode === "read"
      ? "This session is **read-only**: only `GET` is allowed on `execute_*`."
      : "This session allows **read and write** (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`).";

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null,
    timeout: 30_000,
  });

  const requestHandlerConfig: RequestHandlerConfig = {
    baseUrl,
    resolveAuth,
    env,
    props,
    accessMode,
  };

  // Split providers like @cloudflare/codemode openApiMcpServer: search only gets spec(),
  // execute only gets request() — so search cannot perform side-effecting API calls.
  const searchProvider = resolveProvider({
    name: namespace,
    tools: {
      spec: {
        execute: async () => {
          const spec = await getResolvedOpenAPISpec(env, v);
          return accessMode === "read" ? filterOpenAPISpecToReadOnly(spec) : spec;
        },
      },
    },
  });

  const executeProvider = resolveProvider({
    name: namespace,
    tools: {
      request: {
        execute: createRequestHandler(requestHandlerConfig),
      },
    },
  });

  server.registerTool(
    searchName,
    {
      description: `${description}

${accessNote}

Use \`${searchName}\` to explore or filter the OpenAPI spec for the **${v}** API before calling \`${executeName}\`. All $ref pointers are pre-resolved inline.${accessMode === "read" ? " The spec returned here includes **GET** operations only." : ""}

Types:
${SPEC_TYPES(namespace)}

Your code must be a single JavaScript async arrow function (no TypeScript) that returns a small, filtered result.
Example:
async () => {
  const spec = await ${namespace}.spec();
  return Object.keys(spec.paths).slice(0, 20);
}
`,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to search the spec"),
      },
    },
    async ({ code }) =>
      runCodeModeTool(() => runCodeModeExecution(() => executor.execute(code, [searchProvider]))),
  );

  server.registerTool(
    executeName,
    {
      description: `${description}

${accessNote}

Use this tool (Code Mode: \`${executeName}\`) when you need to call the **${v}** API at ${baseUrl}. Execute JavaScript that calls it via \`${namespace}.request(...)\`. Use \`${searchName}\` first to find paths and request shapes. Auth headers are added on the host.

${REQUEST_RESPONSE_GUIDE(namespace)}

Types:
${REQUEST_TYPES(namespace)}

Your code must be a single JavaScript async arrow function (no TypeScript).
Example:
async () => {
  const res = await ${namespace}.request({
    method: "GET",
    path: "/v1/workflows",
    query: { environment: "development" },
  });
  return { status: res.status, entries: res.result.entries, page_info: res.result.page_info };
}
`,
      inputSchema: { code: z.string().describe("JavaScript async arrow function to execute") },
    },
    async ({ code }) =>
      runCodeModeTool(() => runCodeModeExecution(() => executor.execute(code, [executeProvider]))),
  );
}
