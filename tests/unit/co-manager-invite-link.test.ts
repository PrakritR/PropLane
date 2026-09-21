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
} from "@/lib/co-manager-invite-token.server";

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
  it("Invite opens the workspace invite sheet, not the old three-path modal", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/components/portal/pro-account-links-panel.tsx"),
      "utf8",
    );
    // The old Add modal (invite paths + PropLane-ID lookup + Continue) is gone;
    // the sheet is the one invite surface.
    expect(panel).not.toContain("PortalInvitePaths");
    expect(panel).not.toContain('data-attr="co-manager-proplane-id-input"');
    expect(panel).not.toContain('data-attr="co-manager-link-continue"');
    expect(panel).toContain("WorkspaceInviteSheet");
    expect(panel).toContain("openLinkModal");

    const sheet = readFileSync(
      join(process.cwd(), "src/components/portal/workspace-invite-sheet.tsx"),
      "utf8",
    );
    // Send by phone/email/code, copy the minted link, and set role + houses
    // through the same Role/Houses fields Edit permissions renders — no
    // separate "Continue" step or path chooser.
    expect(sheet).toContain('data-attr="workspace-invite-send"');
    expect(sheet).toContain('data-attr="workspace-invite-copy"');
    expect(sheet).toContain("<WorkspacePermissionsFields");
    expect(sheet).toContain("<CoManagerPermissionsEditor");
    expect(sheet).toContain("<WorkspaceGrantFields");
    expect(sheet).not.toContain("PortalInvitePaths");
  });

  it("allows minting a co-manager invite with zero properties (PRP-419)", () => {
    const server = readFileSync(
      join(process.cwd(), "src/lib/auth/co-manager-team-invite.server.ts"),
      "utf8",
    );
    expect(server).toContain("unique.length === 0");
    expect(server).toContain("ownerUserId: actorUserId");
    expect(server).not.toContain("Choose at least one property this link grants access to.");
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

describe("active invite link per workspace", () => {
  it("server exports activeInviteLinkForWorkspace", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/invite-links/invite-links.server.ts"),
      "utf8",
    );
    expect(source).toContain("export async function activeInviteLinkForWorkspace");
    expect(source).toContain("actorWorkspaceStanding(db, input.actorUserId, input.workspaceId)");
  });

  it("GET route with workspaceId query param calls activeInviteLinkForWorkspace", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/pro/invite-links/route.ts"),
      "utf8",
    );
    expect(source).toContain("const workspaceId = searchParams.get");
    expect(source).toContain("activeInviteLinkForWorkspace");
    expect(source).toContain('return NextResponse.json({ link: result.link })');
  });

  it("mintInviteLink accepts replaceActive parameter", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/invite-links/invite-links.server.ts"),
      "utf8",
    );
    expect(source).toContain("replaceActive?: boolean");
    expect(source).toContain("if (input.replaceActive && kind === \"manager\" && workspaceId)");
    expect(source).toContain("revoked_at: new Date().toISOString()");
    expect(source).toContain("A URL already sent must never gain power when");
  });

  it("POST route passes replaceActive from body", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/pro/invite-links/route.ts"),
      "utf8",
    );
    expect(source).toContain("replaceActive?: boolean");
    expect(source).toContain("replaceActive: body.replaceActive === true");
  });

  it("replaceActive aborts the mint rather than inserting when the revoke fails (security review Medium)", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/invite-links/invite-links.server.ts"),
      "utf8",
    );
    // The revoke's own { error } must be read and checked BEFORE the insert
    // block runs, so a failed revoke can never leave the old (possibly more
    // powerful) link live alongside a freshly inserted one.
    expect(source).toContain("const { error: revokeError } = await db");
    expect(source).toContain("if (revokeError) {");
    expect(source).toContain("Could not turn off the previous link; nothing changed.");
    const revokeBlockIndex = source.indexOf("const { error: revokeError } = await db");
    const insertIndex = source.indexOf(".insert({", revokeBlockIndex);
    expect(revokeBlockIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(revokeBlockIndex);
  });

  it("the GET link projection carries houseScope alongside teamRole so the sheet can hydrate from it", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/invite-links/invite-links.server.ts"),
      "utf8",
    );
    expect(source).toContain("houseScope: parseHouseScope(row.house_scope)");
  });

  it("LINK_COLUMNS and toInviteLinkRow never carry the token or its ciphertext", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/invite-links/invite-links.server.ts"),
      "utf8",
    );
    const columnsMatch = source.match(/const LINK_COLUMNS =\s*\n?\s*"([^"]+)"/);
    expect(columnsMatch).toBeTruthy();
    const columns = columnsMatch?.[1] ?? "";
    expect(columns).not.toContain("token");
    const rowFnMatch = source.match(/function toInviteLinkRow\([^)]*\)[^{]*\{([\s\S]*?)\n}/);
    expect(rowFnMatch).toBeTruthy();
    expect(rowFnMatch?.[1] ?? "").not.toMatch(/token/i);
  });
});

describe("invite link carries the Custom role's workspace-level grant (security review Low)", () => {
  const SERVER = readFileSync(
    join(process.cwd(), "src/lib/invite-links/invite-links.server.ts"),
    "utf8",
  );

  it("mintInviteLink accepts and normalizes workspacePermissions, only for a Custom manager link", () => {
    expect(SERVER).toContain("workspacePermissions?: unknown;");
    expect(SERVER).toContain('if (parsedRole.role === "custom") {\n      workspacePermissions = normalizeWorkspacePermissions(input.workspacePermissions);');
    expect(SERVER).toContain("workspace_permissions: workspacePermissions,");
  });

  it("LINK_COLUMNS and toInviteLinkRow return workspacePermissions so the sheet can hydrate and compare it", () => {
    const columnsMatch = SERVER.match(/const LINK_COLUMNS =\s*\n?\s*"([^"]+)"/);
    expect(columnsMatch?.[1] ?? "").toContain("workspace_permissions");
    expect(SERVER).toContain("workspacePermissions: normalizeWorkspacePermissions(row.workspace_permissions)");
  });

  it("the mint route and client pass workspacePermissions through to mintInviteLink", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/pro/invite-links/route.ts"), "utf8");
    expect(route).toContain("workspacePermissions: body.workspacePermissions,");
    const client = readFileSync(
      join(process.cwd(), "src/lib/invite-links/mint-invite-link-client.ts"),
      "utf8",
    );
    expect(client).toContain("workspacePermissions: input.workspacePermissions,");
  });

  it("the sheet's termsMatch deep-compares workspacePermissions for a Custom role, so tightening or loosening rights re-mints", () => {
    const sheet = readFileSync(
      join(process.cwd(), "src/components/portal/workspace-invite-sheet.tsx"),
      "utf8",
    );
    expect(sheet).toContain(
      'JSON.stringify(held.workspacePermissions) === JSON.stringify(current.workspacePermissions)',
    );
    expect(sheet).toContain("workspacePermissions: effectiveWorkspacePermissions");
  });

  it("a migration adds manager_invite_links.workspace_permissions", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/20260920201000_invite_link_workspace_permissions.sql"),
      "utf8",
    );
    expect(migration).toContain("alter table public.manager_invite_links");
    expect(migration).toContain("add column if not exists workspace_permissions jsonb not null default '{}'::jsonb");
  });
});
