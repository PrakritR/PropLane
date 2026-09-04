import { describe, expect, it } from "vitest";
import {
  suggestInboundMessageWorkflows,
  workflowTitleFromMessage,
} from "@/lib/inbox/inbound-message-workflow-suggestions";
import { classifyInboundMessage } from "@/lib/inbox/inbound-message-intent";

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

/**
 * PRP-109 regression guard.
 *
 * A merge silently reverted this module to its own private regex list while
 * `looksLikeMaintenanceRequest` (the LIVE SMS gate) kept delegating to the
 * shared classifier. Git raised no conflict and the tests above passed, because
 * both versions agree on the easy cases — the split only shows on the messages
 * the classifier was built to get right.
 *
 * These assert AGREEMENT with the classifier rather than any particular
 * wording, so the chips cannot drift away from what the server actually files.
 */
describe("chips agree with the shared classifier", () => {
  const kinds = (s: string) => suggestInboundMessageWorkflows(s).map((x) => x.kind);

  it.each([
    "The toilet leak is fixed now, thanks!",
    "thanks for fixing the sink so fast",
    "Can we fix a time to meet on Tuesday?",
    "I'm locked out of my account, can you reset my password?",
  ])("offers nothing for: %s", (msg) => {
    expect(classifyInboundMessage(msg).intent).toBe("none");
    expect(kinds(msg)).toEqual([]);
  });

  it.each([
    ["my toilet is broken", "maintenance_work_order"],
    ["The kitchen sink is leaking again", "maintenance_work_order"],
    ["Can I add a parking spot for my second car?", "addon_service"],
  ])("offers the matching chip for: %s", (msg, kind) => {
    expect(kinds(msg)).toContain(kind);
  });

  it("never offers a chip the classifier would not file", () => {
    for (const msg of [
      "Thanks!",
      "when is rent due?",
      "The kitchen is lovely, thanks for the tour",
      "the sink in the photos looks nice",
    ]) {
      expect(classifyInboundMessage(msg).intent).toBe("none");
      expect(kinds(msg)).toEqual([]);
    }
  });
});
