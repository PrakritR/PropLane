import { describe, expect, it } from "vitest";
import { stripSmsMarkdown } from "@/lib/agent/conversation-style-rules";

describe("stripSmsMarkdown", () => {
  it("unwraps bold so a text never shows literal asterisks", () => {
    expect(stripSmsMarkdown("The front door code is **4966**.")).toBe("The front door code is 4966.");
    expect(stripSmsMarkdown("Your WiFi network is **Net-1** and the password is **pw-2**")).toBe("Your WiFi network is Net-1 and the password is pw-2");
  });

  it("drops heading marks at line starts only", () => {
    expect(stripSmsMarkdown("## Plan\nline # two")).toBe("Plan\nline # two");
  });

  it("leaves lone asterisks, underscores and addresses alone", () => {
    expect(stripSmsMarkdown("Unit 4* at 5th_Ave, 2 * 3")).toBe("Unit 4* at 5th_Ave, 2 * 3");
    expect(stripSmsMarkdown(null)).toBeNull();
  });
});
