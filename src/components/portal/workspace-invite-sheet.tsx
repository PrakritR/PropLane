"use client";

/**
 * Invite to a workspace: one sheet, three rows — send by phone/email/code,
 * the same Role / Houses / Selected houses system Edit permissions renders
 * (shared from `workspace-permissions-fields.tsx` so the two never drift),
 * and who already has access. Opened by `ProAccountLinksPanel`'s
 * `openLinkModal(workspaceId)`.
 *
 * The link and the send box share ONE access setting (role + houses). Opening
 * the sheet only READS the workspace's active link (hydrating role/houses/
 * permissions from it) and never mints as a side effect. Changing the form
 * only updates local state. A link is minted or re-minted — always with
 * `replaceActive: true` — only at the moment "Copy link" or Send is pressed,
 * and only when the on-screen terms differ from the held link's terms, so an
 * already-shared URL never gains power without the sender re-confirming it
 * (see `docs/agents/co-manager-access.md`). The default Houses scope is
 * capped to the inviter's own reach — an Admin whose own membership is
 * scoped to selected houses defaults to "Only selected houses" too, rather
 * than silently offering every house in the workspace.
 *
 * "Copy link" resolves that URL, writes it to the clipboard, then advances
 * to a SECOND VIEW of this same sheet (`view: "link"`) — the form (recipient
 * field, Send, the permissions fields) is gone, replaced by the read-only
 * URL, a "Joins as" line reading the same role/houses state, and Copy /
 * Share / Back / Done. Back returns to the form with role/houses untouched,
 * Done closes the sheet.
 */

import { useEffect, useMemo, useState } from "react";
import { Copy, Link2, MoreHorizontal } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InboxAvatar } from "@/components/portal/portal-inbox-ui";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
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
import type { AccountLinkInviteDto } from "@/lib/account-links";
import { teamRoleListLabel } from "@/lib/co-manager-team-roles";

