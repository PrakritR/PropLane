"use client";

/**
 * Invite to a workspace: Channel, Role, Houses, and the effective grant.
 * Opened by `ProAccountLinksPanel`'s `openLinkModal(workspaceId)`.
 *
 * Role / Houses / Selected houses render through `WorkspacePermissionsFields`,
 * the shared field kit in `workspace-permissions-fields.tsx`.
 *
 * Opening the sheet only READS the workspace's latest active link (hydrating
 * role/houses/permissions) and never mints as a side effect.
 *
 * "Copy invite link" always mints a NEW row with `replaceActive: false`,
 * copies the URL, refreshes Members, and closes the sheet — the unique link
 * appears in the Invite links list under Members. Send (email/SMS) still
 * reuses a matching held link, and remints with `replaceActive: true` only
 * when on-screen terms changed (see `docs/agents/co-manager-access.md`).
 */

import { useEffect, useMemo, useState } from "react";
import { Link2 } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { parseInviteRecipient } from "@/lib/invite-recipient";
import {
  WorkspacePermissionsFields,
  RoleCapabilitiesList,
  CoManagerPermissionsEditor,
  WorkspaceGrantFields,
} from "@/components/portal/workspace-permissions-fields";
import type { PortalWorkspace } from "@/lib/workspaces/types";
import { memberReachLabel, parseHouseScope, type HouseScope } from "@/lib/workspaces/membership";
import {
  TEAM_ROLE_LABELS,
  parseTeamRole,
  stampTeamRolePermissions,
  type TeamRoleId,
} from "@/lib/co-manager-team-roles";
import {
  EMPTY_CO_MANAGER_PERMISSIONS,
  flatCoManagerPermissionsFromProperty,
  normalizePropertyCoManagerPermissions,
  type CoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  normalizeWorkspacePermissions,
  type WorkspaceCoManagerGrant,
} from "@/lib/workspace-co-manager-permissions";
import { mintInviteLinkClient, revealInviteLinkClient } from "@/lib/invite-links/mint-invite-link-client";
import { formatInviteMessageBody, formatInviteMessageSubject } from "@/lib/invite-message-body";
import { deliverManagerDirectoryMessage, sendWorkspaceInviteSms } from "@/lib/manager-vendor-invite-client";

function roleLabelFor(role: TeamRoleId): string {
  return TEAM_ROLE_LABELS[role === "full" ? "admin" : role];
}

function reachLabelFor(input: {
  houseScope: HouseScope;
  workspace: PortalWorkspace;
  selectedHouseIds: string[];
}): string {
  if (input.houseScope === "all") return `All houses in ${input.workspace.name}`;
  return memberReachLabel({
    houseScope: "selected",
    houseCount: input.selectedHouseIds.length,
    workspaceHouseCount: input.workspace.propertyIds.length,
  });
}

/** The default Houses scope an inviter may hand out: never wider than their own reach in this workspace. */
function defaultHouseScopeFor(workspace: PortalWorkspace): HouseScope {
  return workspace.viewerHouseScope === "selected" ? "selected" : "all";
}

/** The access terms a held link was minted or hydrated with, for comparison against the live UI. */
type HeldLinkTerms = {
  role: TeamRoleId;
  houseScope: HouseScope;
  houseIds: string[];
  permissions: CoManagerPermissions;
  workspacePermissions: WorkspaceCoManagerGrant;
};

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

function termsMatch(held: HeldLinkTerms, current: HeldLinkTerms): boolean {
  if (held.role !== current.role) return false;
  if (held.houseScope !== current.houseScope) return false;
  if (!sameIds(held.houseIds, current.houseIds)) return false;
  if (held.role === "custom") {
    return (
      JSON.stringify(held.permissions) === JSON.stringify(current.permissions) &&
      JSON.stringify(held.workspacePermissions) === JSON.stringify(current.workspacePermissions)
    );
  }
  return true;
}

