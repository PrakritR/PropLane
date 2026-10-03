import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S8 (comms-safety-0929): an inbound vendor text was matched to the vendor's
 * newest job under the owner, whichever workspace that job belongs to. The
 * match is now narrowed to the workspace of the work line the text arrived on.
 */
vi.mock("server-only", () => ({}));

import { resolveVendorAgentSessionForInbound } from "@/lib/agent/vendor-agent.server";

const PHONE = "+12065550142";
const session = (id: string, workOrder: string, updated: string) => ({
  id, landlord_id: "owner-1", kind: "vendor_work_order", vendor_user_id: "v1", vendor_directory_id: "d1",
  work_order_id: workOrder, vendor_phone_e164: PHONE, status: "active", inbox_thread_id: null, updated_at: updated,
});

const seed = () =>
  createMemoryDb({
    agent_sessions: [
      // Newest is the workspace-A job.
      session("s-a", "wo-a", "2026-09-29T12:00:00Z"),
      session("s-b", "wo-b", "2026-09-29T10:00:00Z"),
    ],
    portal_work_order_records: [
      { id: "wo-a", manager_user_id: "owner-1", property_id: "hA", row_data: { id: "wo-a", propertyId: "hA" } },
      { id: "wo-b", manager_user_id: "owner-1", property_id: "hB", row_data: { id: "wo-b", propertyId: "hB" } },
    ],
    manager_property_records: [
      { id: "hA", manager_user_id: "owner-1", workspace_id: "ws-a" },
      { id: "hB", manager_user_id: "owner-1", workspace_id: "ws-b" },
    ],
  });

describe("resolveVendorAgentSessionForInbound workspace scope (S8)", () => {
  it("a reply on workspace B's line attaches to B's job, not the newer A job", async () => {
    const res = await resolveVendorAgentSessionForInbound(seed() as never, PHONE, "On my way", "owner-1", "ws-b");
    expect(res).toMatchObject({ kind: "session", session: { id: "s-b" } });
  });

  it("a reply on workspace A's line attaches to A's", async () => {
    const res = await resolveVendorAgentSessionForInbound(seed() as never, PHONE, "On my way", "owner-1", "ws-a");
    expect(res).toMatchObject({ kind: "session", session: { id: "s-a" } });
  });

  it("a workspace with no job for this vendor is an unknown phone, not another workspace's job", async () => {
    const db = seed();
    const res = await resolveVendorAgentSessionForInbound(db as never, PHONE, "hello", "owner-1", "ws-c");
    expect(res).toEqual({ kind: "unknown_phone" });
  });

  it("without a workspace the owner-wide behavior is unchanged", async () => {
    const res = await resolveVendorAgentSessionForInbound(seed() as never, PHONE, "hello", "owner-1");
    expect(res).toMatchObject({ kind: "session", session: { id: "s-a" } });
  });
});
