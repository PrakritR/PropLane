// @vitest-environment jsdom
//
// Workspace settings rows, as the studio draws them (C2-CP6, captain 2026-10-03):
// Managers rows are avatar · name · email · role dropdown · houses dropdown · one ⋯;
// the owner is one read-only "Owner · All houses" line; a pending invite reads
// "Invited · N days left"; Properties rows carry the house tile, name and address
// line with no swap icon; the page ends with Plan, New workspace and Delete workspace.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TeamMembersBlock, TeamPendingInvitesBlock, type TeamMemberRow } from "@/components/portal/pro-team-blocks";
import { teamInviteDaysLeftLabel } from "@/components/portal/pro-account-links-panel";
import type { AccountLinkInviteDto } from "@/lib/account-links";

afterEach(cleanup);

const houses = {
  options: [{ value: "h1", label: "Alder House" }, { value: "h2", label: "Maple Duplex" }, { value: "h3", label: "Fremont Studio" }],
  selected: ["h1", "h2"],
  all: false,
  onSave: vi.fn().mockResolvedValue(undefined),
};

const rows: TeamMemberRow[] = [
  { id: "owner", name: "Alex Moreno", detail: "alex@seattlehomes.example", role: "owner", propertiesLabel: "All houses", joinedAt: null },
  {
    id: "m1", name: "Priya Shah", detail: "priya@capitolhill.example", role: "co_manager", roleLabel: "Leasing", roleId: "leasing",
    propertiesLabel: "2 of 3 houses", joinedAt: null, onRoleChange: vi.fn().mockResolvedValue(undefined), houses, onDisconnect: () => undefined,
  },
];

describe("Managers rows", () => {
  it("renders the owner as one read-only line with no menu", () => {
    render(<TeamMembersBlock embedded members={rows} />);
    const [ownerRow] = document.querySelectorAll('[data-attr="team-member-row"]');
    expect(ownerRow.querySelector('[data-attr="team-owner-values"]')?.textContent).toBe("Owner · All houses");
    expect(ownerRow.querySelector('[data-attr="team-member-actions"]')).toBeNull();
    expect(ownerRow.querySelector("button")).toBeNull();
  });

  it("gives a manager a role dropdown, a houses dropdown and exactly one ⋯", () => {
    render(<TeamMembersBlock embedded members={rows} />);
    const row = document.querySelectorAll('[data-attr="team-member-row"]')[1];
    expect(row.textContent).toContain("Priya Shah");
    expect(row.textContent).toContain("priya@capitolhill.example");
    expect(row.querySelector('[data-attr="team-row-role"]')?.textContent).toContain("Leasing");
    expect(row.querySelector('[data-attr="team-row-houses"]')?.textContent).toContain("2 of 3 houses");
    expect(row.querySelectorAll('[data-attr="team-member-actions"]')).toHaveLength(1);
  });

  it("saves the houses a manager keeps", async () => {
    houses.onSave.mockClear();
    render(<TeamMembersBlock embedded members={rows} />);
    fireEvent.click(document.querySelector('[data-attr="team-row-houses"]')!);
    const option = await screen.findByRole("option", { name: /Fremont Studio/ });
    const pointer = { button: 0, pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 };
    fireEvent.pointerDown(option, pointer);
    fireEvent.pointerUp(option, pointer);
    expect(houses.onSave).toHaveBeenCalledWith(["h1", "h2", "h3"], false);
  });
});

describe("Pending invites", () => {
  const invite = { id: "i1", direction: "outgoing", status: "pending", linkedDisplayName: "Maya Chen", teamRole: "bookkeeper", expiresAt: new Date(Date.now() + 11.5 * 86_400_000).toISOString(), assignedPropertyIds: [] } as unknown as AccountLinkInviteDto;

  it("reads 'Invited · N days left'", () => {
    render(
      <TeamPendingInvitesBlock embedded invites={[invite]} propertiesLabel={() => "All houses"} roleLabel={() => "Bookkeeper"} expiryLabel={teamInviteDaysLeftLabel}
        onRevoke={() => undefined} onAccept={() => undefined} onDecline={() => undefined} onOpen={() => undefined} />,
    );
    expect(document.querySelector('[data-attr="team-pending-row"]')?.textContent).toContain("Invited · 12 days left");
  });

  it("words the remaining time", () => {
    const now = Date.parse("2026-10-03T00:00:00Z");
    expect(teamInviteDaysLeftLabel("2026-10-15T00:00:00Z", now)).toBe("12 days left");
    expect(teamInviteDaysLeftLabel("2026-10-03T12:00:00Z", now)).toBe("1 day left");
    expect(teamInviteDaysLeftLabel("2026-10-01T00:00:00Z", now)).toBe("Expired");
    expect(teamInviteDaysLeftLabel(null, now)).toBe("");
  });
});

describe("Workspace page structure", () => {
  const settings = readFileSync(join(process.cwd(), "src/components/portal/workspace-settings.tsx"), "utf8");
  const strip = readFileSync(join(process.cwd(), "src/components/portal/workspace-invite-link-strip.tsx"), "utf8");

  it("lists properties as tile · name · address with no swap icon or move flow", () => {
    expect(settings).toContain("propertyAddresses");
    expect(settings).not.toContain("ArrowRightLeft");
    expect(settings).not.toContain("workspace-move-property");
    expect(settings).not.toContain("move-preview");
  });

  it("ends with Plan, New workspace and Delete workspace", () => {
    const plan = settings.indexOf("<PlanCard");
    const neu = settings.indexOf('data-attr="workspace-new"');
    const del = settings.indexOf('"workspace-delete" : "workspace-leave"');
    expect(plan).toBeGreaterThan(-1);
    expect(neu).toBeGreaterThan(plan);
    expect(del).toBeGreaterThan(neu);
  });

  it("draws the invite link row as Anyone with the link · mono link · role · copy · ⋯", () => {
    expect(strip).toContain("Anyone with the link");
    expect(strip).toContain("font-mono");
    expect(strip).toContain('label="Copy invite link"');
    expect(strip).toContain("workspace-invite-link-actions");
  });
});
