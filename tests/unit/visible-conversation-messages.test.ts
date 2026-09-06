// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  completedAssistantTurnMessages,
  visibleConversationMessages,
} from "@/lib/axis-assistant/use-assistant-conversation";

describe("visible conversation messages", () => {
  it("hides empty assistant bubbles and keeps user text", () => {
    expect(
      visibleConversationMessages([
        { role: "user", content: "Add a $50 expense" },
        { role: "assistant", content: "   " },
        { role: "assistant", content: "Recorded." },
      ]),
    ).toEqual([
      { role: "user", content: "Add a $50 expense" },
      { role: "assistant", content: "Recorded." },
    ]);
  });

  it("omits an empty completed reply so write proposals do not leave a blank bubble", () => {
    const prior = [{ role: "user" as const, content: "Add an expense" }];
    expect(completedAssistantTurnMessages(prior, "")).toEqual(prior);
    expect(completedAssistantTurnMessages(prior, "   ")).toEqual(prior);
    expect(completedAssistantTurnMessages(prior, "Done.", "trace-1")).toEqual([
      ...prior,
      { role: "assistant", content: "Done.", traceId: "trace-1" },
    ]);
  });
});
