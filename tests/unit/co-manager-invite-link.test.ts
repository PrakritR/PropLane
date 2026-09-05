import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCoManagerInviteBody,
  coManagerInviteAcceptUrl,
} from "@/lib/co-manager-link-email";

describe("co-manager invite accept link", () => {
  it("builds a manager team deep link for an invite id", () => {
    expect(coManagerInviteAcceptUrl("invite-abc")).toContain("/portal/teams/managers/invite-abc");
  });

  it("includes the accept link in invite email copy when inviteId is provided", () => {
    const body = buildCoManagerInviteBody({
      inviterName: "Aakasha Jain",
      propertyLabels: ["5257 Brooklyn Ave NE"],
      inviteId: "invite-abc",
    });
    expect(body).toContain("Accept the invite:");
    expect(body).toContain("/portal/teams/managers/invite-abc");
  });
});

describe("co-manager PropLane ID lookup eligibility", () => {
  it("lookup-axis-id uses profile_roles-aware eligibility", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/pro/lookup-axis-id/route.ts"),
      "utf8",
    );
    expect(source).toContain("userIsPropertyPortalManager");
    expect(source).not.toMatch(/profile\.role[\s\S]{0,120}must be a property portal manager/);
  });

  it("account-links POST uses profile_roles-aware invitee eligibility", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/pro/account-links/route.ts"), "utf8");
    expect(source).toContain("userIsPropertyPortalManager(svc, inviteeProfile.id)");
    expect(source).not.toContain('ir === "manager" || ir === "owner"');
  });
});
