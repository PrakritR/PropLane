// The DEMO step machine: every step, wrong answers, STOP/exit mid-demo, restart, and the copy rules.
import { describe, expect, it } from "vitest";
import {
  advanceDemo,
  bubbleToSms,
  currentPrompt,
  DEMO_COPY,
  demoEndCommand,
  FINISH_URL_TOKEN,
  isDemoStartText,
  startDemo,
  suggestionsFor,
} from "@/lib/one-number/demo/script";
import type { DemoState } from "@/lib/one-number/demo/types";

const texts = (bubbles: { text: string }[]) => bubbles.map((b) => b.text);

describe("start", () => {
  it("opens with the intro and moment 1, ending on a NEXT prompt", () => {
    const start = startDemo();
    expect(start.state).toEqual({ step: "applicant", hints: {}, strikes: 0 });
    expect(texts(start.bubbles)[0]).toContain("61 Willow Court");
    expect(start.bubbles.map((b) => b.kind)).toEqual(["agent", "agent", "sample", "agent"]);
    expect(texts(start.bubbles).at(-1)).toContain("NEXT");
  });
  it("keeps what the user already volunteered", () => {
    expect(startDemo({ address: "9 Elm St" }).state.hints).toEqual({ address: "9 Elm St" });
  });
});

describe("the three moments", () => {
  it("walks applicant -> leak (Y) -> rent -> questions", () => {
    let state = startDemo().state;
    let step = advanceDemo(state, "next");
    expect(step.state.step).toBe("leak");
    expect(step.bubbles.some((b) => b.kind === "sample" && b.text.includes("Pat Plumbing"))).toBe(true);
    step = advanceDemo(step.state, "Y");
    expect(step.state.step).toBe("rent");
    expect(texts(step.bubbles)[0]).toContain("Approved");
    expect(step.bubbles.some((b) => b.kind === "sample" && b.text.includes("rent"))).toBe(true);
    step = advanceDemo(step.state, "next");
    expect(step.state.step).toBe("ask_address");
    expect(step.finish).toBe(false);
    state = step.state;
  });

  it("N holds the plumber and still moves on to rent", () => {
    const leak = advanceDemo(startDemo().state, "go").state;
    const held = advanceDemo(leak, "no");
    expect(held.state.step).toBe("rent");
    expect(texts(held.bubbles)[0]).toContain("Held");
  });

  it("asks again once on a wrong answer, then moves on instead of looping", () => {
    const leak = advanceDemo(startDemo().state, "go").state;
    const first = advanceDemo(leak, "what?");
    expect(first.state.step).toBe("leak");
    expect(first.state.strikes).toBe(1);
    expect(texts(first.bubbles)).toEqual([DEMO_COPY.m2Retry]);
    const second = advanceDemo(first.state, "huh");
    expect(second.state.step).toBe("rent");
  });
});

describe("the setup questions", () => {
  const atQuestions = (): DemoState => advanceDemo(advanceDemo(advanceDemo(startDemo().state, "n").state, "y").state, "n").state;

  it("takes address, rooms, rent, then finishes with the link placeholder", () => {
    let step = advanceDemo(atQuestions(), "I live at 123 Main St");
    expect(step.state).toMatchObject({ step: "ask_rooms", hints: { address: "123 Main St" } });
    step = advanceDemo(step.state, "four");
    expect(step.state).toMatchObject({ step: "ask_rent", hints: { address: "123 Main St", rooms: 4 } });
    step = advanceDemo(step.state, "$850");
    expect(step.finish).toBe(true);
    expect(step.state.step).toBe("finished");
    expect(step.state.hints).toEqual({ address: "123 Main St", rooms: 4, rent: 850 });
    expect(texts(step.bubbles)[0]).toContain(FINISH_URL_TOKEN);
    expect(texts(step.bubbles)[0]).toContain("Tap to finish setup");
  });

  it("skips questions already answered before the demo", () => {
    const state: DemoState = { step: "rent", hints: { address: "9 Elm St", rooms: 3, rent: 800 }, strikes: 0 };
    expect(advanceDemo(state, "next").finish).toBe(true);
    const partial: DemoState = { step: "rent", hints: { address: "9 Elm St" }, strikes: 0 };
    expect(advanceDemo(partial, "next").state.step).toBe("ask_rooms");
  });

  it("SKIP ends the questions and finishes", () => {
    const step = advanceDemo(atQuestions(), "skip");
    expect(step.finish).toBe(true);
    expect(step.state.hints).toEqual({});
  });

  it("retries a bad answer once, then finishes", () => {
    const first = advanceDemo(atQuestions(), "somewhere nice");
    expect(first.state.step).toBe("ask_address");
    expect(texts(first.bubbles)).toEqual([DEMO_COPY.askAddressRetry]);
    expect(advanceDemo(first.state, "dunno").finish).toBe(true);
  });

  it("an address answer may carry rooms and rent too", () => {
    const step = advanceDemo(atQuestions(), "61 Willow Court, 3 bedrooms, $800");
    expect(step.finish).toBe(true);
    expect(step.state.hints).toEqual({ address: "61 Willow Court", rooms: 3, rent: 800 });
  });
});

describe("ending and restarting", () => {
  it.each(["exit", "EXIT", "quit", "end demo", "stop", "cancel"])("%s ends the demo from any step", (word) => {
    for (const step of ["applicant", "leak", "rent", "ask_address", "ask_rooms", "ask_rent"] as const) {
      const out = advanceDemo({ step, hints: {}, strikes: 0 }, word);
      expect(out.ended).toBe(true);
      expect(out.state.step).toBe("ended");
      expect(out.finish).toBe(false);
    }
  });
  it("a normal answer is not an end command", () => {
    expect(demoEndCommand("Y")).toBe(false);
    expect(demoEndCommand("123 Main St")).toBe(false);
  });
  it("DEMO text starts (or restarts) it", () => {
    for (const t of ["DEMO", "demo", " Demo. ", "Hi PropLane, show me the demo", "hey proplane show me the demo!", "try the demo"]) expect(isDemoStartText(t)).toBe(true);
    for (const t of ["I want a demo of nothing", "demolition", "is Room 3 available", ""]) expect(isDemoStartText(t)).toBe(false);
  });
  it("a reopened chat repeats the current prompt", () => {
    expect(texts(currentPrompt({ step: "leak", hints: {}, strikes: 0 })).join(" ")).toContain("Reply Y");
    expect(suggestionsFor("leak")).toEqual(["Y", "N"]);
  });
});

describe("copy rules", () => {
  const all = Object.values(DEMO_COPY).map((t) => t.replace(FINISH_URL_TOKEN, "https://proplane.ai/start/" + "x".repeat(43)));
  it("every line is one GSM-7 segment: <= 160 chars, no emoji, no curly quotes, no long dashes", () => {
    for (const line of all) {
      expect(line.length, line).toBeLessThanOrEqual(160);
      expect(line, line).toMatch(/^[\x20-\x7E]+$/);
      expect(line).not.toMatch(/[‘’“”–—]/);
    }
  });
  it("sample texts are labelled on SMS and never say work order", () => {
    const sample = startDemo().bubbles.find((b) => b.kind === "sample")!;
    expect(bubbleToSms(sample)).toMatch(/^Sample text to you: /);
    expect(all.join(" ").toLowerCase()).not.toContain("work order");
    expect(bubbleToSms(sample).length).toBeLessThanOrEqual(160);
  });
});
