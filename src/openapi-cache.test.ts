import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRefs, filterOpenAPISpecToReadOnly, getRawOpenAPISpec } from "./openapi-cache";

describe("resolveRefs", () => {
  it("inlines internal JSON pointers", () => {
    const root = {
      components: {
        schemas: {
          Pet: { type: "object", properties: { name: { type: "string" } } },
        },
      },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pet" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const resolved = resolveRefs(root, root) as typeof root;
    const schema = resolved.paths["/pets"].get.responses["200"].content["application/json"]
      .schema as { type?: string; properties?: { name?: { type?: string } } };
    expect(schema.type).toBe("object");
    expect(schema.properties?.name?.type).toBe("string");
  });

  it("marks circular refs without looping", () => {
    const root: Record<string, unknown> = {
      self: { $ref: "#/self" },
    };

    const resolved = resolveRefs(root, root) as { self: { $circular: string } };
    expect(resolved.self).toEqual({ $circular: "#/self" });
  });
});

describe("filterOpenAPISpecToReadOnly", () => {
  it("keeps only GET operations on each path", () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/v1/a": { get: { summary: "list" }, post: { summary: "create" } },
        "/v1/b": { post: { summary: "only write" } },
        "/v1/c": { get: { summary: "read" }, parameters: [] },
      },
    };
    const filtered = filterOpenAPISpecToReadOnly(spec) as typeof spec;
    expect(filtered.paths["/v1/a"]).toEqual({ get: { summary: "list" } });
    expect(filtered.paths["/v1/b"]).toBeUndefined();
    expect(filtered.paths["/v1/c"]).toEqual({
      get: { summary: "read" },
      parameters: [],
    });
  });
});

describe("Management API OpenAPI cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the refreshed v2 cache key", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ openapi: "3.0.0", paths: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await getRawOpenAPISpec(
      {
        KNOCK_CONTROL_URL: "https://control.knock.app",
        OAUTH_KV: { get, put, delete: vi.fn() },
      } as unknown as Env,
      "mapi",
    );

    expect(get).toHaveBeenCalledWith("openapi:mapi:control.knock.app:v2");
    expect(put).toHaveBeenCalledWith("openapi:mapi:control.knock.app:v2", expect.any(String), {
      expirationTtl: 24 * 60 * 60,
    });
  });
});
