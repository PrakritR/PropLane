import { describe, expect, it } from "vitest";
import {
  INTENT_MIN_CONFIDENCE,
  classifyInboundMessage,
} from "@/lib/inbox/inbound-message-intent";

const intentOf = (s: string) => classifyInboundMessage(s).intent;

/**
 * PRP-109. The classifier is the trigger for a manager-facing proposal, so the
 * table below is the specification: a row that changes is a product change.
 */
describe("classifyInboundMessage — maintenance", () => {
  it.each([
    "The kitchen sink is leaking again.",
    "There's no hot water in unit 3.",
    "My dishwasher stopped working yesterday",
    "Can you send someone to look at the heater? It's not working.",
    "the toilet is clogged, please help",
    "smells like gas in the hallway",
  ])("reports a repair: %s", (msg) => {
    expect(intentOf(msg)).toBe("maintenance");
  });

  it("flags an emergency so it can jump the queue", () => {
    const r = classifyInboundMessage("URGENT — burst pipe, water everywhere");
    expect(r.intent).toBe("maintenance");
    expect(r.urgency).toBe("emergency");
  });

  it("marks an ordinary repair normal, not urgent", () => {
    expect(classifyInboundMessage("the bedroom outlet is not working").urgency).toBe("normal");
  });
});

describe("classifyInboundMessage — add-on services", () => {
  it.each([
    "Can I add a parking spot for my second car?",
    "Is it possible to rent a storage unit?",
    "I'd like a garage space if one is free",
  ])("reports an add-on ask: %s", (msg) => {
    expect(intentOf(msg)).toBe("add_on_service");
  });
});

/**
 * The false positives that matter. Each of these WOULD have produced a work
 * order under a plain keyword match, and each is common in a real thread.
 */
describe("classifyInboundMessage — does not fire on non-requests", () => {
  it("stays silent once the problem is already handled", () => {
    // The word "leak" is still in the sentence — resolution has to beat it.
    expect(intentOf("The leak is fixed now, thanks!")).toBe("none");
    expect(intentOf("thanks for fixing the toilet so fast")).toBe("none");
    expect(intentOf("Never mind — the heater is working again")).toBe("none");
    expect(intentOf("all good, disregard my last message")).toBe("none");
  });

  it("does not treat an unrelated use of a weak word as a repair", () => {
    // "fix" and "locked" are the two that bit the previous keyword version.
    expect(intentOf("Can we fix a time to meet on Tuesday?")).toBe("none");
    expect(intentOf("I'm locked out of my account, can you reset my password?")).toBe("none");
  });

  it("does not treat a passing mention of a room as a repair", () => {
    expect(intentOf("The kitchen is lovely, thanks for the tour")).toBe("none");
  });

  it("ignores small talk and empty input", () => {
    expect(intentOf("Thanks!")).toBe("none");
    expect(intentOf("")).toBe("none");
    expect(intentOf("   ")).toBe("none");
  });
});

describe("classifyInboundMessage — eligibility structure", () => {
  it("reads a plain statement of fact as a report, with nobody saying please", () => {
    // Requiring a request marker broke this: a resident texting "my toilet is
    // broken" is reporting a repair, not making a polite enquiry, and the live
    // SMS path had classified it as maintenance for a long time.
    expect(intentOf("my toilet is broken")).toBe("maintenance");
    expect(intentOf("the dryer is dead")).toBe("maintenance");
  });

  it("needs BOTH halves — a failure word and a fixture", () => {
    expect(intentOf("can we fix a time to meet")).toBe("none"); // failure, no fixture
    expect(intentOf("the sink in the photos looks nice")).toBe("none"); // fixture, no failure
  });

  it("does not let maintenance swallow an add-on ask", () => {
    // Both sides are scored, but only an ELIGIBLE side may win; comparing raw
    // scores handed every add-on request to maintenance.
    expect(intentOf("Can I request reserved parking?")).toBe("add_on_service");
    expect(intentOf("could I get a storage locker")).toBe("add_on_service");
  });
});

describe("classifyInboundMessage — scoring", () => {
  it("keeps a lone weak keyword below the action threshold", () => {
    // "sink" alone is a topic, not a request; it must not clear the bar.
    const r = classifyInboundMessage("sink");
    expect(r.confidence).toBeLessThan(INTENT_MIN_CONFIDENCE);
    expect(r.intent).toBe("none");
  });

  it("explains itself — every decision carries the signals that drove it", () => {
    const r = classifyInboundMessage("Please fix the leaking faucet");
    expect(r.intent).toBe("maintenance");
    expect(r.signals.some((s) => s.startsWith("strong:"))).toBe(true);
    expect(r.signals.some((s) => s.startsWith("request:"))).toBe(true);
  });

  it("prefers maintenance when a message touches both", () => {
    // An unreported broken thing costs more than an unbooked parking spot.
    expect(intentOf("the light in my parking spot is not working")).toBe("maintenance");
  });
});
