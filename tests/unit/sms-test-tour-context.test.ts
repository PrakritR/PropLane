import { describe, expect, it, vi } from "vitest";

import { persistProspectTourSchedulingContext } from "@/lib/prospect-tour-scheduling-context.server";
import { buildProspectConversationKey } from "@/lib/sms-conversation-identity";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

function emptyStateQuery() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  return chain;
}

describe("authenticated SMS test durable tour context", () => {
  it("uses the isolated test session for both runner and tool conversation identity", () => {
    expect(buildProspectConversationKey({
      ownerManagerUserId: MANAGER,
      testSessionId: SESSION,
      counterpartyPhone: "",
    })).toBe(`${MANAGER}:prospect:${SESSION}`);

    expect(buildProspectConversationKey({
      ownerManagerUserId: MANAGER,
      counterpartyPhone: "4155551212",
    })).toBe(`${MANAGER}:prospect:+14155551212`);
  });

  it("merges test context through the actor-and-session-fenced RPC without a phone", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, stateId: "state-1" }, error: null }));
    const db = { rpc, from: vi.fn(() => emptyStateQuery()) };

    await persistProspectTourSchedulingContext(db as never, {
      managerUserId: MANAGER,
      conversationKey: `${MANAGER}:prospect:${SESSION}`,
      testActorUserId: ACTOR,
      testSessionId: SESSION,
      trustedInboundText: "My name is Alex and Tuesday afternoon works",
      burst: { id: "burst-1", revision: 4, workerId: "worker-1" },
      evidence: [{
        tool: "list_open_tour_slots",
        input: { propertyId: "property-1", fromDate: "2026-09-22", localStartMinute: 720 },
        output: { publishedOnly: true, resolution: "resolved" },
      }],
    });

    expect(rpc).toHaveBeenCalledWith("merge_authenticated_sms_test_tour_context", expect.objectContaining({
      p_manager_user_id: MANAGER,
      p_conversation_key: `${MANAGER}:prospect:${SESSION}`,
      p_test_actor_user_id: ACTOR,
      p_test_session_id: SESSION,
      p_property_id: "property-1",
      p_contact_name: "Alex",
      p_constraints: expect.objectContaining({ fromDate: "2026-09-22", localStartMinute: 720 }),
      p_burst_id: "burst-1",
      p_burst_revision: 4,
      p_worker_id: "worker-1",
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_trusted_phone_e164");
  });

  it("keeps live persistence on the phone-bound RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, stateId: "state-live" }, error: null }));
    const db = { rpc, from: vi.fn(() => emptyStateQuery()) };

    await persistProspectTourSchedulingContext(db as never, {
      managerUserId: MANAGER,
      conversationKey: `${MANAGER}:prospect:+14155551212`,
      trustedPhoneE164: "+14155551212",
      burst: { id: "burst-live", revision: 2, workerId: "worker-live" },
      evidence: [{
        tool: "get_listing_details",
        input: { propertyId: "property-live" },
        output: { found: true, listing: { propertyId: "property-live" } },
      }],
    });

    expect(rpc).toHaveBeenCalledWith("merge_prospect_sms_tour_context", expect.objectContaining({
      p_trusted_phone_e164: "+14155551212",
      p_property_id: "property-live",
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_test_actor_user_id");
  });

  it.each([
    ["authenticated test", { testActorUserId: ACTOR, testSessionId: SESSION }],
    ["live phone", { trustedPhoneE164: "+14155551212" }],
  ])("does not invalidate an exact offer prepared later in the same %s turn", async (_label, identity) => {
    const rpc = vi.fn(async () => ({ data: { ok: true, stateId: "state-offered" }, error: null }));
    const db = { rpc, from: vi.fn(() => emptyStateQuery()) };

    await persistProspectTourSchedulingContext(db as never, {
      managerUserId: MANAGER,
      conversationKey: `${MANAGER}:prospect:${SESSION}`,
      ...identity,
      burst: { id: "burst-offer", revision: 5, workerId: "worker-offer" },
      evidence: [
        {
          tool: "list_open_tour_slots",
          input: { propertyId: "property-1", fromDate: "2026-09-22", localStartMinute: 720 },
          output: { publishedOnly: true, resolution: "resolved" },
        },
        {
          tool: "prepare_prospect_tour_confirmation",
          input: {
            propertyId: "property-1",
            slotKey: "2026-09-22:24",
            start: "2026-09-22T19:00:00.000Z",
            end: "2026-09-22T19:30:00.000Z",
            name: "Alex",
          },
          output: { reply: "Reply YES", preparedOffer: { slotKey: "2026-09-22:24" } },
        },
      ],
    });

    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_property_id: "property-1",
      p_contact_name: "Alex",
      p_constraints: null,
    });
  });
});
