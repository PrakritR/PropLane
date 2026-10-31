/**
 * A tour notice's in-portal copy is authorized by the inquiry id plus its current property, so that
 * lookup must match ONE inquiry and never a neighbour's.
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

type LinkRow = { inquiry_id: string; resident_user_id: string; manager_user_id?: string; property_id?: string | null };

function makeDb(
  links: LinkRow[] = [{ inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT, property_id: "property-x" }],
  /** Injected failure of the links read: a failure, never an absence. */
  linksError: { code?: string; message: string } | null = null,
) {
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
          if (linksError) return { data: null, error: linksError };
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

  it("still delivers the copy after the tour is handed to a peer host", async () => {
    // The link was stored under the host the inquiry was FILED under; the tour was then handed to a
    // peer, so the notice's inquiry and window name a different manager than the link row does.
    const db = makeDb([
      { inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT, manager_user_id: "original-host", property_id: "property-x" },
    ]);
    const handedOff = { ...inquiry(LINKED_INQUIRY), managerUserId: "peer-host" };

    const result = await notifyTenantTourConfirmed(db as never, null, handedOff, { ...window, managerUserId: "peer-host" });

    expect(appendResidentPropertyManagerInboxMessage).toHaveBeenCalledTimes(1);
    expect(appendResidentPropertyManagerInboxMessage.mock.calls[0]?.[1]).toMatchObject({ residentUserId: LINKED_RESIDENT });
    expect(result.inbox.sent).toBe(true);
  });

  it("delivers nothing when two link rows claim the same inquiry", async () => {
    const db = makeDb([
      { inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT, property_id: "property-x" },
      { inquiry_id: LINKED_INQUIRY, resident_user_id: "second-claimant", property_id: "property-x" },
    ]);

    const result = await notifyTenantTourConfirmed(db as never, null, inquiry(LINKED_INQUIRY), window);

    expect(appendResidentPropertyManagerInboxMessage).not.toHaveBeenCalled();
    expect(result.inbox.sent).toBe(false);
    expect(result.inbox.error).toBeUndefined();
    // Neither claimant is told; the guest's own email still goes out.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not deliver to a resident whose link names the same inquiry id at a different property", async () => {
    // Historical caller-chosen ids are not unique across properties: the link must match the
    // inquiry's CURRENT property, not the id alone.
    const db = makeDb([{ inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT, property_id: "property-y" }]);

    const result = await notifyTenantTourConfirmed(db as never, null, inquiry(LINKED_INQUIRY), window);

    expect(appendResidentPropertyManagerInboxMessage).not.toHaveBeenCalled();
    expect(result.inbox.sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not deliver to a legacy link that records no property", async () => {
    const db = makeDb([{ inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT, property_id: null }]);

    const result = await notifyTenantTourConfirmed(db as never, null, inquiry(LINKED_INQUIRY), window);

    expect(appendResidentPropertyManagerInboxMessage).not.toHaveBeenCalled();
    expect(result.inbox.sent).toBe(false);
  });

  /**
   * A skip is REPORTED. It used to be indistinguishable from a success: every "no single link row
   * claims this inquiry at this property" answer — including the one an inquiry MOVED from P1 to P2
   * produces — came back as a bare `{ sent: false }` and the notice still read `ok: true`, so the
   * manager saw a clean send for every later confirm / reschedule / cancel the resident never got
   * in PropLane. A `reason` says so without failing the notice; only an unreadable binding is an
   * `error`, which does fail it.
   */
  it("names the reason a skipped in-app copy was not delivered", async () => {
    const moved = makeDb([{ inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT, property_id: "property-y" }]);
    const result = await notifyTenantTourConfirmed(moved as never, null, inquiry(LINKED_INQUIRY), window);
    expect(result.inbox.sent).toBe(false);
    expect(result.inbox.reason).toMatch(/no proplane account is linked to this tour at this property/i);
    // A skip is not a delivery FAILURE, so it never carries an error.
    expect(result.inbox.error).toBeUndefined();

    const contested = makeDb([
      { inquiry_id: LINKED_INQUIRY, resident_user_id: LINKED_RESIDENT, property_id: "property-x" },
      { inquiry_id: LINKED_INQUIRY, resident_user_id: "second-claimant", property_id: "property-x" },
    ]);
    const twoClaims = await notifyTenantTourConfirmed(contested as never, null, inquiry(LINKED_INQUIRY), window);
    expect(twoClaims.inbox.reason).toMatch(/several accounts claim this tour/i);
    expect(twoClaims.inbox.error).toBeUndefined();
  });

  it("reports an unreadable link as an ERROR, not as an absence", async () => {
    const db = makeDb([], { code: "57014", message: "canceling statement due to statement timeout" });

    const result = await notifyTenantTourConfirmed(db as never, null, inquiry(LINKED_INQUIRY), window);

    expect(appendResidentPropertyManagerInboxMessage).not.toHaveBeenCalled();
    expect(result.inbox.sent).toBe(false);
    expect(result.inbox.error).toMatch(/could not be read/i);
    expect(result.inbox.reason).toBeUndefined();
  });
});
