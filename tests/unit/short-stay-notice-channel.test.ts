import { describe, expect, it } from "vitest";
import { guestStayPortalNotice, noticeChannelFor, type PortalNoticeKind } from "@/lib/short-stay/notice-channel";
import { checkStayApplication, normalizeStayApplication, stayApplicationFacts } from "@/lib/short-stay/stay-application";
import { carryGuestStayFields } from "@/lib/short-stay/guest-stays";

describe("noticeChannelFor: where a request was made decides how it is answered", () => {
  it("a stay made in the portal is answered in the portal", () => {
    expect(noticeChannelFor({ stayDetails: { source: "guest_portal" } })).toBe("portal");
  });
  it("a stay made by text, or by the legacy public card, keeps today's text behaviour", () => {
    expect(noticeChannelFor({ stayDetails: { source: "sms_short_stay" } })).toBe("sms");
    expect(noticeChannelFor({ stayDetails: { source: "public_short_stay_request" } })).toBe("sms");
  });
  it("an older row, a manager-typed row or anything unreadable is sms (what it always did)", () => {
    expect(noticeChannelFor({})).toBe("sms");
    expect(noticeChannelFor(null)).toBe("sms");
    expect(noticeChannelFor({ stayDetails: { source: "Direct" } })).toBe("sms");
  });
  it("applications and tours carry the same fact as `noticeChannel` (or `channel`); the lead-source column is never read", () => {
    expect(noticeChannelFor({ noticeChannel: "portal" })).toBe("portal");
    expect(noticeChannelFor({ source_channel: "resident_portal" })).toBe("sms");
    expect(noticeChannelFor({ channel: "sms" })).toBe("sms");
    // An explicit channel wins over a source.
    expect(noticeChannelFor({ noticeChannel: "sms", stayDetails: { source: "guest_portal" } })).toBe("sms");
  });
});

describe("the portal notices (requested, confirmed, approved, declined, expired, unpaid)", () => {
  const stay = { roomLabel: "Attic Nook", propertyLabel: "Cedar Court", checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3, total: 420 };
  const kinds: PortalNoticeKind[] = ["requested", "confirmed", "approved", "declined", "expired", "unpaid_released"];

  it.each(kinds)("%s: /resident links only, no pay link to a texted page, no phone link, no long dash", (kind) => {
    const { subject, text } = guestStayPortalNotice(kind, stay);
    expect(subject).toContain("Attic Nook at Cedar Court");
    expect(text).toContain("https://proplane.ai/resident/stays/upcoming");
    for (const link of text.match(/https?:\/\/\S+/g) ?? []) expect(new URL(link).pathname.startsWith("/resident/")).toBe(true);
    expect(text).not.toMatch(/\/l\/|sms:|tel:|[–—]/);
  });

  it("approval and confirmation say where to pay: Payments, within the 24 hours", () => {
    for (const kind of ["approved", "confirmed"] as const) {
      expect(guestStayPortalNotice(kind, stay).text).toContain("Pay $420 in Payments within 24 hours to keep it: https://proplane.ai/resident/payments/pending");
    }
    expect(guestStayPortalNotice("declined", stay).text).not.toContain("Payments");
  });
});

describe("the booking application's answers", () => {
  const good = { purpose: "work", message: "  Landing late.  ", guestNames: ["Sam Lee"], rulesAgreed: true };
  const now = new Date("2026-10-20T10:00:00Z");

  it("needs a purpose, the house-rules agreement and a name for every other guest", () => {
    expect(checkStayApplication(good, 2, now)).toEqual({ ok: true, application: { purpose: "work", message: "Landing late.", guestNames: ["Sam Lee"], rulesAgreedAt: now.toISOString() } });
    expect(checkStayApplication({ ...good, rulesAgreed: false }, 2)).toMatchObject({ ok: false });
    expect(checkStayApplication({ ...good, purpose: "party" }, 2)).toMatchObject({ ok: false });
    expect(checkStayApplication({ ...good, guestNames: [] }, 2)).toMatchObject({ ok: false, error: "Add the other guest's name." });
    expect(checkStayApplication({ ...good, guestNames: ["", ""] }, 3)).toMatchObject({ ok: false });
    expect(checkStayApplication({ ...good, guestNames: [] }, 1)).toMatchObject({ ok: true });
    expect(checkStayApplication(null, 1)).toMatchObject({ ok: false });
  });

  it("reads back what was stored and draws it for the host", () => {
    const stored = normalizeStayApplication({ purpose: "work", message: "Hi", guestNames: ["Sam Lee"], rulesAgreedAt: "2026-10-20T10:00:00Z" })!;
    expect(stayApplicationFacts(stored)).toEqual([
      { label: "Purpose", value: "Work or business" },
      { label: "Also staying", value: "Sam Lee" },
      { label: "Message", value: "Hi" },
      { label: "House rules", value: "Agreed" },
    ]);
    expect(normalizeStayApplication({ purpose: "nope" })).toBeNull();
    expect(normalizeStayApplication(undefined)).toBeNull();
  });

  it("a manager's save carries the application forward (it is server-owned)", () => {
    const application = { purpose: "work", message: "", guestNames: [], rulesAgreedAt: "2026-10-20T10:00:00Z" };
    const merged = carryGuestStayFields(
      { residentUserId: "u1", stayDetails: { source: "guest_portal", application } },
      { stayDetails: { linen: "Requested" } },
    );
    expect((merged!.stayDetails as { application: unknown }).application).toEqual(application);
  });
});
