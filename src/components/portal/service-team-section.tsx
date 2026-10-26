"use client";

import { useCallback, useEffect, useState } from "react";
import { PortalRowMenu } from "@/components/portal/portal-row-menu";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { ServiceInviteSheet } from "@/components/portal/service-invite-sheet";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { TEAM_ROLE_LABELS } from "@/lib/co-manager-team-roles";
import type { ServiceTeamMember } from "@/lib/service/service-team-types";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const API = "/api/admin/service-workspaces";

/** "Owner", "Admin", "Invited · Owner": the role the row shows, in the words the Invite sheet uses. */
export function serviceTeamRoleLabel(member: Pick<ServiceTeamMember, "role" | "status" | "ownerOfRecord">): string {
  const role = member.ownerOfRecord || member.role === "property_owner" ? "Owner" : (TEAM_ROLE_LABELS[member.role as keyof typeof TEAM_ROLE_LABELS] ?? member.role);
  return member.status === "pending" ? `Invited · ${role}` : role;
}

function reachLabel(member: ServiceTeamMember): string | null {
  if (member.ownerOfRecord || member.delivery === "link") return null;
  if (member.houseScope === "selected") {
    const count = member.assignedPropertyIds?.length ?? 0;
    return `${count} ${count === 1 ? "house" : "houses"}`;
  }
  return "All houses";
}

/**
 * Settings > Workspaces > Team for a PropLane Service workspace, in service mode. The round blue + opens the Invite
 * sheet (email or PropLane ID, Role including Owner, Houses, per-module View / Edit); each seat's ⋯ has Edit access
 * (the same sheet, prefilled) and Remove. Only a platform admin invites, edits or removes (the route re-checks every
 * verb); a helper sees the team read-only. The Pro / Business owner-plan gate of an ordinary workspace does not
 * apply here: the workspace is PropLane's own managed service, not a manager's plan.
 */
export function ServiceTeamSection({
  workspace,
  isAdmin,
  onChanged,
}: {
  workspace: PortalWorkspace;
  isAdmin: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const [members, setMembers] = useState<ServiceTeamMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sheet, setSheet] = useState<{ member: ServiceTeamMember | null } | null>(null);

  const post = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetchWithTimeout(
        API,
        { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        25_000,
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string; members?: ServiceTeamMember[] };
      return { ok: res.ok, error: res.ok ? null : (json.error ?? "That did not work. Please retry."), members: json.members };
    } catch {
      return { ok: false, error: "Could not reach the server. Try again.", members: undefined };
    }
  }, []);

  // The roster route is admin-only, so only an admin asks for it; a helper or the client owner reads the roster the
  // workspace context already carries. A failed read keeps that copy too, never an empty "No teammates yet".
  const load = useCallback(async () => {
    if (!isAdmin) return;
    const result = await post({ action: "team", id: workspace.id });
    if (result.ok && result.members) {
      setMembers(result.members);
      setLoaded(true);
    }
  }, [isAdmin, post, workspace.id]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      const result = await post({ action: "team", id: workspace.id });
      if (cancelled) return;
      if (result.ok && result.members) {
        setMembers(result.members);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, post, workspace.id]);

  // The workspace context carries its own copy of the roster (Settings reads it elsewhere), so a change refreshes both.
  const changed = useCallback(async () => {
    await Promise.all([load(), onChanged()]);
  }, [load, onChanged]);

  const remove = async (member: ServiceTeamMember) => {
    if (!(await confirm({ title: "Remove from team", description: `Remove ${member.name} from ${workspace.name}?`, confirmLabel: "Remove" }))) return;
    const result = await post(
      member.delivery === "link"
        ? { action: "team-remove", id: workspace.id, inviteLinkId: member.linkId }
        : { action: "team-remove", id: workspace.id, linkId: member.linkId },
    );
    if (result.error) {
      showToast(result.error);
      return;
    }
    await changed();
  };

  // Show the server's roster once it has answered; otherwise the context's copy, so the list never flashes or sticks empty.
  const rows: ServiceTeamMember[] = loaded
    ? members
    : (workspace.members ?? []).map((m) => ({
        linkId: m.linkId,
        userId: m.userId,
        name: m.name,
        email: m.email,
        role: m.role,
        status: m.status,
        ownerOfRecord: false,
        delivery: "account" as const,
      }));

  return (
    <PortalSettingsSection
      title="Team"
      action={
        isAdmin ? (
          <PortalPrimaryIconAction label="Invite" onClick={() => setSheet({ member: null })} data-attr="service-team-invite" />
        ) : null
      }
    >
      <PortalSettingsGroup>
        {rows.map((member) => {
          const reach = reachLabel(member);
          return (
            <PortalSettingsRow key={`${member.delivery}:${member.linkId}`} label={member.name}>
              <span className="inline-flex items-center gap-2 text-[14px] text-muted" data-attr="service-team-member">
                {serviceTeamRoleLabel(member)}
                {reach && member.status === "accepted" ? ` · ${reach}` : ""}
                {isAdmin ? (
                  <PortalRowMenu
                    label={member.name}
                    dataAttr="service-team-member-menu"
                    items={[
                      member.delivery === "account" && !member.ownerOfRecord && member.role !== "property_owner"
                        ? { id: "edit", label: "Edit access", onSelect: () => setSheet({ member }), dataAttr: "service-team-edit" }
                        : null,
                      { id: "remove", label: "Remove", danger: true, onSelect: () => void remove(member), dataAttr: "service-team-remove" },
                    ]}
                  />
                ) : null}
              </span>
            </PortalSettingsRow>
          );
        })}
        {rows.length === 0 ? <PortalSettingsRow label="No teammates yet" /> : null}
      </PortalSettingsGroup>
      {sheet ? (
        // Mounted fresh (keyed on the seat) for every open, so each starts from the seat's stored access or a new invite.
        <ServiceInviteSheet
          key={sheet.member?.linkId ?? "new"}
          open
          workspace={workspace}
          member={sheet.member}
          onClose={() => setSheet(null)}
          onChanged={changed}
        />
      ) : null}
    </PortalSettingsSection>
  );
}
