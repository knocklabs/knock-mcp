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
  /**
   * Session-level access from OAuth consent.
   * `"read"` registers search + GET execute only.
   * `"read_write"` also registers a separate write execute tool.
   */
  accessMode?: "read" | "read_write";
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

const READ_REQUEST_TYPES = (namespace: string) =>
  `
interface RequestOptions {
  method: "GET";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
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

const WRITE_REQUEST_TYPES = (namespace: string) =>
  `
interface RequestOptions {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
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

function humanizeVariant(variant: string): string {
  return variant.toUpperCase();
}

/**
 * Registers \`search_<variant>\`, \`execute_<variant>\` (GET), and optionally
 * \`execute_<variant>_write\` on the given MCP server.
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
  const executeWriteName = `execute_${v}_write`;
  const writesEnabled = accessMode === "read_write";
  const accessNote = writesEnabled
    ? `This session allows **read and write**. Use \`${executeName}\` for \`GET\` and \`${executeWriteName}\` for \`POST\`/\`PUT\`/\`PATCH\`/\`DELETE\`.`
    : `This session is **read-only**: only \`${executeName}\` (\`GET\`) is available.`;

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null,
    timeout: 30_000,
  });

  const readRequestHandlerConfig: RequestHandlerConfig = {
    baseUrl,
    resolveAuth,
    env,
    props,
    accessMode: "read",
  };

  const writeRequestHandlerConfig: RequestHandlerConfig = {
    baseUrl,
    resolveAuth,
    env,
    props,
    accessMode: "write",
  };

  // Split providers like @cloudflare/codemode openApiMcpServer: search only gets spec(),
  // execute only gets request() — so search cannot perform side-effecting API calls.
  const searchProvider = resolveProvider({
    name: namespace,
    tools: {
      spec: {
        execute: async () => {
          const spec = await getResolvedOpenAPISpec(env, v);
          return writesEnabled ? spec : filterOpenAPISpecToReadOnly(spec);
        },
      },
    },
  });

  const executeReadProvider = resolveProvider({
    name: namespace,
    tools: {
      request: {
        execute: createRequestHandler(readRequestHandlerConfig),
      },
    },
  });

  const executeWriteProvider = resolveProvider({
    name: namespace,
    tools: {
      request: {
        execute: createRequestHandler(writeRequestHandlerConfig),
      },
    },
  });

  const variantLabel = humanizeVariant(v);

  server.registerTool(
    searchName,
    {
      description: `${description}

${accessNote}

Use \`${searchName}\` to explore or filter the OpenAPI spec for the **${v}** API before calling \`${executeName}\`${writesEnabled ? ` or \`${executeWriteName}\`` : ""}. All $ref pointers are pre-resolved inline.${writesEnabled ? "" : " The spec returned here includes **GET** operations only."}

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

Use this tool (Code Mode: \`${executeName}\`) for **read-only** \`${variantLabel}\` calls at ${baseUrl} via \`${namespace}.request({ method: "GET", ... })\`. Use \`${searchName}\` first to find paths and request shapes. Auth headers are added on the host.${writesEnabled ? ` For create/update/delete, use \`${executeWriteName}\` instead.` : ""}

${REQUEST_RESPONSE_GUIDE(namespace)}

Types:
${READ_REQUEST_TYPES(namespace)}

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
      runCodeModeTool(() =>
        runCodeModeExecution(() => executor.execute(code, [executeReadProvider])),
      ),
  );

  if (!writesEnabled) return;

  server.registerTool(
    executeWriteName,
    {
      description: `${description}

${accessNote}

Use this tool (Code Mode: \`${executeWriteName}\`) for **write** \`${variantLabel}\` calls at ${baseUrl} via \`${namespace}.request({ method: "POST"|"PUT"|"PATCH"|"DELETE", ... })\`. Use \`${searchName}\` first to find paths and request shapes. Auth headers are added on the host. For \`GET\`, use \`${executeName}\` instead.

${REQUEST_RESPONSE_GUIDE(namespace)}

Types:
${WRITE_REQUEST_TYPES(namespace)}

Your code must be a single JavaScript async arrow function (no TypeScript).
Example:
async () => {
  const res = await ${namespace}.request({
    method: "PUT",
    path: "/v1/workflows/welcome",
    query: { environment: "development" },
    body: { name: "Welcome", steps: [] },
  });
  return { status: res.status, result: res.result };
}
`,
      inputSchema: { code: z.string().describe("JavaScript async arrow function to execute") },
    },
    async ({ code }) =>
      runCodeModeTool(() =>
        runCodeModeExecution(() => executor.execute(code, [executeWriteProvider])),
      ),
  );
}
