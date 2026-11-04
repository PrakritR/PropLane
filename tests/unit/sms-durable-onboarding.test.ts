import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn() }));
vi.mock("@/lib/one-number/onboarding/turn-replay.server", () => ({ claimTurn: mocks.claim, completeTurn: mocks.complete, releaseTurn: vi.fn() }));
import { handleUnknownSenderInbound } from "@/lib/one-number/onboarding/unknown-sender.server";
import { runWithDurableSmsIngress } from "@/lib/sms/durable-ingress-context.server";
const inbound = { fromPhone: "+12065550100", phoneKey: "12065550100", body: "hello", messageSid: `SM${"1".repeat(32)}`, mediaCount: 0 };

describe("durable onboarding branch guards", () => {
 it.each(["unavailable", "inflight"])("holds %s branch state for review without running another turn", async kind => {
  mocks.claim.mockResolvedValue({ kind });
  await expect(runWithDurableSmsIngress({ current: { stage: "effect" }, save: async () => undefined }, () => handleUnknownSenderInbound({} as never, inbound)))
   .rejects.toThrow("not available for execution");
  expect(mocks.complete).not.toHaveBeenCalled();
 });
 it("reuses a recorded turn without regenerating it", async () => {
  const turn = { reply: "Exact prepared reply", leadId: null, assignedWorkspaceId: null };
  mocks.claim.mockResolvedValue({ kind: "replay", turn });
  await expect(runWithDurableSmsIngress({ current: { stage: "effect" }, save: async () => undefined }, () => handleUnknownSenderInbound({} as never, inbound))).resolves.toEqual(turn);
  expect(mocks.complete).not.toHaveBeenCalled();
 });
});
