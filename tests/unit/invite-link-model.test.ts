import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVITE_LINK_EXPIRY,
  DEFAULT_INVITE_LINK_USES,
  expiryIsoForOption,
  inviteLinkUnusableMessage,
  inviteLinkUnusableReason,
  inviteLinkUrl,
  maxUsesForOption,
  normalizeInviteLinkKind,
} from "@/lib/invite-links/invite-link-model";

/**
 * An invite link is a bearer credential: whoever holds the URL can act on it.
 * Everything here is about the two limits that make that safe to hand out — an
 * expiry and a use budget — and about neither of them being bypassable by a
 * value someone types into a request.
 */
const NOW = new Date("2026-09-06T12:00:00.000Z");

describe("invite link expiry", () => {
  it("turns a chosen window into a real timestamp", () => {
    expect(expiryIsoForOption("30m", NOW)).toBe("2026-09-06T12:30:00.000Z");
    expect(expiryIsoForOption("1d", NOW)).toBe("2026-09-07T12:00:00.000Z");
    expect(expiryIsoForOption("30d", NOW)).toBe("2026-10-06T12:00:00.000Z");
  });

  it("supports a link that never expires, as a deliberate choice", () => {
    expect(expiryIsoForOption("never", NOW)).toBeNull();
  });

  it("falls back to the default rather than to no expiry", () => {
    // A junk value must never be the way to mint a permanent link.
    expect(expiryIsoForOption("evil", NOW)).toBe(expiryIsoForOption(DEFAULT_INVITE_LINK_EXPIRY, NOW));
    expect(expiryIsoForOption(undefined, NOW)).not.toBeNull();
  });
});

describe("invite link use budget", () => {
  it("maps the offered options", () => {
    expect(maxUsesForOption("1")).toBe(1);
    expect(maxUsesForOption("25")).toBe(25);
    expect(maxUsesForOption("unlimited")).toBeNull();
  });

  it("falls back to single use, the narrowest option", () => {
    expect(maxUsesForOption("999999")).toBe(maxUsesForOption(DEFAULT_INVITE_LINK_USES));
    expect(maxUsesForOption("999999")).toBe(1);
  });
});

describe("whether a link can still be redeemed", () => {
  it("accepts a live link", () => {
    expect(
      inviteLinkUnusableReason({ expiresAt: "2026-09-07T00:00:00.000Z", maxUses: 5, usedCount: 2 }, NOW),
    ).toBeNull();
  });

  it("reports revoked before anything else", () => {
    // Someone made a decision; that is the honest thing to say.
    expect(
      inviteLinkUnusableReason(
        { revokedAt: "2026-09-05T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z", maxUses: 1, usedCount: 9 },
        NOW,
      ),
    ).toBe("revoked");
  });

  it("treats the expiry instant itself as expired", () => {
    expect(inviteLinkUnusableReason({ expiresAt: NOW.toISOString() }, NOW)).toBe("expired");
  });

  it("stops a one-time link at one use", () => {
    expect(inviteLinkUnusableReason({ maxUses: 1, usedCount: 0 }, NOW)).toBeNull();
    expect(inviteLinkUnusableReason({ maxUses: 1, usedCount: 1 }, NOW)).toBe("exhausted");
  });

  it("never exhausts an unlimited link", () => {
    expect(inviteLinkUnusableReason({ maxUses: null, usedCount: 10_000 }, NOW)).toBeNull();
  });

  it("says what to do next rather than just refusing", () => {
    for (const reason of ["revoked", "expired", "exhausted"] as const) {
      expect(inviteLinkUnusableMessage(reason)).toContain("Ask for a new one");
    }
  });
});

describe("invite link identity", () => {
  it("only honours the two real kinds", () => {
    expect(normalizeInviteLinkKind("vendor")).toBe("vendor");
    expect(normalizeInviteLinkKind("manager")).toBe("manager");
    // `kind` arrives in a request body; anything else is not a third kind.
    expect(normalizeInviteLinkKind("admin")).toBe("manager");
    expect(normalizeInviteLinkKind(undefined)).toBe("manager");
  });

  it("puts the token in the path and escapes it", () => {
    expect(inviteLinkUrl("https://prop-lane.space", "abc123")).toBe(
      "https://prop-lane.space/invite/abc123",
    );
    expect(inviteLinkUrl("https://prop-lane.space/", "a/b?c")).toBe(
      "https://prop-lane.space/invite/a%2Fb%3Fc",
    );
  });
});
