import { describe, expect, it } from "vitest";
import {
  suggestInboundMessageWorkflows,
  workflowTitleFromMessage,
} from "@/lib/inbox/inbound-message-workflow-suggestions";

describe("inbound-message-workflow-suggestions", () => {
  it("suggests maintenance when the message describes a repair", () => {
    const suggestions = suggestInboundMessageWorkflows("The kitchen sink is leaking again.");
    expect(suggestions.map((s) => s.kind)).toContain("maintenance_work_order");
  });

  it("suggests add-on service for parking or storage asks", () => {
    const suggestions = suggestInboundMessageWorkflows("Can I add a parking spot for my second car?");
    expect(suggestions.map((s) => s.kind)).toContain("addon_service");
  });

  it("returns no suggestions for unrelated small talk", () => {
    expect(suggestInboundMessageWorkflows("Thanks!")).toEqual([]);
  });

  it("truncates long workflow titles", () => {
    const long = "a".repeat(120);
    const title = workflowTitleFromMessage(long, "Fallback");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
  });
});
