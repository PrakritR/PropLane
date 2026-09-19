import { describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  buildApplicationSubmittedManagerBody,
  shouldNotifyManagerOfApplicationSubmit,
} from "@/lib/application-submitted-notification.server";
import { IN_PROGRESS_APPLICATION_STAGE } from "@/lib/rental-application/in-progress-application";
import { buildLeaseReadyForResidentMessage } from "@/lib/resident-portal-login-copy";

function submittedRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-TEST-1",
    name: "SIVA NARENDRA CHERUKU",
    email: "narendracheruku18@gmail.com",
    property: "4709A 8th Ave NE",
    propertyId: "prop-1",
    managerUserId: "mgr-1",
    bucket: "pending",
    stage: "Submitted",
    application: {
      propertyId: "prop-1",
      phone: "206-555-0100",
      consentCredit: true,
    } as DemoApplicantRow["application"],
    ...overrides,
  };
}

describe("application-submitted-notification", () => {
  it("buildApplicationSubmittedManagerBody includes vital review fields", () => {
    const body = buildApplicationSubmittedManagerBody({
      row: submittedRow(),
      origin: "https://prop-lane.space",
    });
    expect(body).toContain("SIVA NARENDRA CHERUKU");
    expect(body).toContain("narendracheruku18@gmail.com");
    expect(body).toContain("206-555-0100");
    expect(body).toContain("PROPLANE-TEST-1");
    expect(body).toContain("https://prop-lane.space/portal/applications");
    expect(body).toContain("https://prop-lane.space/portal/communication/active");
    expect(body).toContain("4709A 8th Ave NE");
  });

  it("shouldNotifyManagerOfApplicationSubmit fires only on first submit", () => {
    const draft: DemoApplicantRow = submittedRow({
      stage: IN_PROGRESS_APPLICATION_STAGE,
    });
    const submitted = submittedRow();
    expect(shouldNotifyManagerOfApplicationSubmit(null, submitted)).toBe(true);
    expect(shouldNotifyManagerOfApplicationSubmit(draft, submitted)).toBe(true);
    expect(shouldNotifyManagerOfApplicationSubmit(submitted, submitted)).toBe(false);
    expect(shouldNotifyManagerOfApplicationSubmit(draft, draft)).toBe(false);
  });

  it("lease-ready resident message includes sign-in guidance (communication email parity)", () => {
    const body = buildLeaseReadyForResidentMessage({
      residentName: "SIVA",
      residentEmail: "narendracheruku18@gmail.com",
      unit: "4709A 8th Ave NE · 10 rooms",
      variant: "send",
    });
    expect(body).toContain("How to sign in to PropLane");
    expect(body).toContain("narendracheruku18@gmail.com");
    expect(body).toContain("Continue with Google");
    expect(body).toContain("Leases in the sidebar");
  });
});

