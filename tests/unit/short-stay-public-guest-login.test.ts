import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: vi.fn(async () => ({})) }));
const enqueueOwnerSms = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...args) }));
const postResendEmail = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: (...args: unknown[]) => postResendEmail(...args) }));
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

const SIGN_IN = "https://proplane.ai/auth/confirm?token_hash=abc&type=magiclink";
const textedBody = () => (enqueueOwnerSms.mock.calls[0]![0] as { body: string }).body;
const emailedText = () => ((postResendEmail.mock.calls[0]![0] as { payload: { text: string } }).payload.text);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
});

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

describe("the one-time sign-in link only travels to the phone that keyed it", () => {
  it("a stranger's email never receives the link, and the hold is not claimed by that account", async () => {
    // `ensureGuestLogin` matched an EXISTING account on the typed phone; the typed email is someone else's.
    ensureGuestLogin.mockResolvedValue({ userId: "victim-1", loginEmail: "victim@example.com", created: false, signInUrl: SIGN_IN });
    const db = seedShortStayDb();
    expect(await submitShortStayRequest(db as never, { ...request, email: "attacker@example.com" }, { today: TODAY })).toEqual({ ok: true });
    expect(textedBody()).toContain(SIGN_IN);
    expect(emailedText()).not.toContain("token_hash");
    expect(emailedText()).not.toContain("Sign in");
    const hold = db.tables.portal_schedule_records!.at(-1)!.row_data as Record<string, unknown>;
    expect(hold.residentUserId).toBeUndefined();
  });

  it("never emails the link even when the typed address equals that account's login; the hold is still claimed", async () => {
    ensureGuestLogin.mockResolvedValue({ userId: "guest-2", loginEmail: "priya@example.com", created: false, signInUrl: SIGN_IN });
    const db = seedShortStayDb();
    expect(await submitShortStayRequest(db as never, { ...request, email: "Priya@example.com" }, { today: TODAY })).toEqual({ ok: true });
    expect(textedBody()).toContain(SIGN_IN);
    expect(emailedText()).not.toContain("token_hash");
    expect(emailedText()).not.toContain("Sign in");
    expect((db.tables.portal_schedule_records!.at(-1)!.row_data as Record<string, unknown>).residentUserId).toBe("guest-2");
  });

  it("a brand-new guest's link is texted only: the typed email gets an informational confirmation without it", async () => {
    ensureGuestLogin.mockResolvedValue({ userId: "guest-new", loginEmail: "guest.12065550142@import.proplane.local", created: true, signInUrl: SIGN_IN });
    const db = seedShortStayDb();
    expect(await submitShortStayRequest(db as never, { ...request, email: "victim@example.com" }, { today: TODAY })).toEqual({ ok: true });
    expect(textedBody()).toContain(SIGN_IN);
    expect(postResendEmail).toHaveBeenCalledTimes(1);
    expect(emailedText()).toContain("Got it, Priya");
    expect(emailedText()).not.toContain("token_hash");
    expect(emailedText()).not.toContain("Sign in");
    // The typed email stays on the stay for the host; it is not the login.
    const hold = db.tables.portal_schedule_records!.at(-1)!.row_data as Record<string, unknown>;
    expect(hold.residentEmail).toBe("victim@example.com");
    expect(hold.residentUserId).toBe("guest-new");
  });
});