export function WorkspaceInviteSheet({
  open,
  workspace,
  onClose,
  onChanged,
  onInviteLinkSaved,
  onEditMember,
  inviterName,
}: {
  open: boolean;
  workspace: PortalWorkspace;
  onClose: () => void;
  onChanged: () => void;
  /** After Copy invite link succeeds — refresh the list and scroll to Invite links. */
  onInviteLinkSaved?: () => void;
  /** Accepted for the panel's call site; this single-view sheet has no member row of its own to edit. */
  onEditMember: (linkId: string) => void;
  /** The manager sending the invite — used in the emailed/texted message body, never the workspace name. */
  inviterName: string;
}) {
  void onEditMember;
  const { showToast } = useAppUi();

  const [role, setRole] = useState<TeamRoleId>("viewer");
  const [houseScope, setHouseScope] = useState<HouseScope>("all");
  const [selectedHouseIds, setSelectedHouseIds] = useState<string[]>([]);
  const [customPermissions, setCustomPermissions] = useState<CoManagerPermissions>(EMPTY_CO_MANAGER_PERMISSIONS);
  const [workspacePermissions, setWorkspacePermissions] = useState<WorkspaceCoManagerGrant>(
    DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  );

  const [linkId, setLinkId] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  /** The terms the held link (`linkId`) actually carries — null until one is hydrated or minted. */
  const [heldTerms, setHeldTerms] = useState<HeldLinkTerms | null>(null);

  const [sendValue, setSendValue] = useState("");
  const [sending, setSending] = useState(false);
  /** How the invite is delivered — invite link is the default. */
  const [channel, setChannel] = useState<"link" | "phone" | "email" | "code">("link");

  const recipient = useMemo(() => parseInviteRecipient(sendValue), [sendValue]);
  const canSend =
    channel !== "link" &&
    ((channel === "phone" && recipient.kind === "phone") ||
      (channel === "email" && recipient.kind === "email") ||
      (channel === "code" && recipient.kind === "code"));

  const effectivePermissions = useMemo(
    () => (role === "custom" ? customPermissions : stampTeamRolePermissions(role) ?? EMPTY_CO_MANAGER_PERMISSIONS),
    [role, customPermissions],
  );

  // Workspace-level rights (members/billing) follow the role for every stock
  // role — only Custom carries its own map, same split as `effectivePermissions`.
  const effectiveWorkspacePermissions = useMemo(
    () => (role === "custom" ? normalizeWorkspacePermissions(workspacePermissions) : DEFAULT_NEW_INVITE_WORKSPACE_GRANT),
    [role, workspacePermissions],
  );

  const houseIds = useMemo(
    () => (houseScope === "all" ? workspace.propertyIds : selectedHouseIds),
    [houseScope, selectedHouseIds, workspace.propertyIds],
  );

  const reach = useMemo(
    () => reachLabelFor({ houseScope, workspace, selectedHouseIds }),
    [houseScope, workspace, selectedHouseIds],
  );

  const houseOptions = useMemo(
    () =>
      workspace.propertyIds.map((id) => ({
        value: id,
        label: workspace.propertyLabels?.[id]?.trim() || id,
      })),
    [workspace.propertyIds, workspace.propertyLabels],
  );

  const currentTerms: HeldLinkTerms = useMemo(
    () => ({ role, houseScope, houseIds, permissions: effectivePermissions, workspacePermissions: effectiveWorkspacePermissions }),
    [role, houseScope, houseIds, effectivePermissions, effectiveWorkspacePermissions],
  );

  /** The on-screen Role + Houses exactly describe the link Copy/Send would hand out. */
  const termsMatchHeldLink = heldTerms != null && termsMatch(heldTerms, currentTerms);

  // Reset and read the workspace's existing link every time the sheet opens
  // for a (possibly new) workspace. This never mints — Invite link and Send
  // own that, at the moment the manager actually shares something. The
  // default Houses scope is capped to the inviter's own reach in this workspace.
  useEffect(() => {
    if (!open) return;
    setRole("viewer");
    setHouseScope(defaultHouseScopeFor(workspace));
    setSelectedHouseIds([]);
    setCustomPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
    setWorkspacePermissions(DEFAULT_NEW_INVITE_WORKSPACE_GRANT);
    setLinkId(null);
    setLinkUrl(null);
    setHeldTerms(null);
    setSendValue("");
    let cancelled = false;
    setLinkLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/pro/invite-links?workspaceId=${encodeURIComponent(workspace.id)}`, {
          credentials: "include",
        });
        const data = (await res.json().catch(() => ({}))) as {
          link?: {
            id?: string;
            teamRole?: string | null;
            houseScope?: string | null;
            assignedPropertyIds?: string[];
            propertyPermissions?: Record<string, unknown>;
            workspacePermissions?: Record<string, unknown>;
          } | null;
        };
        if (cancelled) return;
        const link = data.link;
        if (!link?.id) return; // no link yet — leave the defaults, mint nothing.

        const parsedRole = parseTeamRole(link.teamRole);
        const nextRole: TeamRoleId = parsedRole.ok && parsedRole.role ? parsedRole.role : "viewer";
        const nextHouseScope = parseHouseScope(link.houseScope);
        const assignedIds = Array.isArray(link.assignedPropertyIds) ? link.assignedPropertyIds : [];
        const nextSelectedHouseIds = nextHouseScope === "selected" ? assignedIds : [];
        const nextHouseIds = nextHouseScope === "all" ? workspace.propertyIds : nextSelectedHouseIds;
        const nextCustomPermissions =
          nextRole === "custom"
            ? flatCoManagerPermissionsFromProperty(
                normalizePropertyCoManagerPermissions(link.propertyPermissions, assignedIds),
              )
            : EMPTY_CO_MANAGER_PERMISSIONS;
        const nextPermissions =
          nextRole === "custom" ? nextCustomPermissions : stampTeamRolePermissions(nextRole) ?? EMPTY_CO_MANAGER_PERMISSIONS;
        const nextWorkspacePermissions =
          nextRole === "custom"
            ? normalizeWorkspacePermissions(link.workspacePermissions)
            : DEFAULT_NEW_INVITE_WORKSPACE_GRANT;

        setRole(nextRole);
        setHouseScope(nextHouseScope);
        setSelectedHouseIds(nextSelectedHouseIds);
        setCustomPermissions(nextCustomPermissions);
        setWorkspacePermissions(nextWorkspacePermissions);
        setLinkId(link.id);
        setHeldTerms({
          role: nextRole,
          houseScope: nextHouseScope,
          houseIds: nextHouseIds,
          permissions: nextPermissions,
          workspacePermissions: nextWorkspacePermissions,
        });
      } finally {
        if (!cancelled) setLinkLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open + workspace only
  }, [open, workspace.id]);

  const changeRole = (next: TeamRoleId) => setRole(next);
  const changeHouseScope = (next: HouseScope) => setHouseScope(next);
  const changeSelectedHouseIds = (next: string[]) => setSelectedHouseIds(next);
  const changeCustomPermissions = (next: CoManagerPermissions) => setCustomPermissions(next);

  /**
   * The URL for what is on screen right now (Send path). Reuses the held link's
   * URL when its terms still match; otherwise mints with `replaceActive: true`.
   */
  const resolveLinkForCurrentTerms = async (): Promise<
    { ok: true; url: string; linkId: string } | { ok: false; error: string }
  > => {
    if (linkId && termsMatchHeldLink) {
      if (linkUrl) return { ok: true, url: linkUrl, linkId };
      const result = await revealInviteLinkClient(linkId);
      if (!result.ok) return { ok: false, error: result.error };
      setLinkUrl(result.url);
      return { ok: true, url: result.url, linkId };
    }

    const hadPriorLink = linkId != null;
    const result = await mintInviteLinkClient({
      kind: "manager",
      label: `${roleLabelFor(role)} · ${reach}`,
      workspaceId: workspace.id,
      assignedPropertyIds: houseIds,
      propertyPermissions: normalizePropertyCoManagerPermissions(
        Object.fromEntries(houseIds.map((id) => [id, effectivePermissions])),
        houseIds,
      ),
      propertyLabelsById: workspace.propertyLabels,
      teamRole: role,
      houseScope,
      workspacePermissions: effectiveWorkspacePermissions,
      replaceActive: true,
    });
    if (!result.ok) return { ok: false, error: result.error };
    setLinkId(result.linkId);
    setLinkUrl(result.url);
    setHeldTerms(currentTerms);
    if (hadPriorLink) {
      showToast("Link updated. Anyone with the old link will need the new one.");
    }
    return { ok: true, url: result.url, linkId: result.linkId };
  };

  /** Always mint a new saved link (append), copy it, refresh Members, close sheet. */
  const copyAndSaveInviteLink = async () => {
    setLinkLoading(true);
    try {
      const result = await mintInviteLinkClient({
        kind: "manager",
        label: `${roleLabelFor(role)} · ${reach}`,
        workspaceId: workspace.id,
        assignedPropertyIds: houseIds,
        propertyPermissions: normalizePropertyCoManagerPermissions(
          Object.fromEntries(houseIds.map((id) => [id, effectivePermissions])),
          houseIds,
        ),
        propertyLabelsById: workspace.propertyLabels,
        teamRole: role,
        houseScope,
        workspacePermissions: effectiveWorkspacePermissions,
        replaceActive: false,
      });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setLinkId(result.linkId);
      setLinkUrl(result.url);
      setHeldTerms(currentTerms);
      try {
        await navigator.clipboard.writeText(result.url);
        showToast("Invite link copied.");
      } catch {
        showToast("Link saved — copy it from Invite links below Members.");
      }
      onInviteLinkSaved?.();
      onChanged();
      onClose();
    } finally {
      setLinkLoading(false);
    }
  };

  const send = async () => {
    if (!canSend || sending) return;
    setSending(true);
    const roleLabel = roleLabelFor(role);
    try {
      if (recipient.kind === "code") {
        const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
          Object.fromEntries(houseIds.map((id) => [id, effectivePermissions])),
          houseIds,
        );
        const res = await fetch("/api/pro/account-links", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inviteeAxisId: recipient.value,
            tabKind: "manager",
            assignedPropertyIds: houseIds,
            payoutPercentForManager: 15,
            propertyCoManagerPermissions,
            coManagerPermissions: effectivePermissions,
            workspaceId: workspace.id,
            workspacePermissions,
            teamRole: role,
            houseScope,
            skipInviteNotification: false,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          showToast(data.error ?? "Could not send invite.");
          return;
        }
        showToast(`Invite sent to ${recipient.label} · ${roleLabel} · ${reach}`);
        setSendValue("");
        onChanged();
        return;
      }

      // phone / email: no PropLane account exists yet, so there is no row to
      // create — the invite lives entirely in the link. Email goes out through
      // the shared manager directory message path; phone cannot, because that
      // path only ever resolves an existing account or an email address (it
      // never accepts a raw phone number), so it goes out through the
      // manager's own work number instead — the same transport
      // `record-share-link/send` and `send-lead-invite` already use for an
      // ad hoc phone recipient.
      //
      // The link must exist and match what is on screen BEFORE the message is
      // built — otherwise a sheet opened onto an existing link, never copied,
      // would email or text an invite with no URL to accept it with.
      const linkResult = await resolveLinkForCurrentTerms();
      if (!linkResult.ok) {
        showToast(linkResult.error);
        return;
      }
      const facts = {
        kind: "workspace" as const,
        inviterName,
        workspaceName: workspace.name,
        propertyLabels: houseIds.map((id) => workspace.propertyLabels?.[id]?.trim() || id),
        inviteUrl: linkResult.url,
        roleLabel,
        reach,
      };
      const subject = formatInviteMessageSubject(facts);
      const body = formatInviteMessageBody(facts);

      if (recipient.kind === "phone") {
        const smsResult = await sendWorkspaceInviteSms({
          workspaceId: workspace.id,
          phone: recipient.value,
          linkId: linkResult.linkId,
        });
        if (!smsResult.ok) {
          showToast(`${smsResult.error} Copy the link and send it yourself instead.`);
          return;
        }
      } else {
        const result = await deliverManagerDirectoryMessage(
          { name: recipient.value, email: recipient.value, subject, body },
          false,
          { viaInbox: false, viaEmail: true, viaSms: false },
          undefined,
          {},
        );
        if (!result.ok) {
          showToast(result.message);
          return;
        }
      }
      showToast(
        `Invite ${recipient.kind === "phone" ? "texted" : "emailed"} to ${recipient.label} · ${roleLabel} · ${reach}`,
      );
      setSendValue("");
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`Invite to ${workspace.name}`}
      onClose={onClose}
      panelClassName="max-w-2xl"
      dataAttr="workspace-invite-sheet"
      footer={
        <ModalFooter className="justify-end">
          {channel === "link" ? (
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              loading={linkLoading}
              onClick={() => copyAndSaveInviteLink()}
              data-attr="workspace-invite-copy"
            >
              <Link2 className="h-4 w-4" />
              <span className="ml-1.5">Copy invite link</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              disabled={!canSend}
              loading={sending}
              onClick={() => send()}
              data-attr="workspace-invite-send"
            >
              Send
            </Button>
          )}
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <FieldSingleSelect
          label="Channel"
          value={channel}
          onChange={(next) => setChannel(next as "link" | "phone" | "email" | "code")}
          options={[
            { value: "link", label: "Invite link" },
            { value: "phone", label: "Phone" },
            { value: "email", label: "Email" },
            { value: "code", label: "PropLane code" },
          ]}
          dataAttr="workspace-invite-channel"
        />

        {channel === "link" ? null : (
          <Input
            aria-label={
              channel === "phone" ? "Phone number" : channel === "email" ? "Email" : "PropLane code"
            }
            placeholder={
              channel === "phone" ? "Phone number" : channel === "email" ? "Email" : "PropLane code"
            }
            value={sendValue}
            onChange={(e) => setSendValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSend) void send();
            }}
            data-attr="workspace-invite-add"
          />
        )}

        <WorkspacePermissionsFields
          role={role}
          onRoleChange={changeRole}
          houseScope={houseScope}
          onHouseScopeChange={changeHouseScope}
          selectedHouseIds={selectedHouseIds}
          onSelectedHouseIdsChange={changeSelectedHouseIds}
          workspace={{ name: workspace.name, houseCount: workspace.propertyIds.length }}
          houseOptions={houseOptions}
          roleDataAttr="workspace-invite-role"
          houseScopeDataAttr="workspace-invite-houses"
          selectedHousesDataAttr="workspace-invite-selected-houses"
        />

        {role === "custom" ? (
          <>
            <CoManagerPermissionsEditor hideRole value={customPermissions} onChange={changeCustomPermissions} />
            <WorkspaceGrantFields value={workspacePermissions} onChange={setWorkspacePermissions} />
          </>
        ) : (
          <RoleCapabilitiesList role={role} grant={effectivePermissions} />
        )}
      </div>
    </Modal>
  );
}
