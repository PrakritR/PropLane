import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK so no test ever makes a network call.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { mapUnknownHeadersWithAi } from "@/lib/portfolio-import/column-map-ai.server";

function anthropicTextResponse(body: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    usage: { input_tokens: 5, output_tokens: 10 },
    stop_reason: "end_turn",
  };
}

const actor = { userId: "manager_a" };

beforeEach(() => {
  create.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mapUnknownHeadersWithAi", () => {
  it("returns {} under the test environment, and never calls the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const result = await mapUnknownHeadersWithAi({
      headers: [{ index: 0, header: "Tenant Contact", samples: ["dana.w@gmail.com"] }],
      actor,
    });
    expect(result).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  it("returns {} without an API key even outside the test environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = await mapUnknownHeadersWithAi({
      headers: [{ index: 0, header: "Tenant Contact", samples: ["dana.w@gmail.com"] }],
      actor,
    });
    expect(result).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  it("returns {} for an empty header list without calling the model", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const result = await mapUnknownHeadersWithAi({ headers: [], actor });
    expect(result).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  it("validates returned keys, keeps a null, and drops a non-canonical value, with the sdk stubbed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    create.mockResolvedValueOnce(
      anthropicTextResponse({
        "0": "residentEmail",
        "1": "notACanonicalKey",
        "2": null,
      }),
    );

    const result = await mapUnknownHeadersWithAi({
      headers: [
        { index: 0, header: "Tenant Contact", samples: ["dana.w@gmail.com"] },
        { index: 1, header: "Weird Column", samples: ["x"] },
        { index: 2, header: "Notes", samples: [] },
      ],
      actor,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result[0]).toBe("residentEmail");
    expect(result[1]).toBeUndefined();
    expect(result[2]).toBeNull();
  });

  it("returns {} when the model reply is not parsable JSON", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    create.mockResolvedValueOnce(anthropicTextResponse("not an object")); // wraps in quotes, no braces

    const result = await mapUnknownHeadersWithAi({
      headers: [{ index: 0, header: "Tenant Contact", samples: [] }],
      actor,
    });
    expect(result).toEqual({});
  });
});
