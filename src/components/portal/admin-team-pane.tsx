"use client";

import { useCallback, useEffect, useState } from "react";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRowMenu } from "@/components/portal/portal-row-menu";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { AdminTeamSheet } from "@/components/portal/admin-team-sheet";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { adminTeamRoleLabel, type AdminTeamMemberRow, type AdminTeamPayload } from "@/lib/admin-team/admin-team-model";

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetchWithTimeout(
      path,
      { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      25_000,
    );
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: res.ok, error: res.ok ? null : (json.error ?? "That did not work. Please retry.") };
  } catch {
    return { ok: false, error: "Could not reach the server. Try again." };
  }
}

/** "Overall admin" or "Property manager · 1. Ambika (3 houses)", the row's place line. */
export function adminTeamRowSummary(member: Pick<AdminTeamMemberRow, "role" | "state" | "seats">): string {
  const role = adminTeamRoleLabel(member.role);
  const where =
    member.role === "overall_admin"
      ? "all workspaces"
      : member.seats
          .map((seat) => `${seat.workspaceName} (${seat.houseScope === "all" ? "all houses" : `${seat.houseCount} ${seat.houseCount === 1 ? "house" : "houses"}`})`)
          .join(", ");
  return [member.state === "invited" ? "Invited" : null, role, where].filter(Boolean).join(" · ");
}

/**
 * Settings > Admin team (PropLane scope, Overall admins only). One list of everyone who can open PropLane admin: Overall
 * admins and the people seated on a workspace. The round blue + invites; each row's ⋯ changes the role, resends a waiting
 * invite or removes. Every verb is re-checked on the server.
 */
export function AdminTeamPane() {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const [payload, setPayload] = useState<AdminTeamPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ member: AdminTeamMemberRow | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/admin/team", { credentials: "include", cache: "no-store" }, 25_000);
      const json = (await res.json().catch(() => ({}))) as Partial<AdminTeamPayload> & { error?: string };
      if (!res.ok || !json.members) {
        setLoadError(json.error ?? "Could not load the admin team.");
        return;
      }
      setPayload(json as AdminTeamPayload);
      setLoadError(null);
    } catch {
      setLoadError("Could not reach the server. Try again.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (member: AdminTeamMemberRow) => {
    const title = member.state === "invited" ? "Turn off invite" : "Remove from admin team";
    if (!(await confirm({ title, description: `${member.name}`, confirmLabel: member.state === "invited" ? "Turn off" : "Remove" }))) return;
    const result = await post("/api/admin/team/remove", member.inviteId ? { inviteId: member.inviteId } : { userId: member.userId });
    if (result.error) {
      showToast(result.error);
      return;
    }
    await load();
  };

  const resend = async (member: AdminTeamMemberRow) => {
    if (!member.inviteId) return;
    const result = await post("/api/admin/team/resend", { inviteId: member.inviteId });
    showToast(result.error ?? "Invite sent again.");
    if (!result.error) await load();
  };

  return (
    <PortalSettingsSection
      title="Admin team"
      action={<PortalPrimaryIconAction label="Invite" onClick={() => setSheet({ member: null })} data-attr="admin-team-invite" />}
    >
      <PortalSettingsGroup>
        {(payload?.members ?? []).map((member) => (
          <PortalSettingsRow key={member.key} label={member.name}>
            <span className="inline-flex items-center gap-2 text-[14px] text-muted" data-attr="admin-team-member">
              {adminTeamRowSummary(member)}
              {member.canManage ? (
                <PortalRowMenu
                  label={member.name}
                  dataAttr="admin-team-member-menu"
                  items={[
                    member.state === "active" ? { id: "role", label: "Change role", onSelect: () => setSheet({ member }), dataAttr: "admin-team-change" } : null,
                    member.state === "invited" ? { id: "resend", label: "Resend invite", onSelect: () => void resend(member), dataAttr: "admin-team-resend" } : null,
                    { id: "remove", label: member.state === "invited" ? "Turn off invite" : "Remove", danger: true, onSelect: () => void remove(member), dataAttr: "admin-team-remove" },
                  ]}
                />
              ) : null}
            </span>
          </PortalSettingsRow>
        ))}
        {payload && payload.members.length === 0 ? <PortalSettingsRow label="No one on the admin team yet" /> : null}
        {!payload && !loadError ? <PortalSettingsRow label="Loading…" /> : null}
        {loadError ? <PortalSettingsRow label={loadError} /> : null}
      </PortalSettingsGroup>
      {sheet && payload ? (
        <AdminTeamSheet
          key={sheet.member?.key ?? "new"}
          workspaces={payload.workspaces}
          member={sheet.member}
          onClose={() => setSheet(null)}
          onChanged={load}
        />
      ) : null}
    </PortalSettingsSection>
  );
}
