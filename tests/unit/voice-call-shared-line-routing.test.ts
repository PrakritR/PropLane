import { beforeEach, describe, expect, it, vi } from "vitest";

/** Routing a call is the same decision an inbound text gets: the shared-line seam, by caller role, with PropLane as the backstop payer. */
const m = vi.hoisted(() => ({
  config: vi.fn(),
  decide: vi.fn(),
  owned: vi.fn(),
  managerIdentity: vi.fn(),
  resident: vi.fn(),
  isService: vi.fn(),
  serviceLine: vi.fn(),
  platformOwner: vi.fn(),
  defaultWs: vi.fn(),
  saveRoute: vi.fn(async () => undefined),
  redirect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/config.server", () => ({
  loadSharedLineConfig: m.config,
  isSharedLineNumber: (c: { sharedNumber: string | null }, to: string) => c.sharedNumber === to,
}));
vi.mock("@/lib/one-number/inbound-seam.server", () => ({ decideSharedLineCall: m.decide }));
vi.mock("@/lib/one-number/dedicated-redirect.server", () => ({ dedicatedRedirectReplyFor: m.redirect }));
vi.mock("@/lib/one-number/router.server", () => ({
  pickCandidateFromText: (text: string, cands: Array<{ label: string }>) => cands.find((c) => text.toLowerCase().includes(c.label.toLowerCase())) ?? null,
  spokenLabelFor: (c: { label: string }) => c.label,
}));
vi.mock("@/lib/one-number/session.server", () => ({ saveSharedLineRoute: m.saveRoute }));
vi.mock("@/lib/one-number/service-line.server", () => ({ isServiceWorkspace: m.isService }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: m.defaultWs }));
vi.mock("@/lib/service/service-catalog.server", () => ({ isPropLaneServiceLine: m.serviceLine, readPlatformServiceOwnerId: m.platformOwner }));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({ resolveManagerSmsInboundIdentity: m.managerIdentity }));
vi.mock("@/lib/tools/manager-sms-context", () => ({ resolveManagerSmsAgentContext: vi.fn() }));
vi.mock("@/lib/tools/resident-sms-context", () => ({ resolveResidentSmsAgentContext: m.resident }));
vi.mock("@/lib/voice/manager-voice-inbound.server", () => ({ resolveOwnedWorkNumber: m.owned }));

import { resolveVoiceCallRoute } from "@/lib/voice/voice-call-routing.server";

const SHARED = "+12066781909";
const FROM = "+13105550999";
const CAND = { workspaceId: "ws-ambika", ownerUserId: "ambika", role: "prospect", reason: "returning_prospect", propertyId: null, label: "5259 Brooklyn" };
const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.config.mockResolvedValue({ mode: "shared", sharedNumber: SHARED, messagingServiceSid: "MG1", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [] });
  m.managerIdentity.mockResolvedValue(null);
  m.resident.mockResolvedValue({ ok: false });
  m.isService.mockResolvedValue(false);
  m.serviceLine.mockResolvedValue(false);
  m.platformOwner.mockResolvedValue("platform");
  m.defaultWs.mockResolvedValue("ws-platform");
});

