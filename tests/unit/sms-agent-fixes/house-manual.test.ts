import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeHouseInfo } from "@/lib/house-info";

const mocks = vi.hoisted(() => ({ entries: vi.fn(), owned: vi.fn() }));
vi.mock("@/lib/one-number/knowledge/store.server", () => ({ loadAnswerableEntries: mocks.entries, recordEntryUse: vi.fn() }));
vi.mock("@/lib/one-number/knowledge/scope.server", () => ({ loadOwnedProperty: mocks.owned, loadWorkspaceProperties: vi.fn(async () => []) }));

import { lookupPropertyKnowledge } from "@/lib/one-number/knowledge/lookup.server";
import { houseManualForScope, isDisputeText } from "@/lib/one-number/knowledge/house-manual";
import { KNOWLEDGE_RULES_RESIDENT_PROSPECT_VENDOR } from "@/lib/one-number/knowledge/prompt";
import { RESIDENT_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";

const MANUAL = [
  "Lockout fee: $25 each time.",
  "Luggage storage after check-out: $5 per piece.",
  "Extension pricing: first month $1,000, then $1,200 per month.",
  "Guests may stay up to 3 nights with notice.",
  "Emotional support and service animals with a letter are welcome; pets are not allowed.",
  "Deposit: $250, returned 21 days after move-out less itemized deductions.",
  "Front door code is 5257# for everyone.",
].join("\n");

const houseInfo = normalizeHouseInfo({ access: { doorCode: "5257#" } });
const brief = (houseRulesText = MANUAL) => ({
  id: "h1", workspaceId: "ws1", label: "5257 Brooklyn", houseInfo,
  roomSecrets: ["6666"], manual: { houseRulesText, generalHouseInfo: "" },
});
const scope = (over: Record<string, unknown> = {}) => ({
  viewer: "resident" as const, workspaceId: "ws1", ownerUserId: "o1", allowedPropertyIds: ["h1"], focusPropertyId: "h1",
  audiences: ["all", "residents"] as never, includeHouseInfo: true, includeHouseSecrets: true, ...over,
});

beforeEach(() => {
  mocks.entries.mockReset().mockResolvedValue([]);
  mocks.owned.mockReset().mockResolvedValue(brief());
});

describe("house manual: fees and policies come from the tool", () => {
  it("returns the manual with its exact amounts for a fee question", async () => {
    const out = await lookupPropertyKnowledge({} as never, scope(), "how much to store my bags after checkout?");
    expect(out.found).toBe(true);
    const text = JSON.stringify(out.houseManual);
    for (const fact of ["$25", "$5 per piece", "$1,000", "$1,200", "3 nights", "$250", "21 days"]) expect(text).toContain(fact);
    expect(out.guidance).toMatch(/houseManual/);
  });

  it("a deposit-return or service-animal POLICY question is answered from the manual instead of escalated", async () => {
    for (const q of ["When do I get my deposit back after I move out?", "I have an emotional support animal with a letter. Is that ok?"]) {
      const out = await lookupPropertyKnowledge({} as never, scope(), q);
      expect(out.mustEscalate, q).toBeNull();
      expect(out.houseManual?.length, q).toBeGreaterThan(0);
    }
  });

  it("a dispute still goes to the team whatever the manual says", async () => {
    const out = await lookupPropertyKnowledge({} as never, scope(), "I want to dispute my deposit deductions, I was double charged");
    expect(out.mustEscalate).toBe("money");
    expect(isDisputeText("please waive the lockout fee")).toBe(true);
    expect(isDisputeText("when is my deposit returned")).toBe(false);
  });

  it("without a manual the answer is not found and the guidance says to escalate (never invent a fee)", async () => {
    mocks.owned.mockResolvedValue(brief(""));
    const out = await lookupPropertyKnowledge({} as never, scope(), "how much is the lockout fee?");
    expect(out.houseManual).toBeUndefined();
    expect(out.found).toBe(false);
    expect(out.guidance).toMatch(/Do not guess/);
  });

  it("a resident who may not read house details (before the lock lifts) gets no manual", async () => {
    const out = await lookupPropertyKnowledge({} as never, scope({ includeHouseInfo: false }), "lockout fee?");
    expect(out.houseManual).toBeUndefined();
    expect(mocks.owned).not.toHaveBeenCalled();
  });

  it("a manual line that quotes a door code is dropped until the check-in reveal", () => {
    const hidden = houseManualForScope({ includeHouseSecrets: false }, brief());
    expect(JSON.stringify(hidden)).not.toContain("5257#");
    expect(JSON.stringify(hidden)).toContain("Lockout fee");
    expect(JSON.stringify(houseManualForScope({ includeHouseSecrets: true }, brief()))).toContain("5257#");
  });
});

describe("prompts send fee and policy questions to the manual", () => {
  it("the shared knowledge rules and the resident SMS prompt name houseManual and forbid inventing a fee", () => {
    expect(KNOWLEDGE_RULES_RESIDENT_PROSPECT_VENDOR).toMatch(/houseManual/);
    expect(KNOWLEDGE_RULES_RESIDENT_PROSPECT_VENDOR).toMatch(/not in PropLane/);
    expect(RESIDENT_SMS_AGENT_SYSTEM_PROMPT).toMatch(/lockout, luggage storage, extension pricing, guests, service or support animals, deposit return/);
    expect(RESIDENT_SMS_AGENT_SYSTEM_PROMPT).toMatch(/Never invent a fee/);
  });
});
