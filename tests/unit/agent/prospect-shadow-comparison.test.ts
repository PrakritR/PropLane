import { describe, expect, it } from "vitest";
import {
  compareProspectShadow,
  projectProspectShadowPrimaryEvidence,
  prospectRepetitionEvidence,
} from "@/lib/agent/prospect-shadow-comparison";

const identity = { burstId: "burst-1", burstRevision: 3, promptHash: "prompt-a", release: "leasing-v2", shadowProvider: "openai" as const, shadowModel: "gpt-test" };

describe("sealed prospect shadow comparison", () => {
  const jainEvidence = projectProspectShadowPrimaryEvidence([{
    name: "get_listing_details",
    arguments: { propertyId: "jain" },
    output: {
      found: true,
      listing: {
        propertyId: "jain",
        title: "Jain Home",
        rentLabel: "$1,200",
        address: "12 Cedar Street",
        available: "Now",
      },
    },
  }]);

  it("keeps identity paired and derives grounded/correction evidence only from supplied facts", () => {
    expect(compareProspectShadow({
      identity,
      primary: { output: "old", evidence: { supportedFacts: ["Jain Home", "$1,200"] } },
      shadow: { output: "Jain Home is $1,200.", toolCalls: [] },
      repetitionEvidence: { priorOutputs: ["Old answer"], correction: true },
    })).toMatchObject({ identity, grounding: "unknown", repetition: "correction", toolCorrectness: "unknown" });
  });

  it("does not infer tool replay from schemas or missing evidence", () => {
    expect(compareProspectShadow({ identity, primary: {}, shadow: { output: "hello", toolCalls: [{ name: "list_listings", arguments: {} }] } }).toolCorrectness).toBe("unknown");
    expect(compareProspectShadow({
      identity,
      primary: { evidence: { toolCalls: [{ name: "list_listings", arguments: { query: "Jain Home" } }] } },
      shadow: { output: "hello", toolCalls: [{ name: "list_listings", arguments: { query: "Other Home" } }] },
    }).toolCorrectness).toBe("mismatch");
  });

  it("marks absent and empty evidence unknown, while exact repeats are deterministic", () => {
    expect(compareProspectShadow({ identity, primary: {}, shadow: { output: "" } })).toMatchObject({ grounding: "unknown", repetition: "unknown", toolCorrectness: "unknown" });
    expect(compareProspectShadow({ identity, primary: {}, shadow: { output: " Same reply " }, repetitionEvidence: { priorOutputs: ["same   reply"] } }).repetition).toBe("repeat");
  });

  it("keeps paraphrases unknown, rejects unsupported numbers, and separates requested resends", () => {
    expect(compareProspectShadow({
      identity,
      primary: {},
      shadow: { output: "Here is the same answer in other words." },
      repetitionEvidence: { priorOutputs: ["A paraphrase of that answer."] },
    }).repetition).toBe("unknown");
    expect(compareProspectShadow({
      identity,
      primary: { evidence: { supportedFacts: ["Jain Home rent is $1,000"] } },
      shadow: { output: "Jain Home rent is $1,000 and the deposit is $999,999." },
    }).grounding).toBe("ungrounded");
    expect(compareProspectShadow({
      identity,
      primary: { evidence: { supportedFacts: ["Jain Home rent is $1,000"] } },
      shadow: { output: "Jain Home rent is $1,000." },
    }).grounding).toBe("grounded");
    expect(compareProspectShadow({
      identity,
      primary: {},
      shadow: { output: "Same reply" },
      repetitionEvidence: { priorOutputs: ["Same reply"], explicitRepeat: true },
    }).repetition).toBe("requested_repeat");
  });

  it("binds complete assertions to their projected listing fields", () => {
    const grounding = (output: string) => compareProspectShadow({
      identity,
      primary: { evidence: jainEvidence },
      shadow: { output },
    }).grounding;

    expect(grounding("Jain Home rent is 12.")).toBe("unknown");
    expect(grounding("Jain Home address is $1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,2000.")).toBe("ungrounded");
    expect(grounding("Jain Home rent is $1,200.")).toBe("grounded");
    expect(grounding("Jain Home rent is $1200.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200.00.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Jain Home rent is $1200.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,300.")).toBe("ungrounded");
    expect(grounding("JAIN   HOME rent is $1,200.")).toBe("grounded");
    expect(grounding("Jain Home rent is $1,200. Jain Home address is 12 Cedar Street.")).toBe("grounded");
    expect(grounding("Jain Home rent is $1,200 and it is.")).toBe("unknown");
    expect(grounding("Jain Home address is 12 Cedar Street.")).toBe("grounded");
    expect(grounding("Jain Home is available Now.")).toBe("grounded");
  });

  it("preserves signs, operators, currency punctuation, and links in literal assertion proof", () => {
    const grounding = (output: string) => compareProspectShadow({
      identity,
      primary: { evidence: jainEvidence },
      shadow: { output },
    }).grounding;

    expect(grounding("Jain Home rent is -$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is −$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is >$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is <$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is >=$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is <=$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is ≥$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is ≤$1,200.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Deposit is -$500.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Deposit is −$500.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Deposit is >$500.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Deposit is <=$500.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Deposit is not $500.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Deposit is €500.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200. Deposit is $500.")).toBe("ungrounded");
    expect(grounding("Jain Home rent is $1,200!")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200, exactly.")).toBe("unknown");
    expect(grounding("Jain Home rent is not $1,200.")).toBe("unknown");
    expect(grounding("Jain Home listing is https://example.test/jain.")).toBe("unknown");
    const linkEvidence = { supportedFacts: ["Jain Home listing is https://example.test/Jain?floor=2&view=West"] };
    expect(compareProspectShadow({
      identity,
      primary: { evidence: linkEvidence },
      shadow: { output: "JAIN HOME listing is https://example.test/Jain?floor=2&view=West." },
    }).grounding).toBe("grounded");
    expect(compareProspectShadow({
      identity,
      primary: { evidence: linkEvidence },
      shadow: { output: "Jain Home listing is https://example.test/jain?floor=2&view=west." },
    }).grounding).toBe("unknown");
  });

  it("does not optimistically ground cross-property, negated, added, or paraphrased assertions", () => {
    const oakEvidence = projectProspectShadowPrimaryEvidence([{
      name: "get_listing_details",
      arguments: { propertyId: "oak" },
      output: {
        found: true,
        listing: {
          propertyId: "oak",
          title: "Oak House",
          rentLabel: "$1,800",
          address: "34 Oak Avenue",
          available: "October 1",
        },
      },
    }]);
    const evidence = {
      supportedFacts: [...jainEvidence.supportedFacts, ...oakEvidence.supportedFacts],
      supportedFactGroups: [...jainEvidence.supportedFactGroups, ...oakEvidence.supportedFactGroups],
    };
    const grounding = (output: string) => compareProspectShadow({
      identity,
      primary: { evidence },
      shadow: { output },
    }).grounding;

    expect(grounding("Jain Home rent is $1,200 and Oak House is available October 1.")).toBe("unknown");
    expect(grounding("Jain Home is not available Now.")).toBe("unknown");
    expect(grounding("Jain Home rent is $1,200 and pets are allowed.")).toBe("unknown");
    expect(grounding("The monthly price for Jain Home comes to twelve hundred dollars.")).toBe("unknown");
  });

  it("serializes explicit repeat and correction intent without guessing from absent text", () => {
    expect(prospectRepetitionEvidence("Can you send that again?", ["Prior answer"]))
      .toMatchObject({ explicitRepeat: true, correction: false, newDetail: false });
    expect(prospectRepetitionEvidence("Actually, I meant Jain Home", ["Prior answer"]))
      .toMatchObject({ explicitRepeat: false, correction: true, newDetail: false });
    expect(prospectRepetitionEvidence("", []))
      .toMatchObject({ explicitRepeat: false, correction: false, newDetail: false });
    expect(prospectRepetitionEvidence("What about parking?", ["Prior answer"]))
      .toMatchObject({ explicitRepeat: false, correction: false, newDetail: false });
  });
});