describe("the shared PropLane line", () => {
  it("a stranger is a prospect served from PropLane's own homes, and PropLane pays", async () => {
    m.decide.mockResolvedValue({ kind: "stranger" });
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA1" });
    expect(r).toMatchObject({ ok: true, line: "shared", managerId: "platform", workspaceId: "ws-platform", route: { kind: "prospect", serviceCatalog: true } });
    if (r.ok) expect(r.billing).toEqual({ primary: { ownerId: "platform", workspaceId: "ws-platform" }, platform: { ownerId: "platform", workspaceId: "ws-platform" } });
  });

  it("a caller the router places in a workspace is that workspace's prospect, billed to it first", async () => {
    m.decide.mockResolvedValue({ kind: "continue", owned: { managerId: "ambika", workspaceId: "ws-ambika" }, candidate: CAND });
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA2" });
    expect(r).toMatchObject({ ok: true, managerId: "ambika", workspaceId: "ws-ambika", route: { kind: "prospect" } });
    if (r.ok) expect(r.billing.platform).toBeNull();
  });

  it("a PropLane-managed workspace is billed to itself and backstopped by PropLane", async () => {
    m.decide.mockResolvedValue({ kind: "continue", owned: { managerId: "ambika", workspaceId: "ws-ambika" }, candidate: CAND });
    m.isService.mockResolvedValue(true);
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA3" });
    if (r.ok) expect(r.billing).toEqual({ primary: { ownerId: "ambika", workspaceId: "ws-ambika" }, platform: { ownerId: "platform", workspaceId: "ws-platform" } });
  });

  it("a verified resident of the routed workspace gets the resident agent", async () => {
    m.decide.mockResolvedValue({ kind: "continue", owned: { managerId: "ambika", workspaceId: "ws-ambika" }, candidate: { ...CAND, role: "resident" } });
    m.resident.mockResolvedValue({ ok: true, ctx: { userId: "res-1" } });
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA4" });
    expect(r).toMatchObject({ ok: true, route: { kind: "resident", residentUserId: "res-1" } });
    expect(m.resident).toHaveBeenCalledWith(db, expect.objectContaining({ ownerManagerUserId: "ambika" }));
  });

  it("a verified manager or staff member gets the manager agent", async () => {
    m.decide.mockResolvedValue({ kind: "continue", owned: { managerId: "ambika", workspaceId: "ws-ambika" }, candidate: { ...CAND, role: "manager" } });
    m.managerIdentity.mockResolvedValue({ workNumberOwnerId: "ambika", actorUserId: "staff-1", actorPhone: FROM, workNumber: SHARED, access: {} });
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA5" });
    expect(r).toMatchObject({ ok: true, route: { kind: "manager" } });
  });

  it("a vendor is not served by voice for now: told to text", async () => {
    m.decide.mockResolvedValue({ kind: "continue", owned: { managerId: "ambika", workspaceId: "ws-ambika" }, candidate: { ...CAND, role: "vendor" } });
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA6" });
    expect(r).toMatchObject({ ok: true, route: { kind: "redirect" } });
  });

  it("an unclear caller is asked one question, and a spoken house name settles it and is remembered", async () => {
    const two = [CAND, { ...CAND, workspaceId: "ws-vinod", ownerUserId: "vinod", label: "12 Ravenna" }];
    m.decide.mockResolvedValue({ kind: "ambiguous", candidates: two, question: "Is this about 5259 Brooklyn or 12 Ravenna?" });
    const asked = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA7" });
    expect(asked).toMatchObject({ ok: true, route: { kind: "ambiguous", question: "Is this about 5259 Brooklyn or 12 Ravenna?" } });
    const settled = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA7", speech: "the 12 Ravenna place" });
    expect(settled).toMatchObject({ ok: true, managerId: "vinod", workspaceId: "ws-vinod", route: { kind: "prospect" } });
    expect(m.saveRoute).toHaveBeenCalledWith(db, "3105550999", { workspaceId: "ws-vinod", role: "prospect" });
  });

  it("someone whose only ties are to a workspace with a number of its own is told that number", async () => {
    m.decide.mockResolvedValue({ kind: "dedicated", candidate: CAND });
    m.redirect.mockResolvedValue("5259 Brooklyn texts from (206) 555-0111. Please text that number.");
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA8" });
    expect(r).toMatchObject({ ok: true, route: { kind: "redirect", reply: expect.stringContaining("(206) 555-0111") } });
  });

  it("a caller the line does not serve is unconfigured", async () => {
    m.decide.mockResolvedValue({ kind: "none" });
    expect(await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA9" })).toEqual({ ok: false, reason: "unconfigured" });
  });
});

describe("a workspace's own work number", () => {
  it("never consults the shared-line seam, and a self-serve workspace has no PropLane backstop", async () => {
    m.owned.mockResolvedValue({ managerId: "solo", workspaceId: "ws-solo", messagingServiceSid: "MG1" });
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: "+12065559000", callSid: "CA10" });
    expect(m.decide).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, line: "dedicated", route: { kind: "prospect" } });
    if (r.ok) expect(r.billing.platform).toBeNull();
  });

  it("the service owner's own number is PropLane-run in every line mode", async () => {
    m.config.mockResolvedValue({ mode: "per_workspace", sharedNumber: null, messagingServiceSid: null, pilotWorkspaceIds: [] });
    m.owned.mockResolvedValue({ managerId: "platform", workspaceId: "ws-platform", messagingServiceSid: "MG1" });
    m.serviceLine.mockResolvedValue(true);
    const r = await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: SHARED, callSid: "CA11" });
    if (r.ok) expect(r.billing.platform).toEqual({ ownerId: "platform", workspaceId: "ws-platform" });
  });

  it("an unregistered number is unconfigured", async () => {
    m.owned.mockResolvedValue(null);
    expect(await resolveVoiceCallRoute(db, { fromPhone: FROM, toPhone: "+19998887777", callSid: "CA12" })).toEqual({ ok: false, reason: "unconfigured" });
  });
});
