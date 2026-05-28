import { describe, expect, it } from "vitest";

import { resolveRefs, filterOpenAPISpecToReadOnly } from "./openapi-cache";

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
