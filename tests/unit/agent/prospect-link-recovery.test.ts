// A prospect never receives the portal's "I can't verify that link" sentence. A link that this turn's tool results,
// an earlier reply of the conversation or the site constants vouch for passes; any other link is redone once without
// links and, failing that, answered from the tool results alone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentContext } from "@/lib/tools/context";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/agent/provider", () => ({ completeAgentModel: complete }));

import { runAgentTurn } from "@/lib/agent/loop";
import { summarizeLeasingEvidence } from "@/lib/agent/leasing-sms-fallback";
import { UNSUPPORTED_LINK } from "@/lib/agent/luna-link-guard";
import { buildRegistry, defineTool } from "@/lib/tools/registry";

const ctx = { landlordId: "manager_a", userId: "manager_a", db: {} } as unknown as AgentContext;
const model = { model: "gpt-6-luna", tier: "standard" as const, provider: "openai" as const, route: "luna_primary" as const, reasoningEffort: "low" as const };
const call = (content: Anthropic.ContentBlock[], stopReason: string) => ({
  content, stopReason, provider: "openai", latencyMs: 5, usage: { inputTokens: 20, outputTokens: 5 },
});
const listCall = call([{ type: "tool_use", id: "call_1", name: "list_live_listings", input: {} } as Anthropic.ToolUseBlock], "tool_use");
const final = (reply: string) => call([{ type: "text", text: reply } as Anthropic.TextBlock], "end_turn");

const LISTING_URL = "https://proplane.ai/rent/listings/home-1";
const BROWSE_URL = "https://proplane.ai/rent/browse";
const listTool = (handler: () => Promise<unknown> = async () => ({
  count: 1, browseUrl: BROWSE_URL, area: { resolved: true, place: "the University of Washington campus", nearCount: 1 },
  listings: [{ propertyId: "home-1", title: "5257 Brooklyn Ave NE", neighborhood: "University District", lowestRoomRent: 900, listingUrl: LISTING_URL, areaMatch: { how: "distance", distanceMiles: 0.9, near: true } }],
})) => buildRegistry([defineTool({ name: "list_live_listings", description: "List", kind: "read", inputSchema: z.object({}), handler })]);
const recovery = { allowedUrls: [BROWSE_URL], summarize: summarizeLeasingEvidence };

beforeEach(() => complete.mockReset());

