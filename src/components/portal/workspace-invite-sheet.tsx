"use client";

/**
 * Invite to a workspace: one sheet, three rows — send by phone/email/code,
 * copy the shareable link, and see who already has access. Opened by
 * `ProAccountLinksPanel`'s `openLinkModal(workspaceId)`.
 *
 * The link and the send box share ONE access setting (role + houses). Every
 * time that setting changes, the active link is re-minted with
 * `replaceActive: true` so a URL already sent can never gain more power than
 * whoever sent it agreed to (see `docs/agents/co-manager-access.md`).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InboxAvatar } from "@/components/portal/portal-inbox-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { parseInviteRecipient, inviteRecipientHint } from "@/lib/invite-recipient";
import {
  CoManagerPermissionsEditor,
  WorkspaceGrantFields,
} from "@/components/portal/pro-account-links-panel";
import type { PortalWorkspace } from "@/lib/workspaces/types";
import { memberReachLabel, type HouseScope } from "@/lib/workspaces/membership";
import {
  TEAM_ROLE_INVITE_OPTIONS,
  TEAM_ROLE_LABELS,
  stampTeamRolePermissions,
  type TeamRoleId,
} from "@/lib/co-manager-team-roles";
import {
  EMPTY_CO_MANAGER_PERMISSIONS,
  normalizePropertyCoManagerPermissions,
  type CoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  type WorkspaceCoManagerGrant,
} from "@/lib/workspace-co-manager-permissions";
import { mintInviteLinkClient, revealInviteLinkClient } from "@/lib/invite-links/mint-invite-link-client";
import { formatInviteMessageBody, formatInviteMessageSubject } from "@/lib/invite-message-body";
import { deliverManagerDirectoryMessage } from "@/lib/manager-vendor-invite-client";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import { teamRoleListLabel } from "@/lib/co-manager-team-roles";
import { cn } from "@/lib/utils";

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

/** Role + houses, one control, one trigger — a single-select cannot hold two independent decisions at once. */
function AccessChip({
  role,
  onRoleChange,
  houseScope,
  onHouseScopeChange,
  workspace,
  disabled,
}: {
  role: TeamRoleId;
  onRoleChange: (next: TeamRoleId) => void;
  houseScope: HouseScope;
  onHouseScopeChange: (next: HouseScope) => void;
  workspace: PortalWorkspace;
  disabled?: boolean;
}) {
  const houseLabel = houseScope === "all" ? `All houses in ${workspace.name}` : "Only selected houses";
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        disabled={disabled}
        data-attr="workspace-invite-access"
        className="flex min-h-11 flex-1 items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 text-left text-[13.5px] font-medium text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">
          Joins as {roleLabelFor(role)} · {houseLabel}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Access" data-attr="workspace-invite-access-menu">
        <DropdownMenuLabel>Role</DropdownMenuLabel>
        {TEAM_ROLE_INVITE_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            data-attr={`workspace-invite-role-${option.value}`}
            onSelect={(e) => {
              e.preventDefault();
              onRoleChange(option.value);
            }}
          >
            {role === option.value ? <Check /> : <span className="size-4 shrink-0" aria-hidden />}
            {option.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Houses</DropdownMenuLabel>
        <DropdownMenuItem
          data-attr="workspace-invite-houses-all"
          onSelect={(e) => {
            e.preventDefault();
            onHouseScopeChange("all");
          }}
        >
          {houseScope === "all" ? <Check /> : <span className="size-4 shrink-0" aria-hidden />}
          All houses in {workspace.name}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-attr="workspace-invite-houses-selected"
          onSelect={(e) => {
            e.preventDefault();
            onHouseScopeChange("selected");
          }}
        >
          {houseScope === "selected" ? <Check /> : <span className="size-4 shrink-0" aria-hidden />}
          Only selected houses…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceInviteSheet({
  open,
  workspace,
  onClose,
  onChanged,
  onEditMember,
}: {
  open: boolean;
  workspace: PortalWorkspace;
  onClose: () => void;
  onChanged: () => void;
  /** Opens the existing member's permissions sheet (the panel already owns this flow). */
  onEditMember: (linkId: string) => void;
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
  const mintedOnceRef = useRef(false);

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

  const houseIds = useMemo(
    () => (houseScope === "all" ? workspace.propertyIds : selectedHouseIds),
    [houseScope, selectedHouseIds, workspace.propertyIds],
  );

  const reach = useMemo(
    () => reachLabelFor({ houseScope, workspace, selectedHouseIds }),
    [houseScope, workspace, selectedHouseIds],
  );

  // Reset and load fresh every time the sheet opens for a (possibly new) workspace.
  useEffect(() => {
    if (!open) return;
    setRole("viewer");
    setHouseScope("all");
    setSelectedHouseIds([]);
    setCustomPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
    setWorkspacePermissions(DEFAULT_NEW_INVITE_WORKSPACE_GRANT);
    setLinkId(null);
    setLinkUrl(null);
    setSendValue("");
    setSentThisSession([]);
    mintedOnceRef.current = false;
    let cancelled = false;
    setLinkLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/pro/invite-links?workspaceId=${encodeURIComponent(workspace.id)}`, {
          credentials: "include",
        });
        const data = (await res.json().catch(() => ({}))) as { link?: { id?: string } | null };
        if (cancelled) return;
        if (data.link?.id) {
          setLinkId(data.link.id);
          mintedOnceRef.current = true;
          return;
        }
        const result = await mintInviteLinkClient({
          kind: "manager",
          workspaceId: workspace.id,
          assignedPropertyIds: workspace.propertyIds,
          propertyLabelsById: workspace.propertyLabels,
          teamRole: "viewer",
          houseScope: "all",
        });
        if (cancelled) return;
        if (result.ok) {
          setLinkId(result.linkId);
          setLinkUrl(result.url);
        } else {
          showToast(result.error);
        }
        mintedOnceRef.current = true;
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

  /**
   * `role`/`houseScope`/`houseIds`/`effectivePermissions` are this render's
   * committed state, not the value a caller just changed (`setState` is
   * async). Every mutator below passes its NEW value through `next` so the
   * mint always reflects what the manager just picked, not last render's.
   */
  const remint = async (
    reasonToast?: string,
    next?: { role?: TeamRoleId; houseScope?: HouseScope; houseIds?: string[]; permissions?: CoManagerPermissions },
  ) => {
    const nextRole = next?.role ?? role;
    const nextHouseScope = next?.houseScope ?? houseScope;
    const nextHouseIds =
      next?.houseIds ??
      (next?.houseScope ? (next.houseScope === "all" ? workspace.propertyIds : selectedHouseIds) : houseIds);
    const nextPermissions =
      next?.permissions ??
      (next?.role
        ? (nextRole === "custom" ? customPermissions : stampTeamRolePermissions(nextRole) ?? EMPTY_CO_MANAGER_PERMISSIONS)
        : effectivePermissions);
    setLinkLoading(true);
    try {
      const result = await mintInviteLinkClient({
        kind: "manager",
        workspaceId: workspace.id,
        assignedPropertyIds: nextHouseIds,
        propertyPermissions: normalizePropertyCoManagerPermissions(
          Object.fromEntries(nextHouseIds.map((id) => [id, nextPermissions])),
          nextHouseIds,
        ),
        propertyLabelsById: workspace.propertyLabels,
        teamRole: nextRole,
        houseScope: nextHouseScope,
        replaceActive: true,
      });
      if (result.ok) {
        setLinkId(result.linkId);
        setLinkUrl(result.url);
        if (reasonToast) showToast(reasonToast);
      } else {
        showToast(result.error);
      }
    } finally {
      setLinkLoading(false);
    }
  };

  const changeRole = (next: TeamRoleId) => {
    setRole(next);
    if (mintedOnceRef.current) {
      void remint("Link updated. Anyone with the old link will need the new one.", { role: next });
    }
  };

  const changeHouseScope = (next: HouseScope) => {
    setHouseScope(next);
    if (mintedOnceRef.current) {
      void remint("Link updated. Anyone with the old link will need the new one.", { houseScope: next });
    }
  };

  const remintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRemint = (next?: { houseIds?: string[]; permissions?: CoManagerPermissions }) => {
    if (remintTimerRef.current) clearTimeout(remintTimerRef.current);
    remintTimerRef.current = setTimeout(() => {
      void remint("Link updated. Anyone with the old link will need the new one.", next);
    }, 500);
  };
  useEffect(() => () => {
    if (remintTimerRef.current) clearTimeout(remintTimerRef.current);
  }, []);

  const changeSelectedHouseIds = (next: string[]) => {
    setSelectedHouseIds(next);
    if (mintedOnceRef.current) debouncedRemint({ houseIds: next });
  };

  const changeCustomPermissions = (next: CoManagerPermissions) => {
    setCustomPermissions(next);
    if (mintedOnceRef.current) debouncedRemint({ permissions: next });
  };

  const copyLink = async () => {
    let url = linkUrl;
    if (!url && linkId) {
      const result = await revealInviteLinkClient(linkId);
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      url = result.url;
      setLinkUrl(url);
    }
    if (!url) {
      showToast("Could not copy the invite link.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast("Invite link copied.");
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
      // create — the invite lives entirely in the link. We still try to
      // deliver a message through the one delivery path the portal has;
      // today that path can only resolve an existing account or an email
      // address, so a bare phone number with no account cannot be reached
      // this way yet (see PR notes) and the manager falls back to Copy link.
      const facts = {
        kind: "workspace" as const,
        inviterName: workspace.name,
        workspaceName: workspace.name,
        propertyLabels: houseIds.map((id) => workspace.propertyLabels?.[id]?.trim() || id),
        inviteUrl: linkUrl ?? undefined,
        roleLabel,
        reach,
      };
      const subject = formatInviteMessageSubject(facts);
      const body = formatInviteMessageBody(facts);
      const result = await deliverManagerDirectoryMessage(
        {
          name: recipient.kind === "email" ? recipient.value : recipient.label,
          email: recipient.kind === "email" ? recipient.value : "",
          subject,
          body,
        },
        false,
        { viaInbox: false, viaEmail: recipient.kind === "email", viaSms: recipient.kind === "phone" },
        undefined,
        {},
      );
      if (!result.ok) {
        showToast(
          recipient.kind === "phone"
            ? "Can't text that number yet — copy the link and send it yourself."
            : result.message,
        );
        return;
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
          {sendFocused || sendValue ? (
            <p className="text-xs text-muted" data-attr="workspace-invite-hint">
              {inviteRecipientHint(recipient)}
            </p>
          ) : null}
        </div>

        {/* 2. Link */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="shrink-0 rounded-full"
              loading={linkLoading}
              onClick={() => void copyLink()}
              data-attr="workspace-invite-copy"
            >
              <Link2 className="h-4 w-4" />
              <span className="ml-1.5">Copy link</span>
            </Button>
            <AccessChip
              role={role}
              onRoleChange={changeRole}
              houseScope={houseScope}
              onHouseScopeChange={changeHouseScope}
              workspace={workspace}
            />
          </div>

          {houseScope === "selected" ? (
            <CheckboxMultiSelect
              label="Selected houses"
              options={workspace.propertyIds.map((id) => ({
                value: id,
                label: workspace.propertyLabels?.[id]?.trim() || id,
              }))}
              selected={selectedHouseIds}
              onChange={changeSelectedHouseIds}
              emptyLabel="Select houses…"
              searchPlaceholder="Search houses…"
              dataAttr="workspace-invite-selected-houses"
            />
          ) : null}

          {role === "custom" ? (
            <>
              <CoManagerPermissionsEditor hideRole value={customPermissions} onChange={changeCustomPermissions} />
              <WorkspaceGrantFields value={workspacePermissions} onChange={setWorkspacePermissions} />
            </>
          ) : null}
        </div>

        {/* 3. Who has access */}
        <div className="space-y-2" data-attr="workspace-invite-access-list">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Who has access</p>
          <ul className="divide-y divide-border/60 rounded-xl border border-border bg-card">
            <li className="flex items-center gap-2.5 px-3 py-2.5">
              <InboxAvatar name={owner} className="h-8 w-8 shrink-0 text-[11px]" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{owner}</span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">Owner</span>
            </li>
            {acceptedMembers.map((m) => (
              <li key={m.linkId} className="flex items-center gap-2.5 px-3 py-2.5">
                <InboxAvatar name={m.name} className="h-8 w-8 shrink-0 text-[11px]" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{m.name}</span>
                <button
                  type="button"
                  className="shrink-0 rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[11px] font-semibold text-muted transition hover:bg-accent/60"
                  data-attr="workspace-invite-member-chip"
                  onClick={() => onEditMember(m.linkId)}
                >
                  {roleLabelFor(m.role)} ·{" "}
                  {memberReachLabel({
                    houseScope: m.houseScope,
                    houseCount: m.propertyIds.length,
                    workspaceHouseCount: workspace.propertyIds.length,
                  })}
                </button>
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
