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

describe("the panel no longer claims an invite was sent when nothing was", () => {
  const PANEL = readFileSync(
    join(process.cwd(), "src/components/portal/pro-account-links-panel.tsx"),
    "utf8",
  );

  it("says what actually happened, and what the invitee must do", () => {
    expect(PANEL).toContain("Invite created, but nothing was sent.");
    expect(PANEL).not.toContain('"Invite sent. Waiting for their approval."');
  });

  it("the local-link path says it too", () => {
    expect(PANEL).toContain("Nothing was sent — tell them to open PropLane → Co-managers.");
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