describe("prospect link recovery", () => {
  it("lets a link from this turn's tool result through untouched", async () => {
    complete.mockResolvedValueOnce(listCall).mockResolvedValueOnce(final(`5257 Brooklyn is under a mile away: ${LISTING_URL}`));
    const result = await runAgentTurn({ ctx, registry: listTool(), model, linkRecovery: recovery, messages: [{ role: "user", content: "near UW?" }] });
    expect(result.reply).toBe(`5257 Brooklyn is under a mile away: ${LISTING_URL}`);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("lets a link an earlier reply already sent, or a site constant, through with no lookup at all", async () => {
    complete.mockResolvedValueOnce(final(`You can see everything here: ${BROWSE_URL}`));
    const fromConstant = await runAgentTurn({ ctx, registry: listTool(), model, linkRecovery: recovery, messages: [{ role: "user", content: "hi" }] });
    expect(fromConstant.reply).toContain(BROWSE_URL);

    complete.mockResolvedValueOnce(final("Same page again: https://proplane.ai/rent/listings/earlier"));
    const fromHistory = await runAgentTurn({
      ctx, registry: listTool(), model, linkRecovery: { summarize: summarizeLeasingEvidence },
      messages: [
        { role: "user", content: "any homes?" },
        { role: "assistant", content: "Try https://proplane.ai/rent/listings/earlier" },
        { role: "user", content: "send it again" },
      ],
    });
    expect(fromHistory.reply).toContain("/rent/listings/earlier");
  });

  it("redoes a reply with an unsupported link once, without links, and sends that", async () => {
    complete
      .mockResolvedValueOnce(listCall)
      .mockResolvedValueOnce(final("Here you go: https://evil.example/invented"))
      .mockResolvedValueOnce(final("5257 Brooklyn Ave NE is under a mile from campus, from $900 a month."));
    const result = await runAgentTurn({ ctx, registry: listTool(), model, linkRecovery: recovery, messages: [{ role: "user", content: "near UW?" }] });
    expect(result.reply).toBe("5257 Brooklyn Ave NE is under a mile from campus, from $900 a month.");
    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[2][0].tools).toEqual([]);
  });

  it("relinks: an apply link the model typed without a lookup is redone with the home's verified links", async () => {
    const APPLY = "https://proplane.ai/rent/apply?propertyId=home-1&phone=%2B12065550142";
    const relink = vi.fn(async () => ({ urls: [APPLY], context: JSON.stringify({ applyUrl: APPLY }) }));
    complete
      .mockResolvedValueOnce(final("Apply here: https://proplane.ai/rent/apply?propertyId=made-up"))
      .mockResolvedValueOnce(final(`Apply here: ${APPLY}`));
    const result = await runAgentTurn({
      ctx, registry: listTool(), model, linkRecovery: { ...recovery, relink },
      messages: [{ role: "assistant", content: `Home: ${LISTING_URL}` }, { role: "user", content: "how do I apply?" }],
    });
    expect(result.reply).toBe(`Apply here: ${APPLY}`);
    expect(relink).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[1][0].tools).toEqual([]);
    expect(JSON.stringify(complete.mock.calls[1][0].messages)).toContain("verified links");
  });

  it("relink that still carries an unverified link falls through to the no-links retry", async () => {
    const relink = vi.fn(async () => ({ urls: ["https://proplane.ai/rent/apply?propertyId=home-1"], context: "{}" }));
    complete
      .mockResolvedValueOnce(final("Apply: https://evil.example/x"))
      .mockResolvedValueOnce(final("Apply: https://evil.example/y"))
      .mockResolvedValueOnce(final("You can apply through PropLane."));
    const result = await runAgentTurn({ ctx, registry: listTool(), model, linkRecovery: { ...recovery, relink }, messages: [{ role: "user", content: "how do I apply?" }] });
    expect(result.reply).toBe("You can apply through PropLane.");
  });

  it("falls back to a summary built from the tool result when the retry still has a link, and never the canned sentence", async () => {
    complete
      .mockResolvedValueOnce(listCall)
      .mockResolvedValueOnce(final("Here you go: https://evil.example/invented"))
      .mockResolvedValueOnce(final("Still: https://evil.example/again"));
    const result = await runAgentTurn({ ctx, registry: listTool(), model, linkRecovery: recovery, messages: [{ role: "user", content: "near UW?" }] });
    expect(result.reply).toContain("5257 Brooklyn Ave NE");
    expect(result.reply).toContain(LISTING_URL);
    expect(result.reply).not.toContain("evil.example");
    expect(result.reply).not.toBe(UNSUPPORTED_LINK);
    expect(result.reply).not.toMatch(/can't verify/i);
  });

  it("falls back to the summary when the retry call itself fails", async () => {
    complete
      .mockResolvedValueOnce(listCall)
      .mockResolvedValueOnce(final("Here you go: https://evil.example/invented"))
      .mockRejectedValueOnce(new Error("provider down"));
    const result = await runAgentTurn({ ctx, registry: listTool(), model, linkRecovery: recovery, messages: [{ role: "user", content: "near UW?" }] });
    expect(result.reply).toContain(LISTING_URL);
  });

  it("answers an empty model reply from the tool results", async () => {
    complete.mockResolvedValueOnce(listCall).mockResolvedValueOnce(final(""));
    const result = await runAgentTurn({ ctx, registry: listTool(), model, linkRecovery: recovery, messages: [{ role: "user", content: "near UW?" }] });
    expect(result.reply).toContain(LISTING_URL);
  });

  it("replaces the reply with the team follow-up line when the catalog read failed (never another workspace's answer)", async () => {
    complete.mockResolvedValueOnce(listCall).mockResolvedValueOnce(final("We have a great 4 bedroom in Ballard for $2000."));
    const registry = listTool(async () => { throw new Error("catalog down"); });
    const result = await runAgentTurn({
      ctx, registry, model, messages: [{ role: "user", content: "near UW?" }],
      linkRecovery: { ...recovery, replaceWhen: (trace) => trace.some((entry) => entry.tool === "list_live_listings" && !entry.ok) },
    });
    expect(result.reply).toMatch(/teammate will follow up/);
    expect(result.reply).not.toContain("Ballard");
  });

  it("still gives a portal surface the Luna guard (the canned sentence stays a portal answer)", async () => {
    complete.mockResolvedValueOnce(listCall).mockResolvedValueOnce(final("Open https://evil.example/invented"));
    const result = await runAgentTurn({ ctx, registry: listTool(), model, messages: [{ role: "user", content: "near UW?" }] });
    expect(result.reply).toBe(UNSUPPORTED_LINK);
  });
});
