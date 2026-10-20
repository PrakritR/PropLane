"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { TEAM_ROLE_LABELS } from "@/lib/co-manager-team-roles";
import { serviceInviteBody } from "@/lib/service/service-team-invite";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const API = "/api/admin/service-workspaces";

/**
 * Settings > Workspaces > Team for a PropLane Service workspace, in service mode. The captain invites people to help
 * manage this workspace by email or PropLane ID: an Admin seat pinned to THIS workspace (never a platform admin
 * grant), taking effect when they accept. Only a platform admin invites or removes (the route re-checks); a helper
 * sees the team read-only. The Pro / Business owner-plan gate of an ordinary workspace does not apply here: the
 * workspace is PropLane's own managed service, not a manager's plan.
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
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = workspace.members ?? [];

  const post = async (body: Record<string, unknown>): Promise<string | null> => {
    try {
      const res = await fetchWithTimeout(
        API,
        { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        25_000,
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      return res.ok ? null : (json.error ?? "That did not work. Please retry.");
    } catch {
      return "Could not reach the server. Try again.";
    }
  };

  const invite = async () => {
    const body = serviceInviteBody(workspace.id, value);
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const failure = await post(body);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setValue("");
    showToast("Invite sent.");
    await onChanged();
  };

  const remove = async (linkId: string, name: string) => {
    if (!(await confirm({ title: "Remove from team", description: `Remove ${name} from ${workspace.name}?`, confirmLabel: "Remove" }))) return;
    const failure = await post({ action: "team-remove", id: workspace.id, linkId });
    if (failure) {
      showToast(failure);
      return;
    }
    await onChanged();
  };

  return (
    <PortalSettingsSection title="Team">
      <PortalSettingsGroup>
        {members.map((member) => (
          <PortalSettingsRow key={member.linkId} label={member.name}>
            <span className="inline-flex items-center gap-2 text-[14px] text-muted" data-attr="service-team-member">
              {member.status === "pending" ? "Invited" : (TEAM_ROLE_LABELS[member.role] ?? member.role)}
              {isAdmin ? (
                <PortalIconAction
                  icon={Trash2}
                  label="Remove"
                  ariaLabel={`Remove ${member.name}`}
                  tone="danger"
                  onClick={() => void remove(member.linkId, member.name)}
                  data-attr="service-team-remove"
                />
              ) : null}
            </span>
          </PortalSettingsRow>
        ))}
        {members.length === 0 ? <PortalSettingsRow label="No teammates yet" /> : null}
        {isAdmin ? (
          <PortalSettingsRow label="Invite" controlClassName="flex items-center gap-2">
            <Input
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void invite();
                }
              }}
              maxLength={120}
              autoComplete="off"
              placeholder="Email or PropLane ID"
              aria-label="Email or PropLane ID"
              className="w-56"
              data-attr="service-team-invite-input"
            />
            <Button type="button" onClick={() => void invite()} disabled={busy || !serviceInviteBody(workspace.id, value)} data-attr="service-team-invite">
              Invite
            </Button>
          </PortalSettingsRow>
        ) : null}
      </PortalSettingsGroup>
      {error ? (
        <p role="alert" className="text-sm text-danger" data-attr="service-team-error">
          {error}
        </p>
      ) : null}
    </PortalSettingsSection>
  );
}
