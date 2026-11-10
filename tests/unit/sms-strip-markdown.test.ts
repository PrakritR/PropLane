import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("stripSmsMarkdown at the reply choke points", () => {
  it("unwraps bold, keeps a URL and a bullet list intact", () => {
    const reply = "**4709A** has 1 of 10 rooms open:\n- Room 1\n- Room 2\nSee https://proplane.ai/rent/listings/4709a-8th-ave-ne?src=sms_1&a=b_c";
    expect(stripSmsMarkdown(reply)).toBe(
      "4709A has 1 of 10 rooms open:\n- Room 1\n- Room 2\nSee https://proplane.ai/rent/listings/4709a-8th-ave-ne?src=sms_1&a=b_c",
    );
  });

  it("runs before toGsm7 on the leasing delivery and on every agent-turn reply", () => {
    const leasing = readFileSync(join(process.cwd(), "src/lib/agent/leasing-sms-agent.server.ts"), "utf8");
    expect(leasing).toMatch(/toGsm7\(stripSmsMarkdown\(/);
    const turn = readFileSync(join(process.cwd(), "src/lib/agent/sms-agent-turn.server.ts"), "utf8");
    expect(turn).toContain("stripSmsMarkdown(stripLongDashes(turn.reply))");
  });
});
