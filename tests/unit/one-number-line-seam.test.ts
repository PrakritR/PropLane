import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: vi.fn(async () => ({ ok: true as const, messageSid: "SMout", segments: 1 })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));
const unassigned = vi.hoisted(() =>
  vi.fn(async () => ({ leadId: "lead-1" as string | null, reply: "Welcome! Here are homes: 12 Alder St." as string | null, assignedWorkspaceId: null as string | null })),
);
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: unassigned }));
vi.mock("@/lib/room-availability-range.server", () => ({
  roomAvailabilityForRange: vi.fn(async () => ({ ok: true, rooms: [{ roomLabel: "Room 1", available: true }, { roomLabel: "Room 2", available: false }] })),
}));
vi.mock("@/lib/one-number/display-number.server", () => ({ resolveWorkspaceDisplayNumber: vi.fn(async () => null) }));

import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const PHONE = "+12065550142";
const KEY = "2065550142";
const config: SharedLineConfig = { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] };

const run = (db: FakeDb, body: string) =>
  handleSharedLineInbound(db as never, { config, fromPhone: PHONE, body, messageSid: "SM1", mediaCount: 0, phoneKey: KEY });

function world(extra: Record<string, Row[]> = {}): FakeDb {
  return createFakeDb({
    profiles: [{ id: "user-u", email: "u@x.com", phone: PHONE, phone_verified_at: VERIFIED }],
    portal_workspaces: [{ id: "ws-a", name: "Brooklyn Homes", owner_user_id: "owner-a", is_default: true, is_service: false }],
    manager_property_records: [{ id: "prop-a1", manager_user_id: "owner-a", workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" }, property_data: {} }],
    ...extra,
  });
}

const residentOfA: Record<string, Row[]> = {
  manager_application_records: [{ id: "app", manager_user_id: "owner-a", resident_email: "u@x.com", property_id: "prop-a1", row_data: { bucket: "approved" } }],
};

beforeEach(() => unassigned.mockClear());

describe("shared line: a resident's intent is decided per text", () => {
  it("is routed to their workspace for rent or repairs, as before", async () => {
    const result = await run(world(residentOfA), "when is my rent due");
    expect(result).toEqual({ kind: "continue", owned: { managerId: "owner-a", workspaceId: "ws-a", messagingServiceSid: "MGshared" } });
    expect(unassigned).not.toHaveBeenCalled();
  });

  it("looking for a house is answered from the PropLane catalog by the lead agent, not the resident agent", async () => {
    const result = await run(world(residentOfA), "hey is there any house available");
    expect(unassigned).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "handled", twiml: "Welcome! Here are homes: 12 Alder St." });
  });

  it("a stranger asking the same thing is unchanged: the lead agent answers", async () => {
    const result = await run(world(), "hey is there any house available");
    expect(unassigned).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "handled" });
  });

  it("a resident who is also a team member is not forced into the catalog by a vacancy question", async () => {
    const asTeam = world({
      ...residentOfA,
      account_link_invites: [{ id: "i1", inviter_user_id: "owner-a", invitee_user_id: "user-u", workspace_id: "ws-a", status: "accepted", team_role: "property_manager", assigned_property_ids: ["prop-a1"] }],
    });
    const result = await run(asTeam, "any rooms available?");
    // Two real ties in one workspace: the router's own question, not a housing search.
    expect(unassigned).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "handled", twiml: null });
  });
});

describe("shared line: the owner of record of a PropLane Service workspace", () => {
  const client = (): FakeDb =>
    createFakeDb({
      profiles: [{ id: "user-u", email: "u@x.com", phone: PHONE, phone_verified_at: VERIFIED }],
      portal_workspaces: [{ id: "ws-svc", name: "Ambika Homes", owner_user_id: "owner-svc", is_default: false, is_service: true }],
      account_link_invites: [{ id: "i1", inviter_user_id: "owner-svc", invitee_user_id: "user-u", workspace_id: "ws-svc", status: "accepted", team_role: "property_owner", is_owner_of_record: true }],
      manager_property_records: [{ id: "p1", manager_user_id: "owner-svc", workspace_id: "ws-svc", row_data: { buildingName: "12 Alder St" }, property_data: {} }],
      portal_household_charge_records: [],
      portal_work_order_records: [],
      portal_service_request_records: [],
      portal_lease_pipeline_records: [],
      portal_schedule_records: [],
    });

  it("gets read-only status instead of being treated as a stranger", async () => {
    const result = await run(client(), "how are my houses doing");
    expect(result).toMatchObject({ kind: "handled" });
    expect(result.kind === "handled" && result.twiml).toContain("Ambika Homes, October: 1 house, 1 of 2 rooms occupied.");
    expect(unassigned).not.toHaveBeenCalled();
  });

  it("is declined, view only, when asking to change something", async () => {
    const result = await run(client(), "text my residents that water is off");
    expect(result.kind === "handled" && result.twiml).toContain("Your account is view only");
  });

  it("a housing search from them is the lead agent's, like anyone else's", async () => {
    const result = await run(client(), "I'm looking for a room for my cousin");
    expect(unassigned).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "handled", twiml: "Welcome! Here are homes: 12 Alder St." });
  });
});
