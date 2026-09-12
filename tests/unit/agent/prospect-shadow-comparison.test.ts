import { describe, expect, it } from "vitest";
import { compareProspectShadow, prospectRepetitionEvidence } from "@/lib/agent/prospect-shadow-comparison";

const identity = { burstId: "burst-1", burstRevision: 3, promptHash: "prompt-a", release: "leasing-v2", shadowProvider: "openai" as const, shadowModel: "gpt-test" };

describe("sealed prospect shadow comparison", () => {
  it("keeps identity paired and derives grounded/correction evidence only from supplied facts", () => {
    expect(compareProspectShadow({
      identity,
      primary: { output: "old", evidence: { supportedFacts: ["Jain Home", "$1,200"] } },
      shadow: { output: "Jain Home is $1,200.", toolCalls: [] },
      repetitionEvidence: { priorOutputs: ["Old answer"], correction: true },
    })).toMatchObject({ identity, grounding: "grounded", repetition: "correction", toolCorrectness: "unknown" });
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
      primary: {},
      shadow: { output: "Same reply" },
      repetitionEvidence: { priorOutputs: ["Same reply"], explicitRepeat: true },
    }).repetition).toBe("requested_repeat");
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
