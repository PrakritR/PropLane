import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ops: vi.fn(),
  alertTargets: vi.fn(),
  recipients: vi.fn(),
  sendOwner: vi.fn(),
  sendWork: vi.fn(),
  profiles: {} as Record<string, Record<string, unknown>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/inbound-alert.server", () => ({ loadPlatformOpsPhones: m.ops }));
vi.mock("@/lib/service/service-alert-targets.server", () => ({ resolveServiceAlertTargets: m.alertTargets }));
vi.mock("@/lib/workspace-team-recipients.server", () => ({ resolveWorkspaceNoticeRecipients: m.recipients }));
vi.mock("@/lib/service/service-manager.server", () => ({ sendTextFromServiceOwner: m.sendOwner }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: m.sendWork }));
vi.mock("@/lib/sms/team-notice-consent.server", () => ({ SERVICE_ALERT_PHONE_SMS_PURPOSE: "service_alert_phone_notice" }));

import {
  callerIsFrustrated,
  escalationSummaryText,
  mayRingNow,
  resolveEscalationTarget,
  sendEscalationSummary,
} from "@/lib/voice/voice-escalation.server";

const LINE = "+12066781909";
const CALLER = "+13105550999";
const db = {
  from: () => {
    let id = "";
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (_c: string, v: string) => ((id = v), chain);
    chain.maybeSingle = async () => ({ data: m.profiles[id] ?? null, error: null });
    return chain;
  },
} as never;

const resolved = (over: Record<string, unknown> = {}) =>
  ({ ok: true, managerId: "owner", workspaceId: "ws", workNumber: LINE, line: "dedicated", route: { kind: "prospect" }, billing: { primary: { ownerId: "owner", workspaceId: "ws" }, platform: null }, ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.profiles = {
    owner: { phone: "+12065550100", phone_verified_at: "2026-01-01", sms_forward_inbound: true, full_name: "Ambika Mago" },
    staff: { phone: "+12065550142", phone_verified_at: "2026-01-01", sms_forward_inbound: true, full_name: "Marcus Lee" },
    unverified: { phone: "+12065550177", phone_verified_at: null, sms_forward_inbound: true, full_name: "Una Verified" },
  };
  m.recipients.mockResolvedValue([]);
  m.alertTargets.mockResolvedValue(null);
  m.ops.mockResolvedValue(["+15103098345"]);
  m.sendOwner.mockResolvedValue({ ok: true });
  m.sendWork.mockResolvedValue({ ok: true });
});

