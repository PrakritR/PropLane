import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { teamInviteEligiblePropertyIds } from "@/lib/manager-portfolio-access";
import * as proRelationships from "@/lib/pro-relationships";
import * as propertyPipeline from "@/lib/demo-property-pipeline";
import * as portalDataStore from "@/lib/portal-data-store";
import { PORTAL_SECTION_CO_MANAGER_PERMISSION } from "@/lib/co-manager-permissions";
import {
  coManagerPermissionsExceedGrant,
  intersectCoManagerPermissions,
} from "@/lib/co-manager-permissions";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("Team invite delegation (server contract)", () => {
  const SERVER = read("src/lib/auth/co-manager-team-invite.server.ts");
  const INVITE_SERVER = read("src/lib/invite-links/invite-links.server.ts");
  const ACCOUNT_LINKS = read("src/app/api/pro/account-links/route.ts");
  const COPY_ROUTE = read("src/app/api/pro/invite-links/[linkId]/link/route.ts");

  it("gates delegation on teams edit for every selected property", () => {
    expect(SERVER).toContain('"teams"');
    expect(SERVER).toContain("resolveTeamInviteDelegate");
    expect(SERVER).toContain("teamInviteOwnerIdsForActor");
    expect(SERVER).toContain("actorCanManageInviteLink");
  });

  it("mints and lists invite links through the actor, not only the owner id", () => {
    expect(INVITE_SERVER).toContain("actorUserId");
    expect(INVITE_SERVER).toContain("listInviteLinksForActor");
    expect(INVITE_SERVER).toContain("rotateInviteLinkToken");
    expect(INVITE_SERVER).toContain("capTeamInvitePermissionsForDelegate");
  });

  it("routes addressed invites through the delegate resolver and caps delegated grants", () => {
    expect(ACCOUNT_LINKS).toContain("resolveTeamInviteDelegate");
    expect(ACCOUNT_LINKS).toContain("inviterUserId = delegate.ownerUserId");
    expect(ACCOUNT_LINKS).toContain("capTeamInvitePermissionsForDelegate");
  });

  it("exposes a copy route that rotates the token server-side", () => {
    expect(COPY_ROUTE).toContain("rotateInviteLinkToken");
    expect(COPY_ROUTE).toContain("inviteLinkUrl");
  });
});

describe("teams portal section maps to the Team module", () => {
  it("uses the teams permission module for the Teams nav section", () => {
    expect(PORTAL_SECTION_CO_MANAGER_PERMISSION.teams).toBe("teams");
  });
});

describe("delegated permission caps", () => {
  it("refuses when requested grants exceed the actor", () => {
    expect(
      coManagerPermissionsExceedGrant({ teams: { read: true, edit: true } }, { residents: { read: true } }),
    ).toBe(true);
    expect(
      coManagerPermissionsExceedGrant(
        { teams: { read: true, edit: true }, residents: { read: true } },
        { residents: { read: true } },
      ),
    ).toBe(false);
  });

  it("intersects requested grants down to the actor ceiling", () => {
    expect(
      intersectCoManagerPermissions(
        { teams: { read: true, edit: true } },
        { teams: { read: true, edit: true }, residents: { read: true } },
      ),
    ).toEqual({ teams: { read: true, edit: true, notification: true } });
  });
});

describe("teamInviteEligiblePropertyIds", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes owned properties and co-managed houses with Team edit", () => {
    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([
      {
        id: "owned-a",
        buildingName: "Mine",
        unitLabel: "1",
        address: "1 Main",
        status: "live",
      },
    ] as never);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);
    vi.spyOn(proRelationships, "readProRelationships").mockReturnValue([]);
    vi.spyOn(portalDataStore, "readCachedAccountLinkInvites").mockReturnValue([
      {
        id: "inv-1",
        tabKind: "manager",
        status: "accepted",
        direction: "incoming",
        inviterAxisId: "axis-owner",
        inviteeAxisId: "axis-co",
        inviterDisplayName: "Owner",
        inviteeDisplayName: "Co",
        linkedAxisId: "axis-owner",
        linkedDisplayName: "Owner",
        linkedUserId: "owner-user",
        assignedPropertyIds: ["linked-b", "linked-no-team"],
        payoutPercentForManager: 15,
        coManagerPermissions: { teams: { edit: true } },
        propertyCoManagerPermissions: {
          "linked-b": { teams: { edit: true } },
          "linked-no-team": { residents: { read: true } },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        respondedAt: "2026-01-02T00:00:00.000Z",
      } satisfies AccountLinkInviteDto,
    ]);

    expect([...teamInviteEligiblePropertyIds("co-user")].sort()).toEqual(["linked-b", "owned-a"]);
  });
});