type LocalSentInvite = {
  id: string;
  label: string;
  channel: "phone" | "email";
  at: string;
  roleLabel: string;
  reach: string;
};

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
  onEditMember,
  inviterName,
}: {
  open: boolean;
  workspace: PortalWorkspace;
  onClose: () => void;
  onChanged: () => void;
  /** Opens the existing member's permissions sheet (the panel already owns this flow). */
  onEditMember: (linkId: string) => void;
  /** The manager sending the invite — used in the emailed/texted message body, never the workspace name. */
  inviterName: string;
}) {
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
  /**
   * `"form"` is the send + permissions-fields sheet. `"link"` is a second view
   * of the SAME sheet reached only by pressing Copy link — the link is shown
   * read-only, Copy/Share/Back/Done replace the form, and Back returns here
   * with role/houses untouched (see `docs/agents/co-manager-access.md`).
   */
  const [view, setView] = useState<"form" | "link">("form");

  const [pendingInvites, setPendingInvites] = useState<AccountLinkInviteDto[]>([]);
  const [sentThisSession, setSentThisSession] = useState<LocalSentInvite[]>([]);

  const [sendValue, setSendValue] = useState("");
  const [sendFocused, setSendFocused] = useState(false);
  const [sending, setSending] = useState(false);

  const recipient = useMemo(() => parseInviteRecipient(sendValue), [sendValue]);
  const canSend = recipient.kind === "phone" || recipient.kind === "email" || recipient.kind === "code";

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

  /** The on-screen permissions fields exactly describe the link Copy/Send would hand out. */
  const termsMatchHeldLink = heldTerms != null && termsMatch(heldTerms, currentTerms);

  // Reset and read the workspace's existing link every time the sheet opens
  // for a (possibly new) workspace. This never mints — Copy link and Send own
  // that, at the moment the manager actually shares something. The default
  // Houses scope is capped to the inviter's own reach in this workspace.
  useEffect(() => {
    if (!open) return;
    setView("form");
    setRole("viewer");
    setHouseScope(defaultHouseScopeFor(workspace));
    setSelectedHouseIds([]);
    setCustomPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
    setWorkspacePermissions(DEFAULT_NEW_INVITE_WORKSPACE_GRANT);
    setLinkId(null);
    setLinkUrl(null);
    setHeldTerms(null);
    setSendValue("");
    setSentThisSession([]);
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

  const loadPendingInvites = useMemo(
    () => async () => {
      try {
        const res = await fetch("/api/pro/account-links", { credentials: "include" });
        const data = (await res.json().catch(() => ({}))) as { invites?: AccountLinkInviteDto[] };
        const invites = Array.isArray(data.invites) ? data.invites : [];
        setPendingInvites(invites.filter((inv) => inv.status === "pending" && inv.workspaceId === workspace.id));
      } catch {
        /* best-effort — the panel's own list stays authoritative */
      }
    },
    [workspace.id],
  );

  useEffect(() => {
    if (!open) return;
    void loadPendingInvites();
  }, [open, loadPendingInvites]);

  const changeRole = (next: TeamRoleId) => setRole(next);
  const changeHouseScope = (next: HouseScope) => setHouseScope(next);
  const changeSelectedHouseIds = (next: string[]) => setSelectedHouseIds(next);
  const changeCustomPermissions = (next: CoManagerPermissions) => setCustomPermissions(next);

  /**
   * The URL for what is on screen right now. Reuses the held link's URL
   * (revealing it if not already in hand) when its terms still match the
   * permissions fields; otherwise mints a fresh link with `replaceActive:
   * true` so the new URL always matches what is about to be copied or sent,
   * and any URL already out in the world stops working. Only toasts about a
   * replacement when a prior link actually existed to replace.
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

  const copyLinkUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      showToast("Invite link copied.");
    } catch {
      showToast("Could not copy. Select the link and copy it manually.");
    }
  };

  /**
   * The one "Copy link" action: resolve (reuse-or-mint) the URL for what is
   * on screen, copy it, then advance to the read-only link view.
   */
  const copyLinkForCurrentTerms = async () => {
    setLinkLoading(true);
    try {
      const result = await resolveLinkForCurrentTerms();
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      await copyLinkUrl(result.url);
      setView("link");
    } finally {
      setLinkLoading(false);
    }
  };

  const shareLink = async () => {
    if (!linkUrl) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `Invite to ${workspace.name}`, url: linkUrl });
        return;
      } catch {
        return; // the share sheet was dismissed — nothing else to do.
      }
    }
    try {
      await navigator.clipboard.writeText(linkUrl);
      showToast("Link copied.");
    } catch {
      showToast("Could not copy. Select the link and copy it manually.");
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
        void loadPendingInvites();
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
      setSentThisSession((prev) => [
        {
          id: `${Date.now()}`,
          label: recipient.label,
          channel: recipient.kind,
          at: new Date().toISOString(),
          roleLabel,
          reach,
        },
        ...prev,
      ]);
      setSendValue("");
    } finally {
      setSending(false);
    }
  };

  const owner = workspace.owned ? "You" : "Workspace owner";
  const acceptedMembers = workspace.members?.filter((m) => m.status === "accepted") ?? [];

  const resendCodeInvite = async (inviteId: string) => {
    try {
      const res = await fetch(`/api/pro/account-links/${encodeURIComponent(inviteId)}/link`, {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as { inviteUrl?: string; error?: string };
      if (!res.ok || !data.inviteUrl) {
        showToast(data.error ?? "Could not prepare a fresh invite link.");
        return;
      }
      await navigator.clipboard.writeText(data.inviteUrl);
      showToast("Invite link copied — share it again.");
    } catch {
      showToast("Could not prepare a fresh invite link.");
    }
  };

  if (view === "link") {
    return (
      <Modal
        open={open}
        title={`Invite link · ${workspace.name}`}
        onClose={onClose}
        panelClassName="max-w-lg"
        dataAttr="workspace-invite-sheet"
        footer={
          <ModalFooter>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => setView("form")} data-attr="workspace-invite-back">
              Back
            </Button>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => void shareLink()} data-attr="workspace-invite-share">
              Share
            </Button>
            <Button type="button" variant="primary" className="rounded-full" onClick={onClose} data-attr="workspace-invite-done">
              Done
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          {/* Modal's own header has no action slot for a call site — Copy lives
              here, top-right of this view's content, per the icon-chrome rule. */}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Invite link</p>
            <PortalIconAction icon={Copy} label="Copy link" onClick={() => void copyLinkUrl(linkUrl ?? "")} data-attr="workspace-invite-copy-link" />
          </div>
          <Input
            readOnly
            value={linkUrl ?? ""}
            aria-label="Invite link"
            className="truncate font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
            data-attr="workspace-invite-link-url"
          />
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5">
            <span className="text-[13px] font-medium text-muted">Joins as</span>
            <span className="truncate text-[13.5px] font-semibold text-foreground" data-attr="workspace-invite-link-access">
              {roleLabelFor(role)} · {reach}
            </span>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} title={`Invite to ${workspace.name}`} onClose={onClose} panelClassName="max-w-lg" dataAttr="workspace-invite-sheet">
      <div className="space-y-5">
        {/* 1. Send */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Add people"
              placeholder="Phone, email or PropLane code"
              value={sendValue}
              onChange={(e) => setSendValue(e.target.value)}
              onFocus={() => setSendFocused(true)}
              onBlur={() => setSendFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSend) void send();
              }}
              data-attr="workspace-invite-add"
            />
            <Button
              type="button"
              variant="primary"
              className="shrink-0 rounded-full"
              disabled={!canSend}
              loading={sending}
              onClick={() => void send()}
              data-attr="workspace-invite-send"
            >
              Send
            </Button>
          </div>
        </div>

        {/* 2. Permissions — the same Role / Houses / Selected houses system Edit permissions renders */}
        <div className="space-y-3">
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

          <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-accent/10 px-3.5 py-2.5">
            <span className="text-[13px] text-muted">Links keep the rights they were made with.</span>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 rounded-full"
              loading={linkLoading}
              onClick={() => void copyLinkForCurrentTerms()}
              data-attr="workspace-invite-copy"
            >
              <Link2 className="h-4 w-4" />
              <span className="ml-1.5">Copy link</span>
            </Button>
          </div>
        </div>

        {/* 3. Who has access */}
        <div className="space-y-2" data-attr="workspace-invite-access-list">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Who has access</p>
          <ul className="divide-y divide-border/60 rounded-xl border border-border bg-card">
            <li className="flex items-center gap-2.5 px-3 py-2.5">
              <InboxAvatar name={owner} className="h-8 w-8 shrink-0 text-[11px]" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground" data-attr="workspace-invite-owner-fact">
                <span className="font-medium">{owner}</span> · Owner
              </span>
            </li>
            {acceptedMembers.map((m) => (
              <li key={m.linkId} className="flex items-center gap-2.5 px-3 py-2.5">
                <InboxAvatar name={m.name} className="h-8 w-8 shrink-0 text-[11px]" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground" data-attr="workspace-invite-member-fact">
                  <span className="font-medium">{m.name}</span> · {roleLabelFor(m.role)} ·{" "}
                  {memberReachLabel({
                    houseScope: m.houseScope,
                    houseCount: m.propertyIds.length,
                    workspaceHouseCount: workspace.propertyIds.length,
                  })}
                </span>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger
                    type="button"
                    aria-label={`Actions for ${m.name}`}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-accent/60 hover:text-foreground"
                    data-attr="workspace-invite-member-actions"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" aria-label={`Actions for ${m.name}`} data-attr="workspace-invite-member-actions-menu">
                    <DropdownMenuItem data-attr="workspace-invite-member-edit" onSelect={() => onEditMember(m.linkId)}>
                      Edit permissions
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
            {pendingInvites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-2.5 px-3 py-2.5" data-attr="workspace-invite-pending-row">
                <InboxAvatar name={inv.linkedDisplayName ?? inv.linkedAxisId} className="h-8 w-8 shrink-0 text-[11px]" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  <span className="block truncate font-medium">{inv.linkedDisplayName ?? inv.linkedAxisId}</span>
                  <span className="block truncate text-[11.5px] text-muted">
                    code · {new Date(inv.createdAt).toLocaleDateString()}
                    {inv.teamRole ? ` · ${teamRoleListLabel(inv.teamRole)}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="shrink-0 text-[12px] font-semibold text-primary"
                  data-attr="workspace-invite-resend"
                  onClick={() => void resendCodeInvite(inv.id)}
                >
                  Resend
                </button>
              </li>
            ))}
            {sentThisSession.map((s) => (
              <li key={s.id} className="flex items-center gap-2.5 px-3 py-2.5" data-attr="workspace-invite-session-row">
                <InboxAvatar name={s.label} className="h-8 w-8 shrink-0 text-[11px]" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  <span className="block truncate font-medium">{s.label}</span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {s.channel} · {new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ·{" "}
                    {s.roleLabel}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
