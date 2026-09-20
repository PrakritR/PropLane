import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { teamInvitePendingExpiryLabel } from "@/components/portal/pro-account-links-panel";

/**
 * Two defects that compounded (PRP-205): the panel always suppresses the server
 * notification, so choosing "Don't message team member" created a pending
 * invite with ZERO delivery while the UI said "Invite sent"; and
 * `account_link_invites` had no expiry, so that undelivered, unchased invite
 * stayed acceptable forever — and accepting one confers module access to the
 * assigned properties.
 */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 4);

describe("teamInvitePendingExpiryLabel", () => {
  it("counts down the remaining days", () => {
    expect(teamInvitePendingExpiryLabel(new Date(NOW + 10 * DAY).toISOString(), NOW)).toBe("Expires in 10 days");
  });

  it("says today rather than 'in 1 days'", () => {
    expect(teamInvitePendingExpiryLabel(new Date(NOW + DAY / 2).toISOString(), NOW)).toBe("Expires today");
  });

  it("says Expired once it has lapsed", () => {
    expect(teamInvitePendingExpiryLabel(new Date(NOW - DAY).toISOString(), NOW)).toBe("Expired");
  });

  it("says nothing for a row written before the column existed", () => {
    // Guessing a date for a legacy row would be worse than staying quiet.
    expect(teamInvitePendingExpiryLabel(null, NOW)).toBe("");
    expect(teamInvitePendingExpiryLabel("not a date", NOW)).toBe("");
  });
});

/**
 * PRP-205's fix lived in the old three-path invite chooser (mint on open, a
 * "Don't message team member" checkbox, a "Continue" step). That chooser is
 * gone — `docs/agents/co-manager-access.md` "The invite sheet
 * (`workspace-invite-sheet.tsx`) is the one manager invite surface" — and with
 * it the case this block used to guard: an invite created with nobody told.
 * The new sheet always attempts a real send (email/SMS/code) and never shows
 * a success toast without checking the result, so the equivalent guard now
 * lives on the sheet's send path. Behavioral coverage:
 * `tests/unit/workspace-invite-sheet.test.tsx` ("a failed text toasts the
 * real reason ... rather than pretending to send").
 */
describe("the invite sheet no longer claims a send succeeded when it failed", () => {
  const SHEET = readFileSync(
    join(process.cwd(), "src/components/portal/workspace-invite-sheet.tsx"),
    "utf8",
  );

  it("a failed text reports the real reason and offers the fallback, never a canned 'sent' toast", () => {
    expect(SHEET).toContain("if (!smsResult.ok)");
    expect(SHEET).toContain("Copy the link and send it yourself instead.");
  });

  it("a failed email delivery is reported before any success toast can fire", () => {
    expect(SHEET).toContain("if (!result.ok) {");
    expect(SHEET).toContain("showToast(result.message);");
  });
});

describe("the accept path refuses an expired invite", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/pro/account-links/[inviteId]/route.ts"),
    "utf8",
  );

  it("checks the date on accept", () => {
    expect(ROUTE).toContain('actionNorm === "accept" && Number.isFinite(expiresAt) && expiresAt < Date.now()');
    expect(ROUTE).toContain("This invite has expired.");
  });

  it("still lets the inviter cancel what lapsed", () => {
    // Scoping the check to `accept` is the point: tidying up must stay possible.
    // Read just the guard's own condition, not the blocks that follow it.
    const start = ROUTE.indexOf("if (actionNorm === \"accept\" && Number.isFinite(expiresAt)");
    expect(start).toBeGreaterThan(-1);
    const condition = ROUTE.slice(start, ROUTE.indexOf(")", ROUTE.indexOf("Date.now()", start)));
    expect(condition).toContain('actionNorm === "accept"');
    expect(condition).not.toContain("cancel");
    expect(condition).not.toContain("reject");
  });
});
