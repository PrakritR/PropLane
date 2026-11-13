// What a PropLane-managed workspace's client owner sees and hears, pinned where the code is one large private function
// (the inbound pipeline, the action-event bus, the notice spine). The behaviour of each decision is unit-tested in
// service-alerts-routing.test.ts and service-inbound-alert-digest.test.ts.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const recorded: Array<Record<string, unknown>> = [];
vi.mock("@/lib/sms-consent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sms-consent")>("@/lib/sms-consent");
  return {
    ...actual,
    readScopedSmsConsentState: async () => ({ ok: true, state: "none" }),
    recordScopedSmsConsent: async (_db: unknown, _phone: string, input: Record<string, unknown>) => (recorded.push(input), { ok: true }),
  };
});

import { ensureTeamNoticeScopedSmsConsent, ALERT_PHONE_SMS_PURPOSE, SERVICE_ALERT_PHONE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";

const pipeline = readFileSync("src/lib/sms/inbound-pipeline.server.ts", "utf8");
const bus = readFileSync("src/lib/action-events.server.ts", "utf8");
const spine = readFileSync("src/lib/co-manager-notification-recipients.server.ts", "utf8");
const visibility = readFileSync("src/lib/communication/conversation-visibility.server.ts", "utf8");
const projectionList = readFileSync("src/lib/sms/sms-projection-inbox.server.ts", "utf8");

const scope = (purpose: string, managerUserId: string, recipientPhone: string) => ({
  managerUserId, recipientPhone, purpose, sendClass: "transactional" as const, conversationKey: null, messagingServiceSid: "MG1", campaignSid: "CM1",
}) as never;

beforeEach(() => { recorded.length = 0; });

describe("alert-phone consent (why the captain's 7 AM texts never left)", () => {
  const db = () => createFakeDb({
    portal_workspaces: [{ id: "ws-amb", owner_user_id: "amb", is_service: true }, { id: "ws-self", owner_user_id: "self", is_service: false }],
    workspace_work_number_recipients: [
      { owner_user_id: "amb", phone: "+15103098345", created_at: "2026-11-04T01:18:09Z" },
      { owner_user_id: "self", phone: "+12065550111", created_at: "2026-11-04T01:18:09Z" },
    ],
  }) as never;

  it("the service purpose is consented by the listing on a managed workspace, and records its evidence", async () => {
    expect(await ensureTeamNoticeScopedSmsConsent(db(), scope(SERVICE_ALERT_PHONE_SMS_PURPOSE, "svc-owner", "(510) 309-8345"))).toEqual({ ok: true, granted: true });
    expect(recorded[0]).toMatchObject({ source: "owner_listed_alert_phone", eventType: "granted" });
  });
  it("a number nobody listed on a managed workspace is not consented", async () => {
    expect(await ensureTeamNoticeScopedSmsConsent(db(), scope(SERVICE_ALERT_PHONE_SMS_PURPOSE, "svc-owner", "+12065550999"))).toEqual({ ok: true, granted: false });
    // a self-serve owner's listing never vouches for a PropLane-sent alert
    expect(await ensureTeamNoticeScopedSmsConsent(db(), scope(SERVICE_ALERT_PHONE_SMS_PURPOSE, "svc-owner", "+12065550111"))).toEqual({ ok: true, granted: false });
    expect(recorded).toHaveLength(0);
  });
  it("an owner's own purpose is consented only by THAT owner's listing", async () => {
    expect(await ensureTeamNoticeScopedSmsConsent(db(), scope(ALERT_PHONE_SMS_PURPOSE, "self", "+12065550111"))).toEqual({ ok: true, granted: true });
    expect(await ensureTeamNoticeScopedSmsConsent(db(), scope(ALERT_PHONE_SMS_PURPOSE, "self", "+15103098345"))).toEqual({ ok: true, granted: false });
  });
  it("an unreadable listing is a retryable error, never a yes", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "down" } }) }), in: () => ({ not: () => ({ limit: async () => ({ data: null, error: { message: "down" } }) }) }) }) }) } as never;
    expect(await ensureTeamNoticeScopedSmsConsent(broken, scope(ALERT_PHONE_SMS_PURPOSE, "self", "+12065550111"))).toMatchObject({ ok: false });
  });
});

describe("owner text to the work number is a conversation from the owner, not the Assistant", () => {
  it("the managed owner's text is projected as the owner's own, answered only for a clear owner question, and never reaches the manager agent", () => {
    const branch = pipeline.indexOf('mark("route:managed-owner")');
    expect(branch).toBeGreaterThan(-1);
    expect(pipeline.indexOf('mark("route:manager")')).toBeLessThan(branch);
    // before the dispatch reply, the Team chat route and the agent turn
    expect(branch).toBeLessThan(pipeline.indexOf("handleManagerDispatchReply(db"));
    expect(branch).toBeLessThan(pipeline.indexOf("runManagerSmsAgentTurn(db"));
    const body = pipeline.slice(branch, branch + 1800);
    expect(body).toMatch(/role: "manager"/);
    expect(body).toMatch(/counterpartyUserId: managerInbound\.actorUserId/);
    expect(body).toMatch(/handleOwnerLine/);
    expect(body).not.toMatch(/appendSmsTurnToManagerAssistantThread/);
    expect(pipeline).toMatch(/!serviceManager && \(await isManagedWorkspaceOwnerActor\(db, workspaceId \?\? null, managerInbound\.actorUserId\)/);
  });
  it("every inbound text to a managed workspace or the PropLane line raises the alert after the response, and the raw forwards are not a second text", () => {
    expect(pipeline).toMatch(/after\(async \(\) => \{[\s\S]*?await import\("@\/lib\/one-number\/inbound-alert\.server"\)/);
    expect((pipeline.match(/!managedWorkspaceText/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(readFileSync("src/lib/sms/process-accepted-inbound.server.ts", "utf8")).toMatch(/alertOpsOfInboundText\(db, \{ workspaceId: null/);
  });
});

describe("the owner is not a conversation until she texts", () => {
  it("a routine system notice to a managed owner writes no one-on-one thread and no text; an urgent one texts but opens no thread", () => {
    expect(bus).toMatch(/recipientOwnsManagedWorkspace\(db, input\.managerUserId\.trim\(\), input\.propertyId \?\? null\)/);
    expect(bus).toMatch(/!input\.urgent &&\s*\(await recipientOwnsManagedWorkspace/);
    expect(bus).toMatch(/\{ suppressInbox: true \}/);
  });
  it("the Communication list hides (never deletes) system-only owner threads, email and SMS", () => {
    expect(visibility).toMatch(/isSystemOnlyOwnerThread\(record, owner\)/);
    expect(projectionList).toMatch(/isOutboundOnlyOwnerSms\(/);
  });
});

describe("volume: one text per event per person", () => {
  it("the notice spine skips the client owner's copy of a routine event, keeps financials and urgent, and never posts a per-resident reminder line", () => {
    expect(spine).toMatch(/managedWorkspace && !urgent && input\.category === "payment_reminders"\) return/);
    expect(spine).toMatch(/!managedWorkspace \|\| urgent \|\| input\.module === "payments" \|\| input\.module === "financials"/);
    expect(spine).toMatch(/if \(isOwner && !ownerHearsIt\) continue/);
    expect(spine).toMatch(/scope: "seat_emails"/);
  });
});
