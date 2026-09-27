import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderCompletion } from "@/lib/agent/provider";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  publicListings: vi.fn(),
  occupancy: vi.fn(async () => []),
}));

vi.mock("@/lib/agent/provider", () => ({ completeAgentModel: mocks.complete }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));
vi.mock("@/lib/public-room-occupancy.server", () => ({ loadPublicRoomOccupancy: mocks.occupancy }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { runAgentTurn } from "@/lib/agent/loop";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { buildRegistry } from "@/lib/tools/registry";
import {
  __resetLeasingCatalogCache,
  __resetSmsOccupancyCache,
  getListingDetailsTool,
} from "@/lib/tools/domains/leasing-sms";
import { residentSmsGetListingDetailsTool } from "@/lib/tools/domains/resident/sms-listings";

const listingSubmission = {
  ...createDefaultListingSubmission(),
  rooms: [
    {
      id: "room-1",
      name: "Room 1",
      monthlyRent: 900,
      occupancyCapacity: 1,
      bedCount: 1,
      availability: "Available now",
    },
    {
      id: "room-2",
      name: "Room 2",
      monthlyRent: 1_100,
      occupancyCapacity: 2,
      bedCount: 1,
      availability: "Available now",
    },
  ],
};

const listing = {
  id: "capacity-home",
  status: "live",
  title: "Capacity Home",
  buildingName: "Capacity Home",
  address: "1 Cedar Street",
  managerUserId: "manager-1",
  listingSubmission,
};

function providerResponse(
  provider: ProviderCompletion["provider"],
  content: Anthropic.ContentBlock[],
  stopReason: string,
): ProviderCompletion {
  return {
    content,
    stopReason,
    provider,
    latencyMs: 1,
    usage: { inputTokens: 10, outputTokens: 4 },
  };
}

function dbReturningListing() {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "order", "limit"]) chain[name] = () => chain;
  chain.maybeSingle = async () => ({
    data: {
      id: listing.id,
      status: listing.status,
      property_data: listing,
      row_data: null,
    },
    error: null,
  });
  return { from: () => chain } as unknown as ResidentAgentContext["db"];
}

function toolResultPayload(callIndex: number): string {
  const request = mocks.complete.mock.calls[callIndex]![0] as {
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  };
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    const result = message.content.find((block) => block.type === "tool_result");
    if (typeof result?.content === "string") return result.content;
  }
  throw new Error("tool result missing from provider handoff");
}

beforeEach(() => {
  mocks.complete.mockReset();
  mocks.publicListings.mockReset().mockResolvedValue([listing]);
  mocks.occupancy.mockClear();
  __resetLeasingCatalogCache();
  __resetSmsOccupancyCache();
});

describe("SMS listing capacity tool handoff", () => {
  it("feeds the actual prospect listing tool result into the next Claude Sonnet request", async () => {
    mocks.complete
      .mockResolvedValueOnce(providerResponse("anthropic", [{
        type: "tool_use",
        id: "prospect-details",
        name: "get_listing_details",
        input: { propertyId: listing.id },
      } as Anthropic.ToolUseBlock], "tool_use"))
      .mockResolvedValueOnce(providerResponse("anthropic", [{
        type: "text",
        text: "Room 2 allows two residents; the published room capacity totals three.",
      } as Anthropic.TextBlock], "end_turn"));
    const ctx = {
      landlordId: "manager-1",
      userId: "manager-1",
      email: "",
      roles: ["leasing_sms_agent"],
      isAdmin: false,
      db: dbReturningListing(),
      leasingScope: {
        sessionId: "prospect-session",
        prospectPhoneE164: "+15550001111",
        crossCatalog: true,
      },
    } as AgentContext;

    const result = await runAgentTurn({
      ctx,
      registry: buildRegistry([getListingDetailsTool]),
      messages: [{ role: "user", content: "How many people can live there?" }],
      model: { model: "claude-sonnet-4-6", tier: "standard", provider: "anthropic", route: "anthropic" },
    });

    expect(result.provider).toBe("anthropic");
    expect(result.toolEvidence[0]).toMatchObject({ tool: "get_listing_details" });
    const payload = toolResultPayload(1);
    expect(payload).toContain('"residentCapacity":2');
    expect(payload).toContain('"physicalBeds":1');
    expect(payload).toContain('"maximumResidents":3');
  });

  it("feeds the actual verified-resident wrapper result into the retained Luna request format", async () => {
    mocks.complete
      .mockResolvedValueOnce(providerResponse("openai", [{
        type: "tool_use",
        id: "resident-details",
        name: "get_listing_details",
        input: { propertyId: listing.id },
      } as Anthropic.ToolUseBlock], "tool_use"))
      .mockResolvedValueOnce(providerResponse("openai", [{
        type: "text",
        text: "Room 2 allows two residents; the published room capacity totals three.",
      } as Anthropic.TextBlock], "end_turn"));
    const ctx = {
      kind: "resident",
      userId: "resident-1",
      email: "resident@example.test",
      managerIds: ["manager-1"],
      activeManagerId: "manager-1",
      landlordId: "resident-1",
      channel: "sms",
      phase: "application",
      managerTier: null,
      db: dbReturningListing(),
    } as ResidentAgentContext;

    const result = await runAgentTurn({
      ctx,
      registry: buildRegistry([residentSmsGetListingDetailsTool]),
      messages: [{ role: "user", content: "How many people can live there?" }],
      model: {
        model: "gpt-6-luna",
        tier: "standard",
        provider: "openai",
        route: "luna_primary",
        reasoningEffort: "low",
      },
    });

    expect(result.provider).toBe("openai");
    expect(result.toolEvidence[0]).toMatchObject({ tool: "get_listing_details" });
    const payload = toolResultPayload(1);
    expect(payload).toContain('"residentCapacity":2');
    expect(payload).toContain('"physicalBeds":1');
    expect(payload).toContain('"maximumResidents":3');
  });
});
