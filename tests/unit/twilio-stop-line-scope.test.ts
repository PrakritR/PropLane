import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S12 (STOP): a vendor texting STOP to workspace B's number unbound their jobs
 * for every workspace. The unbind now covers the line they texted only.
 */
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock("twilio", () => ({ default: { validateRequest: () => true } }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "",
  fetchTwilioMessageCreatedAt: async () => "2026-09-29T12:00:00.000Z",
}));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({
  resolveOwnedWorkNumber: async () => ({ managerId: "owner-1", workspaceId: "ws-b", messagingServiceSid: "MG" }),
}));
vi.mock("@/lib/comms-billing/record-usage.server", () => ({ recordManagerCommsUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));

import { POST } from "@/app/api/webhooks/twilio/sms/route";

const PHONE = "+12065550142";
const session = (id: string, workOrder: string) => ({
  id, landlord_id: "owner-1", kind: "vendor_work_order", vendor_user_id: "v1", work_order_id: workOrder, vendor_phone_e164: PHONE, status: "active",
});

function seed() {
  const mem = createMemoryDb({
    agent_sessions: [session("s-a", "wo-a"), session("s-b", "wo-b")],
    portal_work_order_records: [
      { id: "wo-a", property_id: "hA", row_data: {} },
      { id: "wo-b", property_id: "hB", row_data: {} },
    ],
    manager_property_records: [
      { id: "hA", workspace_id: "ws-a" },
      { id: "hB", workspace_id: "ws-b" },
    ],
    sms_consent: [{ phone: "2065550142", opted_out_at: "2026-09-29T12:00:00.000Z", opted_in_at: null }],
    profiles: [{ id: "v1" }],
  });
  return Object.assign(mem, { rpc: async () => ({ data: true, error: null }) });
}

beforeEach(() => {
  state.db = seed();
});

const stop = () =>
  POST(
    new Request("https://example.test/api/webhooks/twilio/sms", {
      method: "POST",
      body: new URLSearchParams({ From: PHONE, To: "+14255550002", Body: "STOP", MessageSid: "SM123" }).toString(),
    }),
  );

describe("Twilio STOP is scoped to the line it was sent to", () => {
  it("unbinds only the workspace-B job when STOP arrives on workspace B's number", async () => {
    const res = await stop();
    expect(res.status).toBe(200);
    const sessions = (state.db as { __tables: Record<string, Record<string, unknown>[]> }).__tables.agent_sessions;
    expect(sessions.find((s) => s.id === "s-b")?.vendor_phone_e164).toBeNull();
    expect(sessions.find((s) => s.id === "s-a")?.vendor_phone_e164).toBe(PHONE);
  });
});
