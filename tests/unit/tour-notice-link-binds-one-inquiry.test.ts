/**
 * A tour notice's in-portal copy is authorized by the inquiry id alone, so that lookup must
 * match ONE inquiry and never a neighbour's.
 *
 * The id is server-minted (`createTourInquiry`), which is what makes this safe: an anonymous
 * caller cannot file a tour under an id that already carries somebody's `resident_tour_links`
 * row. This pins the other half — that a notice for inquiry B is not delivered to the resident
 * linked to inquiry A, whatever manager or property B names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

const appendResidentPropertyManagerInboxMessage = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/property-manager-inbox-thread.server", () => ({
  appendResidentPropertyManagerInboxMessage: (...args: unknown[]) => appendResidentPropertyManagerInboxMessage(...args),
  appendManagerPropertyLeadInboxMessage: vi.fn(),
}));
vi.mock("@/lib/sms/tour-sms-eligibility.server", () => ({
  resolveTourSmsEligibility: vi.fn(async () => ({ eligible: false, reason: "No phone on file." })),
}));
vi.mock("@/lib/resident-outbound-sms.server", () => ({ sendResidentOutboundSms: vi.fn() }));
vi.mock("@/lib/manager-notification-routing.server", () => ({ sendManagerNotificationSms: vi.fn() }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: vi.fn() }));
vi.mock("@/lib/application-lifecycle-sms.server", () => ({ resolveExistingApplicantConversation: vi.fn() }));
vi.mock("@/lib/observability/langfuse", () => ({
  traceSystemNotification: vi.fn(async (input: { run: () => Promise<unknown> }) => input.run()),
}));
vi.mock("@/lib/inbound-email/reply-address.server", () => ({ buildReplyAddress: vi.fn() }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolveManagerRecipientProfiles: vi.fn(),
  resolvePropertyLeadRecipientIds: vi.fn(),
}));

import { notifyTenantTourConfirmed } from "@/lib/tour-notification-delivery.server";

/** Only `LINKED_INQUIRY` has a resident link; the filter is honored, as PostgREST would. */
const LINKED_INQUIRY = "inquiry-with-a-linked-resident";
const LINKED_RESIDENT = "linked-resident-user";

function makeDb() {
  const links = [{ inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT }];
  return {
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        or: vi.fn(() => chain),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        }),
        limit: vi.fn(async () => {
          if (table !== "resident_tour_links") return { data: [], error: null };
          const matched = links.filter((row) =>
            Object.entries(filters).every(([column, value]) => (row as Record<string, unknown>)[column] === value),
          );
          return { data: matched.map((row) => ({ resident_user_id: row.resident_user_id })), error: null };
        }),
        maybeSingle: vi.fn(async () => ({
          data: table === "profiles" ? { id: "host", email: "host@example.com", full_name: "Host" } : null,
          error: null,
        })),
      };
      return chain;
    }),
  };
}

const inquiry = (id: string) => ({
  id,
  kind: "tour",
  name: "Guest",
  email: "guest@example.com",
  managerUserId: "host-user",
  propertyId: "property-x",
  propertyTitle: "Property X",
  proposedStart: "2026-09-10T16:00:00.000Z",
  proposedEnd: "2026-09-10T16:30:00.000Z",
});

const window = { start: "2026-09-10T16:00:00.000Z", end: "2026-09-10T16:30:00.000Z", managerUserId: "host-user" };

describe("a tour notice's inbox copy is bound to its own inquiry", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "email_1" }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
  });

  it("delivers the copy to the resident linked to THAT inquiry", async () => {
    const result = await notifyTenantTourConfirmed(makeDb() as never, null, inquiry(LINKED_INQUIRY), window);

    expect(appendResidentPropertyManagerInboxMessage).toHaveBeenCalledTimes(1);
    expect(appendResidentPropertyManagerInboxMessage.mock.calls[0]?.[1]).toMatchObject({ residentUserId: LINKED_RESIDENT });
    expect(result.inbox.sent).toBe(true);
  });

  it("does not deliver a different inquiry's notice to that resident", async () => {
    const result = await notifyTenantTourConfirmed(makeDb() as never, null, inquiry("some-other-inquiry"), window);

    expect(appendResidentPropertyManagerInboxMessage).not.toHaveBeenCalled();
    expect(result.inbox.sent).toBe(false);
    // Not a delivery failure either: the guest is simply not a linked resident.
    expect(result.inbox.error).toBeUndefined();
    // The email still goes out, so the guest hears about their own tour.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
