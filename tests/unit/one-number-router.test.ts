import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineCandidate, SharedLineInbound, SharedLineSession } from "@/lib/one-number/contracts";
import { fakeSharedLineDb, type FakeRow } from "../helpers/shared-line-fake-db";

const handleUnassigned = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ leadId: "lead-1" as string | null, reply: "Hi! What is your budget?" as string | null, assignedWorkspaceId: null as string | null })),
);
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: handleUnassigned }));

import {
  buildDisambiguationQuestion,
  decideFromCandidates,
  dedupeCandidates,
  resolvePendingAnswer,
  routeSharedLineInbound,
  routeSharedLineInboundWithReply,
  textNamesCandidate,
} from "@/lib/one-number/router.server";
import {
  findApplicantCandidates,
  findEntryCodeCandidate,
  findResidentCandidates,
  findReturningProspectCandidates,
  findTeamMemberCandidates,
  findVendorJobCandidates,
} from "@/lib/one-number/router-lookups.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const PHONE = "+12065550142";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

function world(extra: Record<string, FakeRow[]> = {}) {
  return fakeSharedLineDb({
    portal_workspaces: [
      { id: "ws-a", name: "Brooklyn Homes", owner_user_id: OWNER_A, is_default: true },
      { id: "ws-b", name: "Eighth Ave Co", owner_user_id: OWNER_B, is_default: true },
    ],
    manager_property_records: [
      { id: "prop-a1", manager_user_id: OWNER_A, workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" } },
      { id: "prop-b1", manager_user_id: OWNER_B, workspace_id: "ws-b", row_data: { address: "4709A 8th Ave, Seattle, WA 98108" } },
    ],
    profiles: [
      { id: "user-u", email: "u@x.com", phone: PHONE, phone_verified_at: VERIFIED },
      { id: OWNER_A, email: "a@x.com", phone: "+12065550100", phone_verified_at: VERIFIED },
      { id: "user-t", email: "t@x.com", phone: "+12065550200", phone_verified_at: VERIFIED },
    ],
    ...extra,
  });
}

/** user-u is a resident in A (5259 Brooklyn) and a vendor with an open job in B (4709A 8th Ave). */
const RESIDENT_IN_A: Record<string, FakeRow[]> = {
  manager_application_records: [
    { id: "app-1", manager_user_id: OWNER_A, resident_email: "u@x.com", property_id: "prop-a1", row_data: { bucket: "approved" } },
  ],
};
const VENDOR_IN_B: Record<string, FakeRow[]> = {
  agent_sessions: [
    { id: "s1", kind: "vendor_work_order", vendor_phone_e164: PHONE, landlord_id: OWNER_B, work_order_id: "wo-1", status: "active" },
  ],
  portal_work_order_records: [{ id: "wo-1", property_id: "prop-b1", row_data: {} }],
};

function inbound(body: string, over: Partial<SharedLineInbound> = {}): SharedLineInbound {
  return { fromPhone: PHONE, phoneKey: "2065550142", body, messageSid: "SM1", mediaCount: 0, ...over };
}

const session = (over: Partial<SharedLineSession> = {}): SharedLineSession => ({
  phoneKey: "2065550142", currentWorkspaceId: null, activeRole: null, aiPaused: false, pausedAt: null,
  pendingCandidates: null, updatedAt: "2026-10-18T00:00:00.000Z", ...over,
});

beforeEach(() => handleUnassigned.mockClear());

describe("lookups, one per routing step", () => {
  it("step 1: the owner and an accepted teammate of a workspace are team members; a property-owner link is not", async () => {
    const { db } = world({
      account_link_invites: [
        { inviter_user_id: OWNER_A, invitee_user_id: "user-t", status: "accepted", workspace_id: "ws-a", team_role: "property_manager" },
        { inviter_user_id: OWNER_B, invitee_user_id: "user-t", status: "accepted", workspace_id: "ws-b", team_role: "property_owner" },
        { inviter_user_id: OWNER_B, invitee_user_id: "user-t", status: "pending", workspace_id: "ws-b", team_role: "property_manager" },
      ],
    });
    const owner = await findTeamMemberCandidates(db, "+12065550100");
    expect(owner).toMatchObject([{ workspaceId: "ws-a", ownerUserId: OWNER_A, role: "manager", reason: "team_member", label: "Brooklyn Homes" }]);
    const mate = await findTeamMemberCandidates(db, "(206) 555-0200");
    expect(mate.map((c) => c.workspaceId)).toEqual(["ws-a"]);
  });

  it("step 1: an unverified phone is nobody, and two accounts claiming one phone fail closed", async () => {
    const { db } = world({
      profiles: [
        { id: "x", email: "x@x.com", phone: "+12065550300", phone_verified_at: null },
        { id: "p1", email: "p1@x.com", phone: "+12065550400", phone_verified_at: VERIFIED },
        { id: "p2", email: "p2@x.com", phone: "+12065550400", phone_verified_at: VERIFIED },
      ],
      portal_workspaces: [
        { id: "ws-x", name: "X", owner_user_id: "x", is_default: true },
        { id: "ws-p1", name: "P1", owner_user_id: "p1", is_default: true },
      ],
    });
    expect(await findTeamMemberCandidates(db, "+12065550300")).toEqual([]);
    expect(await findTeamMemberCandidates(db, "+12065550400")).toEqual([]);
  });

  it("step 2: an approved residency names its house's workspace; a pending application does not make a resident", async () => {
    const { db } = world(RESIDENT_IN_A);
    expect(await findResidentCandidates(db, PHONE)).toMatchObject([
      { workspaceId: "ws-a", ownerUserId: OWNER_A, role: "resident", reason: "resident", propertyId: "prop-a1", label: "5259 Brooklyn" },
    ]);
    const pending = world({
      manager_application_records: [
        { id: "app-2", manager_user_id: OWNER_A, resident_email: "u@x.com", property_id: "prop-a1", row_data: { bucket: "pending" } },
      ],
    });
    expect(await findResidentCandidates(pending.db, PHONE)).toEqual([]);
    expect((await findApplicantCandidates(pending.db, PHONE)).map((c) => c.workspaceId)).toEqual(["ws-a"]);
  });

  it("step 2: a withdrawn or rejected application is neither resident nor applicant", async () => {
    const { db } = world({
      manager_application_records: [
        { id: "a", manager_user_id: OWNER_A, resident_email: "u@x.com", property_id: "prop-a1", row_data: { bucket: "approved", withdrawnAt: "2026-10-02" } },
        { id: "b", manager_user_id: OWNER_A, resident_email: "u@x.com", property_id: "prop-a1", row_data: { bucket: "rejected" } },
      ],
    });
    expect(await findResidentCandidates(db, PHONE)).toEqual([]);
    expect(await findApplicantCandidates(db, PHONE)).toEqual([]);
  });

  it("step 3: an open job for the phone names the job's workspace; a closed one does not", async () => {
    const { db } = world(VENDOR_IN_B);
    expect(await findVendorJobCandidates(db, "(206) 555-0142")).toMatchObject([
      {
        workspaceId: "ws-b", ownerUserId: OWNER_B, role: "vendor", reason: "vendor_job", propertyId: "prop-b1",
        // The house still matches a text that names it; the area is what a vendor is TOLD, and the workspace's own
        // name rides along as the fallback for a house whose address names no city.
        label: "4709A 8th Ave, Seattle, WA 98108", generalArea: "Seattle", workspaceName: "Eighth Ave Co",
      },
    ]);
    const closed = world({ agent_sessions: [{ ...VENDOR_IN_B.agent_sessions[0], status: "closed" }], ...{ portal_work_order_records: VENDOR_IN_B.portal_work_order_records } });
    expect(await findVendorJobCandidates(closed.db, PHONE)).toEqual([]);
  });

  // Review fix, Oct 20: `row_data->>phone` is whatever the applicant TYPED. Matching it alone let anyone file an
  // application naming someone else's number and attach a candidate workspace to that person's texts - and the
  // disambiguation question is sent from, and billed to, the first candidate's workspace. So an applicant candidate
  // now needs the same verified phone the resident, team and member lookups require.
  it("step 4: an open application of this phone's VERIFIED account is an applicant", async () => {
    const mine = world({
      manager_application_records: [
        { id: "a", manager_user_id: OWNER_B, resident_email: "u@x.com", property_id: "prop-b1", row_data: { bucket: "pending", phone: PHONE } },
      ],
    });
    expect(await findApplicantCandidates(mine.db, PHONE)).toMatchObject([
      { workspaceId: "ws-b", role: "applicant", reason: "applicant", label: "4709A 8th Ave, Seattle, WA 98108" },
    ]);
    // The row's own email is enough even when `resident_email` was never written.
    const inRowData = world({
      manager_application_records: [
        { id: "a", manager_user_id: OWNER_B, property_id: "prop-b1", row_data: { bucket: "pending", phone: PHONE, email: "U@X.com" } },
      ],
    });
    expect((await findApplicantCandidates(inRowData.db, PHONE)).map((c) => c.workspaceId)).toEqual(["ws-b"]);
  });

  it("step 4: an application that merely TYPED this number is not an applicant candidate", async () => {
    // A phone with no verified PropLane account at all.
    const stranger = world({
      manager_application_records: [
        { id: "a", manager_user_id: OWNER_B, property_id: "prop-b1", row_data: { bucket: "pending", phone: "+12065559999" } },
      ],
    });
    expect(await findApplicantCandidates(stranger.db, "+12065559999")).toEqual([]);
    // And the attack: someone else's application naming a verified account's number, under neither its email.
    const spoofed = world({
      manager_application_records: [
        { id: "a", manager_user_id: OWNER_B, resident_email: "attacker@x.com", property_id: "prop-b1", row_data: { bucket: "pending", phone: PHONE, email: "attacker@x.com" } },
      ],
    });
    expect(await findApplicantCandidates(spoofed.db, PHONE)).toEqual([]);
  });

  it("step 5: a prospect conversation with a workspace is a returning prospect; a pre-stamp contact uses the owner's default workspace", async () => {
    const stamped = world({ manager_sms_contacts: [{ manager_user_id: OWNER_A, workspace_id: "ws-b", phone_e164: PHONE, counterparty_role: "prospect" }] });
    // The stamp wins over the owner's default workspace.
    expect((await findReturningProspectCandidates(stamped.db, PHONE)).map((c) => c.workspaceId)).toEqual(["ws-b"]);
    const legacy = world({ manager_sms_contacts: [{ manager_user_id: OWNER_A, phone_e164: PHONE, counterparty_role: "prospect" }] });
    expect((await findReturningProspectCandidates(legacy.db, PHONE)).map((c) => c.workspaceId)).toEqual(["ws-a"]);
    const resident = world({ manager_sms_contacts: [{ manager_user_id: OWNER_A, phone_e164: PHONE, counterparty_role: "resident" }] });
    expect(await findReturningProspectCandidates(resident.db, PHONE)).toEqual([]);
  });

  it("step 6: an active entry code is matched as a whole token, case-insensitively", async () => {
    const codes = {
      sms_entry_codes: [
        { code: "BROOKLYN5", workspace_id: "ws-a", owner_user_id: OWNER_A, property_id: "prop-a1", label: "5259 Brooklyn", active: true },
        { code: "OLDCODE", workspace_id: "ws-a", owner_user_id: OWNER_A, property_id: "prop-a1", label: null, active: false },
        { code: "CEDAR3", workspace_id: "ws-b", owner_user_id: OWNER_A, property_id: "prop-b1", label: null, active: true },
      ],
    };
    const { db } = world(codes);
    expect(await findEntryCodeCandidate(db, "hi, brooklyn5 please")).toMatchObject({
      workspaceId: "ws-a", ownerUserId: OWNER_A, role: "prospect", reason: "entry_code", propertyId: "prop-a1", label: "5259 Brooklyn",
    });
    expect(await findEntryCodeCandidate(db, "Text BROOKLYN5.")).not.toBeNull();
    expect(await findEntryCodeCandidate(db, "xBROOKLYN5y")).toBeNull();
    expect(await findEntryCodeCandidate(db, "BROOKLYN")).toBeNull();
    expect(await findEntryCodeCandidate(db, "oldcode")).toBeNull();
    // A code whose owner is not the workspace's real owner is corrupt and never routes.
    expect(await findEntryCodeCandidate(db, "CEDAR3")).toBeNull();
    expect(await findEntryCodeCandidate(db, "")).toBeNull();
  });

  it("every lookup reads as empty before its migration (42P01)", async () => {
    const { db } = fakeSharedLineDb({}, { broken: ["profiles", "portal_workspaces", "agent_sessions", "manager_sms_contacts", "sms_entry_codes", "manager_application_records"] });
    expect(await findTeamMemberCandidates(db, PHONE)).toEqual([]);
    expect(await findResidentCandidates(db, PHONE)).toEqual([]);
    expect(await findVendorJobCandidates(db, PHONE)).toEqual([]);
    expect(await findApplicantCandidates(db, PHONE)).toEqual([]);
    expect(await findReturningProspectCandidates(db, PHONE)).toEqual([]);
    expect(await findEntryCodeCandidate(db, "BROOKLYN5")).toBeNull();
  });
});

describe("routeSharedLineInbound: order and single matches", () => {
  it("routes a team member as manager of their workspace", async () => {
    const { db } = world();
    const decision = await routeSharedLineInbound(db, inbound("who is touring tomorrow?", { fromPhone: "+12065550100", phoneKey: "2065550100" }), null);
    expect(decision).toMatchObject({ kind: "routed", workspaceId: "ws-a", ownerUserId: OWNER_A, role: "manager", reason: "team_member" });
  });

  it("routes a lone resident, remembers it on the session, and asks nothing", async () => {
    const { db, rows } = world(RESIDENT_IN_A);
    const decision = await routeSharedLineInbound(db, inbound("the sink is dripping"), null);
    expect(decision).toMatchObject({ kind: "routed", workspaceId: "ws-a", role: "resident", reason: "resident" });
    expect(rows.sms_line_sessions).toMatchObject([{ phone_key: "2065550142", current_workspace_id: "ws-a", active_role: "resident", pending_candidates: null }]);
  });

  it("an applicant and a returning prospect in one workspace are one tenant-journey candidate (applicant wins)", async () => {
    const { db } = world({
      manager_application_records: [{ id: "a", manager_user_id: OWNER_A, resident_email: "u@x.com", property_id: "prop-a1", row_data: { bucket: "pending" } }],
      manager_sms_contacts: [{ manager_user_id: OWNER_A, workspace_id: "ws-a", phone_e164: PHONE, counterparty_role: "prospect" }],
    });
    expect(await routeSharedLineInbound(db, inbound("any update?"), null)).toMatchObject({ kind: "routed", workspaceId: "ws-a", reason: "applicant" });
  });

  it("a stranger with an entry code routes there as a prospect", async () => {
    const { db } = world({
      sms_entry_codes: [{ code: "BROOKLYN5", workspace_id: "ws-a", owner_user_id: OWNER_A, property_id: "prop-a1", label: null, active: true }],
    });
    const decision = await routeSharedLineInbound(db, inbound("BROOKLYN5", { fromPhone: "+12065550999", phoneKey: "2065550999" }), null);
    expect(decision).toMatchObject({ kind: "routed", workspaceId: "ws-a", role: "prospect", reason: "entry_code", propertyId: "prop-a1" });
    expect(handleUnassigned).not.toHaveBeenCalled();
  });

  it("a returning prospect who texts ANOTHER team's flyer code moves to that team; any stronger tie keeps the order", async () => {
    const codes = {
      sms_entry_codes: [{ code: "CEDAR3", workspace_id: "ws-b", owner_user_id: OWNER_B, property_id: "prop-b1", label: null, active: true }],
    };
    const prospect = world({ ...codes, manager_sms_contacts: [{ manager_user_id: OWNER_A, workspace_id: "ws-a", phone_e164: PHONE, counterparty_role: "prospect" }] });
    expect(await routeSharedLineInbound(prospect.db, inbound("CEDAR3 is it open?"), null)).toMatchObject({ kind: "routed", workspaceId: "ws-b", reason: "entry_code" });
    const resident = world({ ...codes, ...RESIDENT_IN_A });
    expect(await routeSharedLineInbound(resident.db, inbound("CEDAR3 is it open?"), null)).toMatchObject({ kind: "routed", workspaceId: "ws-a", reason: "resident" });
  });

  it("a stranger with no code goes to the Unassigned leads queue and its reply comes back", async () => {
    const { db, rows } = world();
    const result = await routeSharedLineInboundWithReply(db, inbound("do you have rooms?", { fromPhone: "+12065550999", phoneKey: "2065550999" }), null);
    expect(result.decision).toEqual({ kind: "unassigned", role: "prospect", leadId: "lead-1" });
    expect(result.unassignedReply).toBe("Hi! What is your budget?");
    expect(handleUnassigned).toHaveBeenCalledTimes(1);
    expect(rows.sms_line_sessions).toBeUndefined();
  });

  it("a lead that picked a room is re-routed to that workspace", async () => {
    handleUnassigned.mockResolvedValueOnce({ leadId: "lead-2", reply: null, assignedWorkspaceId: "ws-b" });
    const { db } = world();
    const decision = await routeSharedLineInbound(db, inbound("I'll take the room", { fromPhone: "+12065550999", phoneKey: "2065550999" }), null);
    expect(decision).toMatchObject({ kind: "routed", workspaceId: "ws-b", ownerUserId: OWNER_B, role: "prospect" });
  });

  it("dryRun (shadow) has no side effects: no lead, no session", async () => {
    const stranger = world();
    const decision = await routeSharedLineInbound(stranger.db, inbound("rooms?", { fromPhone: "+12065550999", phoneKey: "2065550999" }), null, { dryRun: true });
    expect(decision).toEqual({ kind: "unassigned", role: "prospect", leadId: null });
    expect(handleUnassigned).not.toHaveBeenCalled();
    const both = world({ ...RESIDENT_IN_A, ...VENDOR_IN_B });
    await routeSharedLineInbound(both.db, inbound("hello"), null, { dryRun: true });
    await routeSharedLineInbound(world(RESIDENT_IN_A).db, inbound("hello"), null, { dryRun: true });
    expect(both.upserts).toEqual([]);
    expect(both.rows.sms_line_sessions).toBeUndefined();
  });
});

describe("multi-role: one phone in two teams", () => {
  const both = () => world({ ...RESIDENT_IN_A, ...VENDOR_IN_B });

  it("a neutral text asks 'Is this about <house> or your job at <area>?' and remembers the question", async () => {
    const { db, rows } = both();
    const decision = await routeSharedLineInbound(db, inbound("ok thanks"), null);
    // The vendor half is the general AREA: that job may only be offered, and an offered vendor is never told a street.
    expect(decision).toMatchObject({ kind: "ambiguous", question: "Is this about 5259 Brooklyn or your job at Seattle?" });
    expect(rows.sms_line_sessions).toMatchObject([{ phone_key: "2065550142" }]);
    const pending = (rows.sms_line_sessions[0].pending_candidates as SharedLineCandidate[]).map((c) => c.workspaceId);
    expect(pending).toEqual(["ws-a", "ws-b"]);
  });

  it("a text that fits one role's wording switches without asking", async () => {
    const { db } = both();
    expect(await routeSharedLineInbound(db, inbound("my rent is going to be late"), null)).toMatchObject({ kind: "routed", workspaceId: "ws-a", role: "resident" });
    expect(await routeSharedLineInbound(db, inbound("I arrived and the job is finished"), null)).toMatchObject({ kind: "routed", workspaceId: "ws-b", role: "vendor" });
  });

  it("wording that fits both roles is not a switch: it asks", async () => {
    const { db } = both();
    expect((await routeSharedLineInbound(db, inbound("rent job"), null)).kind).toBe("ambiguous");
  });

  it("a text naming a house, or its street number, settles it", async () => {
    const { db } = both();
    expect(await routeSharedLineInbound(db, inbound("question about 4709A"), null)).toMatchObject({ kind: "routed", workspaceId: "ws-b" });
    expect(await routeSharedLineInbound(db, inbound("the 5259 brooklyn kitchen"), null)).toMatchObject({ kind: "routed", workspaceId: "ws-a" });
  });

  it("the thread's current team and role is kept when the text is neutral", async () => {
    const { db } = both();
    const sticky = session({ currentWorkspaceId: "ws-b", activeRole: "vendor" });
    expect(await routeSharedLineInbound(db, inbound("ok thanks"), sticky)).toMatchObject({ kind: "routed", workspaceId: "ws-b", role: "vendor" });
    // ...but clear wording about the other role still switches.
    expect(await routeSharedLineInbound(db, inbound("when is rent due?"), sticky)).toMatchObject({ kind: "routed", workspaceId: "ws-a", role: "resident" });
  });

  it("a reply to the pending question resolves it: '1', '2', or naming the house", async () => {
    const { db } = both();
    const asked = (await routeSharedLineInbound(db, inbound("ok thanks"), null)) as Extract<Awaited<ReturnType<typeof routeSharedLineInbound>>, { kind: "ambiguous" }>;
    const pendingSession = session({ pendingCandidates: asked.candidates });
    expect(await routeSharedLineInbound(db, inbound("2"), pendingSession)).toMatchObject({ kind: "routed", workspaceId: "ws-b", role: "vendor" });
    expect(await routeSharedLineInbound(db, inbound("1"), pendingSession)).toMatchObject({ kind: "routed", workspaceId: "ws-a" });
    expect(await routeSharedLineInbound(db, inbound("8th ave"), pendingSession)).toMatchObject({ kind: "routed", workspaceId: "ws-b" });
    expect(await routeSharedLineInbound(db, inbound("the brooklyn one"), pendingSession)).toMatchObject({ kind: "routed", workspaceId: "ws-a" });
    // Not an answer: asked again.
    expect((await routeSharedLineInbound(db, inbound("what?"), pendingSession)).kind).toBe("ambiguous");
  });

  it("a stored question is only a hint: a candidate the phone no longer has is never honored", async () => {
    const { db } = world(RESIDENT_IN_A);
    const stale: SharedLineCandidate = {
      workspaceId: "ws-b", ownerUserId: OWNER_B, role: "vendor", reason: "vendor_job", propertyId: "prop-b1", label: "4709A 8th Ave",
    };
    const fresh = await findResidentCandidates(db, PHONE);
    expect(resolvePendingAnswer("1", [stale, fresh[0]], fresh)).toBeNull();
    const decision = await routeSharedLineInbound(db, inbound("1"), session({ pendingCandidates: [stale, fresh[0]] }));
    // Only one workspace is real now, so it routes there, never to the stale B.
    expect(decision).toMatchObject({ kind: "routed", workspaceId: "ws-a" });
  });
});

describe("leakage across teams", () => {
  it("a phone that is resident in A and vendor in B never routes A-flavored texts to B", async () => {
    const { db } = world({ ...RESIDENT_IN_A, ...VENDOR_IN_B });
    for (const text of ["my rent", "when is the lease up", "my roommate is loud", "laundry room", "5259 brooklyn"]) {
      const d = await routeSharedLineInbound(db, inbound(text), null, { dryRun: true });
      expect(d.kind === "routed" ? d.workspaceId : "asked").not.toBe("ws-b");
    }
  });

  it("an ambiguity question names only houses this phone belongs to", async () => {
    const { db } = world({ ...RESIDENT_IN_A, ...VENDOR_IN_B });
    const d = await routeSharedLineInbound(db, inbound("hello"), null, { dryRun: true });
    if (d.kind !== "ambiguous") throw new Error("expected a question");
    expect(d.candidates.map((c) => c.workspaceId).sort()).toEqual(["ws-a", "ws-b"]);
    expect(d.question).not.toMatch(/Eighth Ave Co|Brooklyn Homes/);
  });

  it("a different phone with no ties to A or B sees neither", async () => {
    const { db } = world({ ...RESIDENT_IN_A, ...VENDOR_IN_B });
    const d = await routeSharedLineInbound(db, inbound("hello", { fromPhone: "+12065550888", phoneKey: "2065550888" }), null, { dryRun: true });
    expect(d.kind).toBe("unassigned");
  });
});

describe("pure helpers", () => {
  const A: SharedLineCandidate = { workspaceId: "a", ownerUserId: "oa", role: "resident", reason: "resident", propertyId: null, label: "5259 Brooklyn Ave" };
  // A vendor candidate carries the general area and its workspace's name beside the house: `label` is what a text
  // may NAME to route, and what we say back to a vendor is drawn from the other two, never from it.
  const B: SharedLineCandidate = {
    workspaceId: "b", ownerUserId: "ob", role: "vendor", reason: "vendor_job", propertyId: null,
    label: "4709A 8th Ave", generalArea: "Seattle", workspaceName: "Eighth Ave Co",
  };

  it("textNamesCandidate: all distinctive words or the street number; not a bare shared word", () => {
    expect(textNamesCandidate("about 5259 brooklyn", A)).toBe(true);
    expect(textNamesCandidate("the brooklyn ave place", A)).toBe(false);
    expect(textNamesCandidate("unit at 5259", A)).toBe(true);
    expect(textNamesCandidate("5257 brooklyn", A)).toBe(false);
  });

  it("dedupeCandidates keeps resident and vendor in one workspace apart but merges the tenant journey", () => {
    const v: SharedLineCandidate = { ...A, role: "vendor", reason: "vendor_job" };
    const p: SharedLineCandidate = { ...A, role: "prospect", reason: "returning_prospect" };
    const out = dedupeCandidates([p, v, A]);
    expect(out.map((c) => c.reason)).toEqual(["resident", "vendor_job"]);
  });

  it("buildDisambiguationQuestion handles two, three, and a same-place pair", () => {
    expect(buildDisambiguationQuestion([A, B])).toBe("Is this about 5259 Brooklyn Ave or your job at Seattle?");
    const C = { ...A, workspaceId: "c", label: "Cedar" };
    expect(buildDisambiguationQuestion([A, B, C])).toBe("Is this about 5259 Brooklyn Ave, your job at Seattle or Cedar?");
    // One house, two roles: the resident half names it, the vendor half gets the area.
    const same = { ...A, role: "vendor" as const, reason: "vendor_job" as const, generalArea: "5259 Brooklyn Ave" };
    expect(buildDisambiguationQuestion([A, same])).toBe("Is this about your room at 5259 Brooklyn Ave or a job at 5259 Brooklyn Ave?");
  });

  // Review fix, Oct 20: the old fallback was `label` - the buildingName or the street - so a house whose address
  // has no comma-separated city (`generalArea` is "" for those) put its address in front of an OFFERED vendor.
  it("a vendor candidate with no area names its workspace, and with neither names nobody's street", () => {
    const noArea: SharedLineCandidate = { ...B, generalArea: undefined };
    expect(buildDisambiguationQuestion([A, noArea])).toBe("Is this about 5259 Brooklyn Ave or your job at Eighth Ave Co?");
    const bare: SharedLineCandidate = { ...B, generalArea: undefined, workspaceName: undefined };
    expect(buildDisambiguationQuestion([A, bare])).not.toMatch(/4709A|8th/);
  });

  describe("a live dispatch offer outranks the sticky thread", () => {
    const sticky: SharedLineSession = { phoneKey: "2065550142", currentWorkspaceId: "a", activeRole: "vendor", aiPaused: false, pausedAt: null, pendingCandidates: null, updatedAt: "2026-10-18T00:00:00Z" };
    const stickyJob: SharedLineCandidate = { ...B, workspaceId: "a", ownerUserId: "oa", label: "5259 Brooklyn Ave", generalArea: "Wedgwood" };
    const offerJob: SharedLineCandidate = { ...B, workspaceId: "c", ownerUserId: "oc", label: "Cedar Apts", generalArea: "Cedar Apts", liveDispatch: ["offer"] };
    const secondOffer: SharedLineCandidate = { ...B, workspaceId: "d", ownerUserId: "od", label: "Dexter House", generalArea: "Dexter House", liveDispatch: ["offer"] };
    const acceptedJob: SharedLineCandidate = { ...B, workspaceId: "e", ownerUserId: "oe", label: "Elm Court", generalArea: "Elm Court", liveDispatch: ["accepted"] };

    it("a bare YES / Y / N goes to the workspace with the live offer, not the sticky one", () => {
      for (const body of ["YES", "y", "No", "N"]) {
        const d = decideFromCandidates({ body, candidates: [stickyJob, offerJob], session: sticky });
        expect(d).toMatchObject({ kind: "routed", candidate: { workspaceId: "c" } });
      }
    });

    it("a bare DONE goes to the workspace with the accepted job, and YES does not", () => {
      expect(decideFromCandidates({ body: "DONE", candidates: [stickyJob, acceptedJob], session: sticky })).toMatchObject({ kind: "routed", candidate: { workspaceId: "e" } });
      expect(decideFromCandidates({ body: "yes", candidates: [stickyJob, acceptedJob], session: sticky })).toMatchObject({ kind: "routed", candidate: { workspaceId: "a" } });
    });

    it("two live offers ask which, listing only those two", () => {
      const d = decideFromCandidates({ body: "YES", candidates: [stickyJob, offerJob, secondOffer], session: sticky });
      expect(d.kind).toBe("ambiguous");
      if (d.kind === "ambiguous") {
        expect(d.candidates.map((c) => c.workspaceId).sort()).toEqual(["c", "d"]);
        expect(d.question).toBe("Is this about your job at Cedar Apts or your job at Dexter House?");
      }
    });

    it("sticky still wins when nothing is waiting, and a job number or a non-answer does not trigger the rule", () => {
      expect(decideFromCandidates({ body: "YES", candidates: [stickyJob, { ...offerJob, liveDispatch: [] }], session: sticky })).toMatchObject({ kind: "routed", candidate: { workspaceId: "a" } });
      expect(decideFromCandidates({ body: "what time is the visit", candidates: [stickyJob, offerJob], session: sticky })).toMatchObject({ kind: "routed", candidate: { workspaceId: "a" } });
      expect(decideFromCandidates({ body: "YES #4", candidates: [stickyJob, offerJob], session: sticky })).toMatchObject({ kind: "routed", candidate: { workspaceId: "a" } });
    });
  });

  it("dispatch lookup: an offered attempt marks its workspace as waiting on an answer, an accepted job as waiting on DONE", async () => {
    const dispatch = (attempt: string, run: string) => ({
      manager_vendor_records: [{ id: "vd-1", manager_user_id: OWNER_B, row_data: { name: "Sam", phone: "(206) 555-0142", active: true } }],
      vendor_dispatch_attempts: [{ run_id: "run-1", vendor_directory_id: "vd-1", status: attempt }],
      vendor_dispatch_runs: [{ id: "run-1", owner_user_id: OWNER_B, property_id: "prop-b1", status: run, completed_at: null }],
    });
    const offered = world(dispatch("offered", "offering"));
    expect(await findVendorJobCandidates(offered.db, PHONE)).toMatchObject([{ workspaceId: "ws-b", liveDispatch: ["offer"] }]);
    const accepted = world(dispatch("accepted", "accepted"));
    expect(await findVendorJobCandidates(accepted.db, PHONE)).toMatchObject([{ workspaceId: "ws-b", liveDispatch: ["accepted"] }]);
    const exhausted = world(dispatch("timed_out", "exhausted"));
    const [candidate] = await findVendorJobCandidates(exhausted.db, PHONE);
    expect(candidate).toMatchObject({ workspaceId: "ws-b" });
    expect(candidate!.liveDispatch).toBeUndefined();
  });

  it("decideFromCandidates is none for nobody and routed for one", () => {
    expect(decideFromCandidates({ body: "hi", candidates: [], session: null }).kind).toBe("none");
    expect(decideFromCandidates({ body: "hi", candidates: [A], session: null })).toMatchObject({ kind: "routed" });
  });
});
