/**
 * The SERVICE MANAGER phone (admin Service settings): verify with a code, authoritative over profiles.phone, the alert
 * fan-out for service workspaces only, the PropLane-line recognition (only on the line, only the verified number), the
 * "Ambika or Vinod?" question, and the full manager context over one service workspace for a staff actor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const SO = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const CLIENT_A = "33333333-3333-4333-8333-333333333333";
const CLIENT_V = "44444444-4444-4444-8444-444444444444";
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_V = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS_P = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WS_SO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MANAGER_PHONE = "+15103098345";

const state = vi.hoisted(() => ({
  otp: { requestOk: true, verifyOk: true, sentCodes: [] as string[], verifyArgs: [] as unknown[] },
  texts: [] as Array<{ to: string; text: string; purpose?: string; dedupeKey?: string | null }>,
  codeTexts: [] as Array<{ phoneKey: string; body: string }>,
  auditOk: true,
  audits: [] as Array<Record<string, unknown>>,
  consents: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/one-number/phone-otp.server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/one-number/phone-otp.server")>();
  return {
    ...actual,
    requestPhoneOtp: async (_db: unknown, input: { send: (code: string, id: string) => Promise<boolean> }) => {
      if (!state.otp.requestOk) return { ok: false, reason: "rate_limited" };
      state.otp.sentCodes.push("123456");
      const sent = await input.send("123456", "chal-1");
      return sent ? { ok: true, challengeId: "chal-1" } : { ok: false, reason: "send_failed" };
    },
    verifyPhoneOtp: async (_db: unknown, input: unknown) => {
      state.otp.verifyArgs.push(input);
      return state.otp.verifyOk ? { ok: true } : { ok: false, reason: "wrong_code" };
    },
  };
});
vi.mock("@/lib/one-number/link-text.server", () => ({
  sendWorkspacePhoneText: async (_db: unknown, input: { phoneKey: string; body: string }) => {
    state.codeTexts.push({ phoneKey: input.phoneKey, body: input.body });
    return true;
  },
}));
vi.mock("@/lib/tools/audit", () => ({
  writeAuditLog: async (_actor: unknown, args: Record<string, unknown>) => {
    if (!state.auditOk) return { recorded: false, duplicate: false, error: "x" };
    state.audits.push(args);
    return { recorded: true };
  },
  updateAuditResult: async () => undefined,
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: async (args: { to: string; text: string; purpose?: string; dedupeKey?: string | null }) => {
    state.texts.push({ to: args.to, text: args.text, purpose: args.purpose, dedupeKey: args.dedupeKey });
    return { ok: true };
  },
}));
vi.mock("@/lib/sms-consent", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sms-consent")>();
  return {
    ...actual,
    readScopedSmsConsentState: async () => ({ ok: true, state: "none" }),
    recordScopedSmsConsent: async (_db: unknown, _phone: string, event: Record<string, unknown>) => {
      state.consents.push(event);
      return { ok: true };
    },
  };
});
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: async () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));
vi.mock("@/lib/auth/admin-role", () => ({ userHoldsAdminRole: async (_db: unknown, id: string) => id === "11111111-1111-4111-8111-111111111111" }));

import {
  clearServiceManagerPhone,
  identifyServiceManagerPhone,
  requestServiceManagerPhoneCode,
  sendToServiceManager,
  verifyServiceManagerPhone,
} from "@/lib/service/service-manager.server";
import { alertServiceManagerFromNotice, alertServiceManagerOfInquiry, composeServiceAlertText, serviceAlertEventKey } from "@/lib/service/service-manager-alerts.server";
import { buildServiceManagerAgentContext, pickServiceWorkspace, recognizeServiceManagerInbound, listServiceWorkspaceRefs } from "@/lib/sms/service-manager-inbound.server";
import { serviceWorkspaceLabel } from "@/lib/service/service-label";
import { ensureTeamNoticeScopedSmsConsent, isManagerRecipientSmsPurpose, SERVICE_MANAGER_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { isManagedReadOnly } from "@/lib/auth/managed-read-only.server";

type Db = ReturnType<typeof createMemoryDb>;
let db: Db;

function world(settings: Record<string, unknown> = {}) {
  return createMemoryDb({
    platform_service_settings: [{ singleton: true, owner_user_id: SO, manager_phone_e164: MANAGER_PHONE, manager_phone_verified_at: "2026-10-19T20:00:00.000Z", ...settings }],
    portal_workspaces: [
      { id: WS_A, name: "1. Ambika", owner_user_id: CLIENT_A, is_default: true, is_service: true },
      { id: WS_V, name: "2. Vinod", owner_user_id: CLIENT_V, is_default: true, is_service: true },
      { id: WS_P, name: "Plain", owner_user_id: CLIENT_A, is_default: false, is_service: false },
      { id: WS_SO, name: "PropLane", owner_user_id: SO, is_default: true, is_service: false },
    ],
    manager_property_records: [
      { id: "prop-a1", manager_user_id: CLIENT_A, workspace_id: WS_A },
      { id: "prop-a2", manager_user_id: CLIENT_A, workspace_id: WS_A },
      { id: "prop-plain", manager_user_id: CLIENT_A, workspace_id: WS_P },
      { id: "prop-v1", manager_user_id: CLIENT_V, workspace_id: WS_V },
    ],
    manager_sms_numbers: [{ id: "n1", manager_user_id: SO, phone_number: "+12066781909", provision_state: "active", released_at: null }],
    // Three profiles hold the manager's number: the setting, not the profile, is the identity.
    profiles: [
      { id: SO, email: "so@example.com", role: "admin", phone: "+15103098345", phone_verified_at: "2026-01-01T00:00:00Z" },
      { id: "t1", email: "t1@example.com", role: "manager", phone: "+15103098345", phone_verified_at: "2026-01-01T00:00:00Z" },
      { id: "t2", email: "t2@example.com", role: "manager", phone: "+15103098345", phone_verified_at: "2026-01-01T00:00:00Z" },
    ],
    profile_roles: [{ user_id: SO, role: "admin" }, { user_id: SO, role: "manager" }],
  });
}

beforeEach(() => {
  state.otp = { requestOk: true, verifyOk: true, sentCodes: [], verifyArgs: [] };
  state.texts = [];
  state.codeTexts = [];
  state.auditOk = true;
  state.audits = [];
  state.consents = [];
  db = world();
});

describe("the verified manager phone", () => {
  it("is the setting, not a profile: a number three profiles share still identifies the service manager", async () => {
    expect(await identifyServiceManagerPhone(db as never, "(510) 309-8345")).toMatchObject({ ownerUserId: SO, phoneE164: MANAGER_PHONE });
    expect(await identifyServiceManagerPhone(db as never, "+15103098345")).not.toBeNull();
    expect(await identifyServiceManagerPhone(db as never, "+12065550000")).toBeNull();
    expect(await identifyServiceManagerPhone(db as never, "")).toBeNull();
  });

  it("an unverified phone identifies nobody", async () => {
    db = world({ manager_phone_verified_at: null });
    expect(await identifyServiceManagerPhone(db as never, MANAGER_PHONE)).toBeNull();
    db = world({ manager_phone_e164: null, manager_phone_verified_at: null });
    expect(await identifyServiceManagerPhone(db as never, MANAGER_PHONE)).toBeNull();
  });

  it("sends the code to the number being verified, then a right code saves it as verified with an audit row first", async () => {
    db = world({ manager_phone_e164: null, manager_phone_verified_at: null });
    expect(await requestServiceManagerPhoneCode(db as never, ADMIN, "(510) 309-8345")).toEqual({ ok: true });
    expect(state.codeTexts).toHaveLength(1);
    expect(state.codeTexts[0]!.phoneKey).toBe(MANAGER_PHONE);
    expect(state.codeTexts[0]!.body).toContain("123456");
    const verified = await verifyServiceManagerPhone(db as never, ADMIN, { phone: "5103098345", code: "123456" });
    expect(verified).toMatchObject({ ok: true, view: { phone: MANAGER_PHONE, verified: true } });
    expect(db.__tables.platform_service_settings![0]).toMatchObject({ manager_phone_e164: MANAGER_PHONE });
    expect(db.__tables.platform_service_settings![0]!.manager_phone_verified_at).toBeTruthy();
    expect(state.audits[0]).toMatchObject({ action: "admin_service_manager_phone_change" });
    expect((state.otp.verifyArgs[0] as { purpose: string }).purpose).toBe("service_manager");
  });

  it("a wrong code, a bad number or a failed audit changes nothing", async () => {
    db = world({ manager_phone_e164: null, manager_phone_verified_at: null });
    state.otp.verifyOk = false;
    expect(await verifyServiceManagerPhone(db as never, ADMIN, { phone: "5103098345", code: "000000" })).toMatchObject({ ok: false, status: 400 });
    expect(await requestServiceManagerPhoneCode(db as never, ADMIN, "12345")).toMatchObject({ ok: false, status: 400 });
    state.otp.verifyOk = true;
    state.auditOk = false;
    expect(await verifyServiceManagerPhone(db as never, ADMIN, { phone: "5103098345", code: "123456" })).toMatchObject({ ok: false, status: 503 });
    expect(db.__tables.platform_service_settings![0]!.manager_phone_e164).toBeNull();
  });

  it("rate limiting reads as 429", async () => {
    state.otp.requestOk = false;
    expect(await requestServiceManagerPhoneCode(db as never, ADMIN, "5103098345")).toMatchObject({ ok: false, status: 429 });
  });

  it("clearing removes the phone and its verification together, audited", async () => {
    expect(await clearServiceManagerPhone(db as never, ADMIN)).toMatchObject({ ok: true, view: { phone: null, verified: false } });
    expect(db.__tables.platform_service_settings![0]).toMatchObject({ manager_phone_e164: null, manager_phone_verified_at: null });
    expect(state.audits).toHaveLength(1);
    expect(await clearServiceManagerPhone(db as never, ADMIN)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("texts to the manager phone", () => {
  it("leave from the PropLane line under the service-manager purpose, and that purpose is a manager-recipient one", async () => {
    expect(await sendToServiceManager(db as never, { text: "hello", dedupeKey: "k1" })).toEqual({ ok: true });
    expect(state.texts).toEqual([{ to: MANAGER_PHONE, text: "hello", purpose: SERVICE_MANAGER_SMS_PURPOSE, dedupeKey: "k1" }]);
    expect(isManagerRecipientSmsPurpose(SERVICE_MANAGER_SMS_PURPOSE)).toBe(true);
  });

  it("nothing is sent without a verified phone", async () => {
    db = world({ manager_phone_verified_at: null });
    expect(await sendToServiceManager(db as never, { text: "hello", dedupeKey: "k1" })).toMatchObject({ ok: false });
    expect(state.texts).toHaveLength(0);
  });

  it("consent for it is the verified setting: granted for that number and owner, nothing for any other", async () => {
    const scope = { managerUserId: SO, recipientPhone: MANAGER_PHONE, purpose: SERVICE_MANAGER_SMS_PURPOSE, sendClass: "transactional" as const, messagingServiceSid: "MG1" };
    const ok = await ensureTeamNoticeScopedSmsConsent(db as never, scope);
    expect(ok).toEqual({ ok: true, granted: true });
    expect(state.consents[0]).toMatchObject({ eventType: "granted", source: "service_manager_verified_phone", managerUserId: SO });
    const wrong = await ensureTeamNoticeScopedSmsConsent(db as never, { ...scope, recipientPhone: "+12065550000" });
    expect(wrong).toMatchObject({ ok: true, granted: false });
    const otherOwner = await ensureTeamNoticeScopedSmsConsent(db as never, { ...scope, managerUserId: CLIENT_A });
    expect(otherOwner).toMatchObject({ ok: true, granted: false });
    db = world({ manager_phone_verified_at: null });
    expect(await ensureTeamNoticeScopedSmsConsent(db as never, scope)).toMatchObject({ ok: true, granted: false });
    expect(state.consents).toHaveLength(1);
  });
});

describe("alerts for service workspaces", () => {
  it("one line per event, naming the workspace, from the notice's own words", () => {
    const text = composeServiceAlertText({ workspaceName: "1. Ambika", subject: "Tour requested", text: "Dana wants to see 5259 Brooklyn Saturday at 2" });
    expect(text).toBe("PropLane Ambika: Tour requested - Dana wants to see 5259 Brooklyn Saturday at 2");
    expect(composeServiceAlertText({ workspaceName: "2. Vinod", subject: "Service filed", text: "Service filed" })).toBe("PropLane Vinod: Service filed");
    expect(composeServiceAlertText({ workspaceName: "X", subject: "S", text: "y".repeat(500) }).length).toBeLessThanOrEqual(300);
    expect(serviceWorkspaceLabel("2. Vinod")).toBe("Vinod");
    expect(serviceWorkspaceLabel("Plain")).toBe("Plain");
  });

  it("the owner's, a teammate's and the Team line of one event collapse to one key", () => {
    const base = "action-event:evt-9";
    const keys = [`${base}:manager`, `${base}:team`, base].map((k) => serviceAlertEventKey(k, "fallback"));
    expect(new Set(keys).size).toBe(1);
    expect(serviceAlertEventKey("action-event:evt-10:manager", "f")).not.toBe(keys[0]);
  });

  it("a notice of a service workspace is texted once; a notice of any other workspace never is", async () => {
    const notice = { subject: "New application", text: "Priya applied for 5259 Brooklyn", category: "applications", idempotencyKey: "action-event:e1:manager" };
    expect(await alertServiceManagerFromNotice(db as never, { ...notice, workspaceId: WS_A })).toBe("sent");
    expect(await alertServiceManagerFromNotice(db as never, { ...notice, workspaceId: WS_A, idempotencyKey: "action-event:e1:team" })).toBe("sent");
    expect(state.texts).toHaveLength(2);
    expect(state.texts[0]!.dedupeKey).toBe(state.texts[1]!.dedupeKey);
    expect(state.texts[0]).toMatchObject({ to: MANAGER_PHONE, text: "PropLane Ambika: New application - Priya applied for 5259 Brooklyn" });
    state.texts = [];
    expect(await alertServiceManagerFromNotice(db as never, { ...notice, workspaceId: WS_P })).toBe("skipped");
    expect(await alertServiceManagerFromNotice(db as never, { ...notice, workspaceId: WS_SO })).toBe("skipped");
    expect(await alertServiceManagerFromNotice(db as never, { ...notice, workspaceId: null })).toBe("skipped");
    expect(state.texts).toHaveLength(0);
  });

  it("digests and reminder confirmations are quiet; a payment event is not", async () => {
    const base = { workspaceId: WS_V, subject: "Rent", text: "Rent received $900" };
    expect(await alertServiceManagerFromNotice(db as never, { ...base, category: "attention_digest" })).toBe("skipped");
    expect(await alertServiceManagerFromNotice(db as never, { ...base, category: "payment_reminders", threadType: "agent_notice" })).toBe("skipped");
    expect(await alertServiceManagerFromNotice(db as never, { ...base, category: "payment_reminders", threadType: "action_event", idempotencyKey: "action-event:pay-1:manager" })).toBe("sent");
    expect(await alertServiceManagerFromNotice(db as never, { ...base, subject: "Stay requested", text: "Short stay request, 3 nights", category: "leasing", idempotencyKey: "action-event:stay-1:manager" })).toBe("sent");
  });

  it("no verified phone, no alert", async () => {
    db = world({ manager_phone_verified_at: null });
    expect(await alertServiceManagerFromNotice(db as never, { workspaceId: WS_A, subject: "x", text: "y" })).toBe("skipped");
    expect(state.texts).toHaveLength(0);
  });

  it("a new inquiry on the PropLane line is texted once per phone per day, by last four digits", async () => {
    const now = new Date("2026-10-19T20:00:00Z");
    expect(await alertServiceManagerOfInquiry(db as never, { phone: "+14255550123", body: "Hi is the Brooklyn room open for 3 nights in November?", now })).toBe("sent");
    expect(state.texts[0]!.text).toContain("***0123");
    expect(state.texts[0]!.text).not.toContain("425");
    await alertServiceManagerOfInquiry(db as never, { phone: "+14255550123", body: "again", now });
    expect(state.texts[1]!.dedupeKey).toBe(state.texts[0]!.dedupeKey);
  });
});

describe("recognising the service manager on the PropLane line", () => {
  const args = (over: Record<string, string> = {}) => ({ managerId: SO, fromPhone: MANAGER_PHONE, toPhone: "+12066781909", ...over });

  it("the verified phone on the PropLane line is the service manager, acting as the service owner", async () => {
    const found = await recognizeServiceManagerInbound(db as never, args());
    expect(found).toMatchObject({ serviceManager: true, workNumberOwnerId: SO, actorUserId: SO, workNumber: "+12066781909" });
  });

  it("the same phone texting any other number is not the service manager", async () => {
    expect(await recognizeServiceManagerInbound(db as never, args({ managerId: CLIENT_A, toPhone: "+12065550999" }))).toBeNull();
    expect(await recognizeServiceManagerInbound(db as never, args({ toPhone: "+12065550999" }))).toBeNull();
  });

  it("another phone, or an unverified one, is not the service manager", async () => {
    expect(await recognizeServiceManagerInbound(db as never, args({ fromPhone: "+12065550000" }))).toBeNull();
    db = world({ manager_phone_verified_at: null });
    expect(await recognizeServiceManagerInbound(db as never, args())).toBeNull();
  });
});

describe("which service workspace", () => {
  it("asks 'Is this about Ambika or Vinod?' once, then remembers the pick; a name in the text switches", async () => {
    const workspaces = (await listServiceWorkspaceRefs(db as never))!;
    expect(workspaces.map((w) => w.name)).toEqual(["1. Ambika", "2. Vinod"]);
    const ask = await pickServiceWorkspace(db as never, { fromPhone: MANAGER_PHONE, body: "any tours this week?", workspaces });
    expect(ask).toEqual({ kind: "ask", question: "Is this about Ambika or Vinod?" });
    const answered = await pickServiceWorkspace(db as never, { fromPhone: MANAGER_PHONE, body: "Vinod", workspaces });
    expect(answered).toMatchObject({ kind: "chosen", workspace: { id: WS_V } });
    const sticky = await pickServiceWorkspace(db as never, { fromPhone: MANAGER_PHONE, body: "and rent?", workspaces });
    expect(sticky).toMatchObject({ kind: "chosen", workspace: { id: WS_V } });
    const named = await pickServiceWorkspace(db as never, { fromPhone: MANAGER_PHONE, body: "what is open at Ambika", workspaces });
    expect(named).toMatchObject({ kind: "chosen", workspace: { id: WS_A } });
  });

  it("one workspace is not a question, none is none, and only service workspaces are listed", async () => {
    const workspaces = (await listServiceWorkspaceRefs(db as never))!;
    expect(workspaces.some((w) => w.id === WS_P || w.id === WS_SO)).toBe(false);
    expect(await pickServiceWorkspace(db as never, { fromPhone: MANAGER_PHONE, body: "hi", workspaces: [workspaces[0]!] })).toMatchObject({ kind: "chosen" });
    expect(await pickServiceWorkspace(db as never, { fromPhone: MANAGER_PHONE, body: "hi", workspaces: [] })).toEqual({ kind: "none" });
  });
});

describe("the agent context over a service workspace", () => {
  it("is the client's data under the service owner as actor, the full (owner) catalog, scoped to that workspace's houses only", async () => {
    const workspaces = (await listServiceWorkspaceRefs(db as never))!;
    const ambika = workspaces.find((w) => w.id === WS_A)!;
    const built = await buildServiceManagerAgentContext(db as never, { serviceOwnerId: SO, workspace: ambika });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.ctx.landlordId).toBe(CLIENT_A);
    expect(built.ctx.userId).toBe(SO);
    expect(built.ctx.managerSmsAccess?.mode).toBe("owner");
    expect(built.ctx.workspace?.id).toBe(WS_A);
    expect(built.ctx.workspace?.propertyIds.sort()).toEqual(["prop-a1", "prop-a2"]);
    expect(built.ctx.workspace?.propertyIds).not.toContain("prop-plain");
    expect(built.ctx.managerSmsAccess?.dataOwnerIds).toEqual([CLIENT_A]);
  });

  it("writes are allowed: the managed-client view-only lock is the client's, never the service owner's", async () => {
    expect(await isManagedReadOnly(db as never, SO, WS_A)).toBe(false);
    expect(await isManagedReadOnly(db as never, CLIENT_A, WS_A)).toBe(true);
  });

  it("refuses a workspace that does not belong to its stated owner", async () => {
    const built = await buildServiceManagerAgentContext(db as never, { serviceOwnerId: SO, workspace: { id: WS_V, name: "2. Vinod", ownerUserId: CLIENT_A, isDefault: true } });
    expect(built.ok).toBe(false);
  });
});
