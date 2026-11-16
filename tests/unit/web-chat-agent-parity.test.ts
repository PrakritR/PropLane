// "Behaves exactly like SMS": the web agent uses the SAME registry object and the SAME inline-write allow-list as the SMS
// leasing agent (only escalate_to_manager and request_tour), and the same leasing system prompt.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

import { WEB_CHAT_INLINE_WRITE_TOOLS, WEB_CHAT_REGISTRY } from "@/lib/agent/leasing-web-agent.server";
import { LEASING_SMS_INLINE_WRITE_TOOLS, leasingSmsAgentRegistry } from "@/lib/tools";

describe("web chat assistant parity with SMS", () => {
  it("shares the SMS registry and write allow-list; only notify-the-manager writes are reachable", () => {
    expect(WEB_CHAT_REGISTRY).toBe(leasingSmsAgentRegistry);
    expect([...WEB_CHAT_INLINE_WRITE_TOOLS].sort()).toEqual([...LEASING_SMS_INLINE_WRITE_TOOLS].sort());
    expect([...WEB_CHAT_INLINE_WRITE_TOOLS].sort()).toEqual(["escalate_to_manager", "request_tour"]);
    for (const tool of WEB_CHAT_INLINE_WRITE_TOOLS) expect(WEB_CHAT_REGISTRY.has(tool)).toBe(true);
  });

  it("runs read-only with the manager's own leasing prompt, traces per turn, and takes the home from the server row", () => {
    const source = readFileSync("src/lib/agent/leasing-web-agent.server.ts", "utf8");
    expect(source).toContain("readOnly: true");
    expect(source).toContain("leasingSmsSystemPromptForWorkNumberOwner");
    expect(source).toContain("traceAgentTurn");
    expect(source).toContain("allowWriteTools: WEB_CHAT_INLINE_WRITE_TOOLS");
  });

  it("the route never takes a workspace or owner from the request and sets an httpOnly signed cookie", () => {
    const route = readFileSync("src/app/api/public/web-chat/route.ts", "utf8");
    expect(route).toContain("httpOnly: true");
    expect(route).not.toMatch(/request\.(workspaceId|ownerUserId|landlordId)/);
    const chat = readFileSync("src/lib/web-chat/chat.server.ts", "utf8");
    expect(chat).toContain('source: "web_chat"');
    expect(chat).toContain('channel: "in_app"');
  });
});