describe("notifyManagerApplicationSubmitted", () => {
  it("writes manager inbox thread grouped by applicant email", async () => {
    vi.resetModules();
    vi.doMock("@/lib/co-manager-notification-recipients.server", () => ({
      resolvePropertyLeadRecipientIds: vi.fn(async () => ["mgr-1"]),
      resolveManagerRecipientProfiles: vi.fn(async () => [
        { userId: "mgr-1", email: "manager@test.com", phone: null },
      ]),
    }));
    vi.doMock("@/lib/portal-inbox-delivery", () => ({
      deliverPortalMessageThreadSide: vi.fn(async () => ({ action: "create", threadId: "t1" })),
    }));
    const { notifyManagerApplicationSubmitted } = await import("@/lib/application-submitted-notification.server");
    const upsert = vi.fn();
    const db = { from: vi.fn(() => ({ upsert })) } as never;
    const result = await notifyManagerApplicationSubmitted(db, submittedRow());
    expect(result.ok).toBe(true);
    const { deliverPortalMessageThreadSide } = await import("@/lib/portal-inbox-delivery");
    expect(deliverPortalMessageThreadSide).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otherPartyEmail: "narendracheruku18@gmail.com",
        participantEmail: "manager@test.com",
        messageId: "application-submitted-PROPLANE-TEST-1",
      }),
    );
  });

  it("binds each manager copy only to that recipient's exact prospect SMS conversation", async () => {
    vi.resetModules();
    vi.doMock("@/lib/co-manager-notification-recipients.server", () => ({
      resolvePropertyLeadRecipientIds: vi.fn(async () => ["mgr-1", "co-1"]),
      resolveManagerRecipientProfiles: vi.fn(async () => [
        { userId: "mgr-1", email: "manager@test.com", phone: null },
        { userId: "co-1", email: "co@test.com", phone: null },
      ]),
    }));
    vi.doMock("@/lib/manager-sms-messages.server", () => ({
      fetchManagerSmsConversations: vi.fn(async (_db: unknown, managerUserId: string) => ({
        workNumber: managerUserId === "mgr-1" ? "+12065550001" : "+12065550002",
        residents: managerUserId === "mgr-1" ? [{
          residentUserId: null,
          residentEmail: "narendracheruku18@gmail.com",
          name: "SIVA NARENDRA CHERUKU",
          phone: "+12065550100",
          propertyLabel: "4709A 8th Ave NE",
          counterpartyRole: "prospect",
          conversationKey: "mgr-1:prospect:+12065550100",
          ownerManagerUserId: "mgr-1",
          messages: [{
            id: "sms-1",
            direction: "inbound",
            body: "Can I tour?",
            fromPhone: "+12065550100",
            toPhone: "+12065550001",
            messageSid: "SM1",
            source: "work_number",
            createdAt: "2026-09-18T16:00:00.000Z",
          }],
        }] : [],
      })),
    }));
    const deliver = vi.fn(async () => ({ action: "create", threadId: "t1" }));
    vi.doMock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: deliver }));
    const { notifyManagerApplicationSubmitted } = await import("@/lib/application-submitted-notification.server");

    const result = await notifyManagerApplicationSubmitted({} as never, submittedRow());

    expect(result.ok).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      ownerUserId: "mgr-1",
      threadIdentity: expect.objectContaining({
        counterpartyRole: "prospect",
        smsConversationKey: "mgr-1:prospect:+12065550100",
      }),
    }));
    expect(deliver.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      ownerUserId: "co-1",
      threadIdentity: expect.not.objectContaining({ smsConversationKey: expect.anything() }),
    }));
  });

  it.each([
    ["different owner", "other-manager", "+12065550100", "+12065550001", "prospect"],
    ["different phone", "mgr-1", "+12065550999", "+12065550001", "prospect"],
    ["incompatible role", "mgr-1", "+12065550100", "+12065550001", "resident"],
  ] as const)("leaves a %s SMS relationship unbound while still delivering the applicant email", async (_case, owner, phone, workNumber, role) => {
    vi.resetModules();
    vi.doMock("@/lib/co-manager-notification-recipients.server", () => ({
      resolvePropertyLeadRecipientIds: vi.fn(async () => ["mgr-1"]),
      resolveManagerRecipientProfiles: vi.fn(async () => [
        { userId: "mgr-1", email: "manager@test.com", phone: null },
      ]),
    }));
    vi.doMock("@/lib/manager-sms-messages.server", () => ({
      fetchManagerSmsConversations: vi.fn(async () => ({
        workNumber,
        residents: [{
          residentUserId: null,
          residentEmail: "narendracheruku18@gmail.com",
          name: "SIVA NARENDRA CHERUKU",
          phone,
          propertyLabel: "4709A 8th Ave NE",
          counterpartyRole: role,
          conversationKey: `${owner}:prospect:${phone}`,
          ownerManagerUserId: owner,
          messages: [{
            id: "sms-mismatch",
            direction: "inbound",
            body: "Can I tour?",
            fromPhone: phone,
            toPhone: workNumber,
            messageSid: "SM-mismatch",
            source: "work_number",
            createdAt: "2026-09-18T16:00:00.000Z",
          }],
        }],
      })),
    }));
    const deliver = vi.fn(async () => ({ action: "create", threadId: "t1" }));
    vi.doMock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: deliver }));
    const { notifyManagerApplicationSubmitted } = await import("@/lib/application-submitted-notification.server");

    await notifyManagerApplicationSubmitted({} as never, submittedRow());

    expect(deliver).toHaveBeenCalledOnce();
    const delivery = deliver.mock.calls[0]?.[1] as { threadIdentity?: Record<string, unknown> };
    expect(delivery).toEqual(expect.objectContaining({
      otherPartyEmail: "narendracheruku18@gmail.com",
      threadIdentity: expect.objectContaining({
        managerUserId: "mgr-1",
        propertyId: "prop-1",
        counterpartyRole: "applicant",
      }),
    }));
    // The applicant notification must not borrow a native conversation whose
    // verified owner, phone, or role is incompatible with this recipient.
    expect(delivery.threadIdentity).not.toHaveProperty("smsConversationKey");
  });

  it("retains the native prospect relationship while applicant status changes in the directory", async () => {
    vi.resetModules();
    vi.doMock("@/lib/co-manager-notification-recipients.server", () => ({
      resolvePropertyLeadRecipientIds: vi.fn(async () => ["mgr-1"]),
      resolveManagerRecipientProfiles: vi.fn(async () => [
        { userId: "mgr-1", email: "manager@test.com", phone: null },
      ]),
    }));
    vi.doMock("@/lib/manager-sms-messages.server", () => ({
      fetchManagerSmsConversations: vi.fn(async () => ({
        workNumber: "+12065550001",
        residents: [{
          residentUserId: null,
          residentEmail: "narendracheruku18@gmail.com",
          name: "SIVA NARENDRA CHERUKU",
          phone: "+12065550100",
          propertyLabel: "4709A 8th Ave NE",
          counterpartyRole: "prospect",
          conversationKey: "mgr-1:prospect:+12065550100",
          ownerManagerUserId: "mgr-1",
          messages: [{
            id: "sms-prospect",
            direction: "inbound",
            body: "Can I tour?",
            fromPhone: "+12065550100",
            toPhone: "+12065550001",
            messageSid: "SM-prospect",
            source: "work_number",
            createdAt: "2026-09-18T16:00:00.000Z",
          }],
        }],
      })),
    }));
    const deliver = vi.fn(async () => ({ action: "append", threadId: "prospect-email" }));
    vi.doMock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: deliver }));
    const { notifyManagerApplicationSubmitted } = await import("@/lib/application-submitted-notification.server");

    await notifyManagerApplicationSubmitted({} as never, submittedRow());

    expect(deliver.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      threadIdentity: {
        managerUserId: "mgr-1",
        propertyId: "prop-1",
        propertyTitle: "4709A 8th Ave NE",
        counterpartyRole: "prospect",
        smsConversationKey: "mgr-1:prospect:+12065550100",
      },
    }));
  });
});
