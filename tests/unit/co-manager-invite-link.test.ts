import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCoManagerInviteBody,
  coManagerInviteAcceptUrl,
} from "@/lib/co-manager-link-email";
import {
  coManagerOpenInvitePath,
  generateCoManagerInviteToken,
  hashCoManagerInviteToken,
  isCoManagerInvitePath,
} from "@/lib/co-manager-invite-token";

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

describe("co-manager open invite token", () => {
  it("builds the public accept path from a token", () => {
    expect(coManagerOpenInvitePath("tok-1")).toBe("/auth/co-manager-invite?token=tok-1");
    expect(isCoManagerInvitePath("/auth/co-manager-invite?token=tok-1")).toBe(true);
    expect(isCoManagerInvitePath("/portal/teams/managers")).toBe(false);
  });

  it("hashes the token so the raw value is not recoverable", () => {
    const token = generateCoManagerInviteToken();
    const hash = hashCoManagerInviteToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(token);
    expect(hashCoManagerInviteToken(token)).toBe(hash);
  });
});

describe("co-manager open invite surfaces", () => {
  it("Add modal copies a shareable link without requiring a PropLane ID", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/components/portal/pro-account-links-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("createOpenInviteLink");
    expect(panel).toContain("Copy invite link");
    expect(panel).toContain("Assigned properties (optional)");
    expect(panel).not.toContain("Select at least one property for this invite.");
  });

  it("create route mints an open invite when no PropLane ID is sent", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/pro/account-links/route.ts"), "utf8");
    expect(source).toContain("mintOpenCoManagerInvite");
    expect(source).toContain("const openInvite = !inviteeAxisId");
    expect(source).not.toContain("inviteeAxisId is required.");
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
