import { describe, expect, it } from "vitest";
import { runAgentTurn } from "@/lib/agent/loop";
import { RESIDENT_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

const live = process.env.LIVE_LUNA_CANARY === "1" && Boolean(process.env.OPENAI_API_KEY);

function fixtureContext(): ResidentAgentContext {
  const row = {
    id: "canary-home",
    status: "live",
    property_data: {
      title: "Cedar House",
      address: "1 Cedar St",
      available: "Unavailable",
      listingSubmission: {
        ...createDefaultListingSubmission(),
        rooms: [
          { id: "room-a", name: "Room A", monthlyRent: 800, availability: "Available now", furnishing: "Furnished", roomAmenitiesText: "Desk and closet" },
          { id: "room-b", name: "Room B", monthlyRent: 850, availability: "Unavailable (occupied)", furnishing: "Unfurnished" },
        ],
      },
    },
    row_data: null,
  };
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "order", "limit"]) query[name] = () => query;
  query.maybeSingle = async () => ({ data: row, error: null });
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [row], error: null }).then(resolve);
  return {
    kind: "resident",
    userId: "canary-resident",
    email: "canary@example.invalid",
    managerIds: ["canary-manager"],
    activeManagerId: "canary-manager",
    landlordId: "canary-resident",
    channel: "sms",
    phase: "application",
    managerTier: null,
    db: { from: () => query } as ResidentAgentContext["db"],
  };
}

describe.runIf(live)("live Luna resident listing canary", () => {
  it("answers from room facts and attributes published availability", async () => {
    const ctx = fixtureContext();
    const result = await runAgentTurn({
      ctx,
      registry: buildResidentRegistry(ctx),
      system: RESIDENT_SMS_AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Is Room A at Cedar House available and furnished?" }],
      toolNames: ["list_live_listings", "get_listing_details", "get_listing_link"],
      readOnly: true,
      model: {
        model: "gpt-6-luna",
        tier: "standard",
        provider: "openai",
        route: "luna_primary",
        reasoningEffort: "low",
        maxOutputTokens: 1200,
        timeoutMs: 45_000,
      },
    });
    const reply = result.reply.toLowerCase();
    expect(result.provider).toBe("openai");
    expect(result.toolEvidence.map((entry) => entry.name)).toContain("list_live_listings");
    expect(reply).toContain("furnished");
    expect(reply).toMatch(/listing (shows|says|lists)/);
    expect(reply).toMatch(/available now|available/);
    expect(reply).not.toMatch(/unavailable|manager (will|needs to) (answer|confirm)/);
  }, 120_000);
});