describe("who is rung", () => {
  it("the covering team member with a verified phone, before the owner", async () => {
    m.recipients.mockResolvedValue([{ userId: "owner", isOwner: true }, { userId: "unverified", isOwner: false }, { userId: "staff", isOwner: false }]);
    expect(await resolveEscalationTarget(db, { resolved: resolved(), callerPhone: CALLER, propertyId: "prop-1" })).toEqual({ toPhone: "+12065550142", firstName: "Marcus", via: "covering_member", userId: "staff" });
    expect(m.recipients).toHaveBeenCalledWith(db, expect.objectContaining({ ownerUserId: "owner", workspaceId: "ws", module: "inbox", propertyId: "prop-1" }));
  });

  it("an unverified phone is never dialed; the workspace owner's verified phone is next", async () => {
    m.recipients.mockResolvedValue([{ userId: "unverified", isOwner: false }]);
    expect(await resolveEscalationTarget(db, { resolved: resolved(), callerPhone: CALLER })).toMatchObject({ toPhone: "+12065550100", firstName: "Ambika", via: "owner" });
  });

  it("a self-serve workspace with nobody verified has nobody to ring", async () => {
    m.profiles.owner = { phone: "+12065550100", phone_verified_at: null };
    expect(await resolveEscalationTarget(db, { resolved: resolved(), callerPhone: CALLER })).toBeNull();
    expect(m.ops).not.toHaveBeenCalled();
  });

  it("a PropLane-managed workspace rings its covering staff seat, else its listed alert phone", async () => {
    const platform = { primary: { ownerId: "owner", workspaceId: "ws" }, platform: { ownerId: "platform", workspaceId: "ws-platform" } };
    m.alertTargets.mockResolvedValue({ phones: [{ phone: "+15103098345", userId: null, label: "Alerts", sendClass: "transactional" }, { phone: "+12065550142", userId: "staff", label: "Marcus Lee", sendClass: "transactional" }] });
    expect(await resolveEscalationTarget(db, { resolved: resolved({ billing: platform }), callerPhone: CALLER })).toMatchObject({ toPhone: "+12065550142", firstName: "Marcus", via: "covering_member" });
    m.alertTargets.mockResolvedValue({ phones: [{ phone: "+15103098345", userId: null, label: "Alerts", sendClass: "transactional" }] });
    expect(await resolveEscalationTarget(db, { resolved: resolved({ billing: platform }), callerPhone: CALLER })).toMatchObject({ toPhone: "+15103098345", via: "platform_admin" });
  });

  it("an unknown caller on the PropLane line rings PropLane's admin alert phone, read from the roster", async () => {
    const stranger = resolved({ line: "shared", route: { kind: "prospect", serviceCatalog: true }, billing: { primary: { ownerId: "platform", workspaceId: "wp" }, platform: { ownerId: "platform", workspaceId: "wp" } } });
    expect(await resolveEscalationTarget(db, { resolved: stranger, callerPhone: CALLER })).toEqual({ toPhone: "+15103098345", firstName: null, via: "platform_admin", userId: null });
    expect(m.recipients).not.toHaveBeenCalled();
  });

  it("never rings the caller, or the line itself", async () => {
    m.ops.mockResolvedValue([CALLER, LINE]);
    const stranger = resolved({ route: { kind: "ambiguous", candidates: [], question: "?" }, billing: { primary: { ownerId: "p", workspaceId: "w" }, platform: { ownerId: "p", workspaceId: "w" } } });
    expect(await resolveEscalationTarget(db, { resolved: stranger, callerPhone: CALLER })).toBeNull();
    m.recipients.mockResolvedValue([{ userId: "staff", isOwner: false }]);
    expect(await resolveEscalationTarget(db, { resolved: resolved(), callerPhone: "+12065550142" })).toMatchObject({ via: "owner" });
  });
});

describe("quiet hours", () => {
  it("a routine escalation does not ring at night; an emergency always does", () => {
    const night = new Date("2026-11-12T08:00:00Z"); // 12 AM Pacific
    const noon = new Date("2026-11-12T20:00:00Z"); // 12 PM Pacific
    expect(mayRingNow("asked_for_person", night)).toBe(false);
    expect(mayRingNow("cannot_answer", night)).toBe(false);
    expect(mayRingNow("emergency", night)).toBe(true);
    expect(mayRingNow("asked_for_person", noon)).toBe(true);
  });
});

describe("the call-back text", () => {
  it("is one GSM-7 line with the caller's number and what they wanted, no door codes or links", () => {
    const text = escalationSummaryText({ callerPhone: CALLER, callerKind: "prospect", gist: "can I waive the deposit https://x.test/a", reason: "cannot_answer" });
    expect(text).toContain("+13105550999");
    expect(text).toContain("had a question I could not answer");
    expect(text).not.toContain("https");
    expect(text.length).toBeLessThanOrEqual(220);
    expect(/^[\x20-\x7E]+$/.test(text)).toBe(true);
  });

  it("goes through the service owner for a PropLane admin phone, and the work number for a manager, once per call", async () => {
    const target = { toPhone: "+15103098345", firstName: null, via: "platform_admin" as const, userId: null };
    await sendEscalationSummary(db, { resolved: resolved(), target, callSid: "CA1", text: "x", urgent: false });
    expect(m.sendOwner).toHaveBeenCalledWith(db, expect.objectContaining({ toPhone: "+15103098345", dedupeKey: "voice-esc:CA1", sendClass: "automated" }));
    await sendEscalationSummary(db, { resolved: resolved(), target: { ...target, via: "covering_member", userId: "staff", toPhone: "+12065550142" }, callSid: "CA2", text: "x", urgent: true });
    expect(m.sendWork).toHaveBeenCalledWith(expect.objectContaining({ to: "+12065550142", fromNumber: LINE, dedupeKey: "voice-esc:CA2", sendClass: "transactional" }));
  });
});

describe("frustration", () => {
  it("is read narrowly", () => {
    expect(callerIsFrustrated("this is useless")).toBe(true);
    expect(callerIsFrustrated("you're not helping")).toBe(true);
    expect(callerIsFrustrated("how much is the room")).toBe(false);
  });
});
