import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true }),
  clientIpFrom: () => "1.2.3.4",
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/observability/langfuse", () => ({
  tracePublicToolTurn: async (opts: { run: (r: unknown) => Promise<unknown> }) =>
    opts.run({ llmCall: () => undefined, toolCall: () => undefined }),
}));

const base = createDefaultListingSubmission();
const listings: MockProperty[] = [
  {
    id: "u1",
    title: "U1",
    tagline: "",
    address: "1 Campus Way, Seattle, WA",
    zip: "98105",
    neighborhood: "University District",
    beds: 3,
    baths: 2,
    rentLabel: "$1100/mo",
    available: "Now",
    petFriendly: true,
    buildingId: "b",
    buildingName: "B",
    unitLabel: "A",
    adminPublishLive: true,
    listingSubmission: {
      ...base,
      allowedLeaseTerms: ["Long-term"],
      rooms: [{ ...base.rooms[0]!, id: "r1", name: "Room 1", monthlyRent: 1100 }],
    },
  },
];
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => listings }));

import { POST } from "@/app/api/agent/housing-search/route";

function req(body: unknown) {
  return new Request("http://localhost/api/agent/housing-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/housing-search", () => {
  const key = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => create.mockReset());
  afterEach(() => {
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  });

  it("answers 503 without ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await POST(req({ message: "a room near UW" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/configured/);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s an empty message", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    expect((await POST(req({ message: "  " }))).status).toBe(400);
  });

  it("turns the model's tool call into filters, a count and listings, resolving the UW alias", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    create.mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        {
          type: "tool_use",
          name: "search_public_housing",
          input: { maxBudget: 1200, petFriendly: true, neighborhood: "UW", leaseTypes: ["long_term"] },
        },
      ],
    });
    const res = await POST(req({ message: "pet friendly under $1,200 near UW", sessionId: "s" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filters).toMatchObject({
      maxBudget: 1200,
      petFriendly: true,
      neighborhood: "University District",
      leaseTypes: ["long_term"],
    });
    expect(body.matchCount).toBe(1);
    expect(body.listings[0]).toMatchObject({ propertyId: "u1", neighborhood: "University District" });
    const system = create.mock.calls[0]![0].system as string;
    expect(system).toContain("University District");
  });
});
