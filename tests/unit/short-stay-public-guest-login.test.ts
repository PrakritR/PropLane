import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: vi.fn(async () => ({})) }));
const enqueueOwnerSms = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...args) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/room-availability-range.server", () => ({
  roomAvailabilityForRange: async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: true }] }),
}));
const ensureGuestLogin = vi.fn();
vi.mock("@/lib/short-stay/guest-login.server", () => ({ ensureGuestLogin: (...args: unknown[]) => ensureGuestLogin(...args) }));

import { submitShortStayRequest } from "@/lib/short-stay-request.server";
import { PROPERTY, TODAY, seedShortStayDb } from "../helpers/short-stay-seed";

const request = { propertyId: PROPERTY, roomId: "r1", checkIn: "2026-10-20", checkOut: "2026-10-22", guests: 1, name: "Priya Shah", phone: "+12065550142", email: "", honeypot: "" };

beforeEach(() => vi.clearAllMocks());

describe("a public request from a guest with no login", () => {
  it("creates the login, stamps it on the hold and puts the one-time link in the confirmation text", async () => {
    ensureGuestLogin.mockResolvedValue({ userId: "guest-new", loginEmail: "guest.12065550142@import.proplane.local", created: true, signInUrl: "https://proplane.ai/auth/confirm?token_hash=abc&type=magiclink" });
    const db = seedShortStayDb();
    expect(await submitShortStayRequest(db as never, request, { today: TODAY })).toEqual({ ok: true });
    expect(ensureGuestLogin).toHaveBeenCalledWith(expect.anything(), { name: "Priya Shah", phone: "+12065550142", email: "" });
    const hold = db.tables.portal_schedule_records!.at(-1)!.row_data as { residentUserId: string; bookingStatus: string; stayDetails: { source: string; holdExpiresAt: string } };
    expect(hold).toMatchObject({ residentUserId: "guest-new", bookingStatus: "hold", stayDetails: { source: "public_short_stay_request" } });
    expect(hold.stayDetails.holdExpiresAt).toBeTruthy();
    const body = (enqueueOwnerSms.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain("Got it, Priya");
    expect(body).toContain("Sign in to see your stays: https://proplane.ai/auth/confirm?token_hash=abc&type=magiclink");
  });

  it("still saves the hold and texts when no login could be made (no link, nothing lost)", async () => {
    ensureGuestLogin.mockResolvedValue(null);
    const db = seedShortStayDb();
    expect(await submitShortStayRequest(db as never, request, { today: TODAY })).toEqual({ ok: true });
    const hold = db.tables.portal_schedule_records!.at(-1)!.row_data as Record<string, unknown>;
    expect(hold.residentUserId).toBeUndefined();
    expect((enqueueOwnerSms.mock.calls[0]![0] as { body: string }).body).not.toContain("Sign in");
  });

  it("a login service failure never undoes the request", async () => {
    ensureGuestLogin.mockRejectedValue(new Error("auth down"));
    const db = seedShortStayDb();
    expect(await submitShortStayRequest(db as never, request, { today: TODAY })).toEqual({ ok: true });
    expect(db.tables.portal_schedule_records).toHaveLength(1);
  });
});
