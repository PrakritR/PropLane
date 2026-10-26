/**
 * A person who PAYS for a personal PropLane number is pointed at it when they text the 206, in both line modes, before any
 * routing. Entitled resident number and routable vendor number redirect; lapsed or unreadable = served normally; a manager
 * seat, keywords and dispatch answers are never redirected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const state = vi.hoisted(() => ({
  flag: true,
  residentNumbers: {} as Record<string, string | null>,
  residentEntitled: {} as Record<string, boolean>,
  residentLookupThrows: false,
  vendorNumbers: {} as Record<string, string | null>,
  vendorLookupThrows: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/number-subscription/constants", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/number-subscription/constants")>();
  return { ...actual, isNumberSubscriptionEnabled: () => state.flag };
});
vi.mock("@/lib/number-subscription/subscription.server", () => ({ numberServiceEntitled: async (id: string) => state.residentEntitled[id] === true }));
vi.mock("@/lib/resident-agent-number/number.server", () => ({
  getActiveResidentAgentNumber: async (_db: unknown, id: string) => {
    if (state.residentLookupThrows) throw new Error("down");
    const phoneNumber = state.residentNumbers[id];
    return phoneNumber ? { id: "rn", residentUserId: id, phoneNumber, sendReady: true } : null;
  },
}));
vi.mock("@/lib/vendor-work-identity.server", () => ({
  getRoutableVendorNumber: async (_db: unknown, id: string) => {
    if (state.vendorLookupThrows) throw new Error("down");
    const phoneNumber = state.vendorNumbers[id];
    return phoneNumber ? { identityId: "vn", vendorUserId: id, phoneNumber, sendReady: true, forwardToPhone: true } : null;
  },
}));

import { buildResidentNumberRedirect, buildVendorNumberRedirect, personalNumberRedirectFor } from "@/lib/one-number/personal-number-redirect.server";
import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { answerPropLaneLineText } from "@/lib/one-number/line-inbound.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const LINE = "+12066781909";
const SO = "so";
const RES = "res-1";
const VEN = "ven-1";
const BOTH = "both-1";
const MGR = "mgr-1";
const PH = { res: "+12065550301", ven: "+12065550302", both: "+12065550303", mgr: "+12065550304", plain: "+12065550305" };

let db: FakeDb;
const profile = (id: string, phone: string): Row => ({ id, email: `${id}@x.com`, phone, phone_verified_at: VERIFIED });

beforeEach(() => {
  state.flag = true;
  state.residentNumbers = { [RES]: "+14255550110", [BOTH]: "+14255550111", [MGR]: "+14255550112" };
  state.residentEntitled = { [RES]: true, [BOTH]: true, [MGR]: true };
  state.residentLookupThrows = false;
  state.vendorNumbers = { [VEN]: "+12065550177", [BOTH]: "+12065550178" };
  state.vendorLookupThrows = false;
  db = createFakeDb({
    profiles: [profile(RES, PH.res), profile(VEN, PH.ven), profile(BOTH, PH.both), profile(MGR, PH.mgr), profile("plain", PH.plain), profile(SO, "+15103098345")],
    profile_roles: [{ user_id: MGR, role: "manager" }, { user_id: RES, role: "resident" }, { user_id: VEN, role: "vendor" }],
    portal_workspaces: [{ id: "ws-mgr", name: "M", owner_user_id: MGR, is_default: true, is_service: false }],
    account_link_invites: [],
    platform_service_settings: [{ singleton: true, owner_user_id: SO }],
    manager_sms_numbers: [{ id: "n1", manager_user_id: SO, phone_number: LINE, provision_state: "active", released_at: null }],
    sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: LINE, shared_pilot_workspace_ids: [] }],
  });
});

const redirect = (fromPhone: string, body = "any rooms near UW?") => personalNumberRedirectFor(db as never, { fromPhone, body });

describe("personal-number redirects", () => {
  it("an entitled resident number: told to text it", async () => {
    expect(await redirect(PH.res)).toEqual({
      kind: "resident",
      actorUserId: RES,
      reply: "You have your own PropLane number, (425) 555-0110. Text it to find homes, book tours and reach your manager.",
    });
    expect(buildResidentNumberRedirect("+14255550110")).toBe("You have your own PropLane number, (425) 555-0110. Text it to find homes, book tours and reach your manager.");
  });

  it("a routable vendor number: told to text it", async () => {
    expect(await redirect(PH.ven, "I'm on my way")).toEqual({ kind: "vendor", actorUserId: VEN, reply: "Text your PropLane number (206) 555-0177 for jobs and messages." });
    expect(buildVendorNumberRedirect("+12065550177")).toBe("Text your PropLane number (206) 555-0177 for jobs and messages.");
  });

  it("both numbers: a work ask goes to the vendor number, anything else to the resident one", async () => {
    expect(await redirect(PH.both, "any work?")).toMatchObject({ kind: "vendor" });
    expect(await redirect(PH.both, "find me a room")).toMatchObject({ kind: "resident" });
  });

  it("a lapsed resident subscription, a flag-off world, an unverified phone or a stranger: no redirect, served normally", async () => {
    state.residentEntitled[RES] = false;
    expect(await redirect(PH.res)).toBeNull();
    state.residentEntitled[RES] = true;
    state.flag = false;
    expect(await redirect(PH.res)).toBeNull();
    state.flag = true;
    (db.tables.profiles!.find((p) => p.id === RES) as Row).phone_verified_at = null;
    expect(await redirect(PH.res)).toBeNull();
    expect(await redirect(PH.plain)).toBeNull();
  });

  it("a vendor number that is not routable (lapsed) is no redirect", async () => {
    state.vendorNumbers[VEN] = null;
    expect(await redirect(PH.ven)).toBeNull();
  });

  it("an unreadable number lookup is no redirect (never a guess)", async () => {
    state.residentLookupThrows = true;
    state.vendorLookupThrows = true;
    expect(await redirect(PH.res)).toBeNull();
    expect(await redirect(PH.ven)).toBeNull();
  });

  it("a manager-side account (role or seat) is not redirected: their texts are about running houses", async () => {
    expect(await redirect(PH.mgr)).toBeNull();
  });

  it("STOP, HELP, HUMAN, emergencies and a dispatch answer are never redirected", async () => {
    for (const body of ["STOP", "HELP", "human", "there is a fire in the kitchen", "YES", "BUSY 2h", "DONE"]) {
      expect(await redirect(PH.ven, body)).toBeNull();
      expect(await redirect(PH.res, body)).toBeNull();
    }
  });
});

describe("wiring: both line modes redirect before any routing", () => {
  it("shared mode: the seam answers on the webhook reply", async () => {
    const seam = await handleSharedLineInbound(db as never, {
      config: { mode: "shared", sharedNumber: LINE, messagingServiceSid: "MG1", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [] },
      fromPhone: PH.res,
      body: "any rooms near UW?",
      messageSid: "SM-1",
      mediaCount: 0,
      phoneKey: "2065550301",
    });
    expect(seam).toEqual({ kind: "handled", twiml: "You have your own PropLane number, (425) 555-0110. Text it to find homes, book tours and reach your manager." });
  });

  it("per_workspace line: the line answer is the redirect", async () => {
    (db.tables.sms_runtime_config![0] as Row).line_mode = "per_workspace";
    const answer = await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PH.ven, body: "I am on my way" });
    expect(answer).toEqual({ kind: "number_redirect", actorUserId: VEN, reply: "Text your PropLane number (206) 555-0177 for jobs and messages." });
  });

  it("per_workspace line: a lapsed vendor number falls through to the normal flows", async () => {
    (db.tables.sms_runtime_config![0] as Row).line_mode = "per_workspace";
    state.vendorNumbers[VEN] = null;
    expect(await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PH.ven, body: "I am on my way" })).toBeNull();
  });
});
