"use client";

/**
 * Invite to a workspace: one sheet, three rows — send by phone/email/code,
 * copy the shareable link, and see who already has access. Opened by
 * `ProAccountLinksPanel`'s `openLinkModal(workspaceId)`.
 *
 * The link and the send box share ONE access setting (role + houses). Opening
 * the sheet only READS the workspace's active link (hydrating role/houses/
 * permissions from it) and never mints as a side effect. Changing the access
 * chip only updates local state. A link is minted or re-minted — always with
 * `replaceActive: true` — only at the moment of Copy link or Send, and only
 * when the on-screen terms differ from the held link's terms, so an
 * already-shared URL never gains power without the sender re-confirming it
 * (see `docs/agents/co-manager-access.md`).
 */

import { useEffect, useMemo, useState } from "react";
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
import { memberReachLabel, parseHouseScope, type HouseScope } from "@/lib/workspaces/membership";
import {
  TEAM_ROLE_INVITE_OPTIONS,
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

/** The access terms a held link was minted or hydrated with, for comparison against the live UI. */
type HeldLinkTerms = {
  role: TeamRoleId;
  houseScope: HouseScope;
  houseIds: string[];
  permissions: CoManagerPermissions;
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
    return JSON.stringify(held.permissions) === JSON.stringify(current.permissions);
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

  const currentTerms: HeldLinkTerms = useMemo(
    () => ({ role, houseScope, houseIds, permissions: effectivePermissions }),
    [role, houseScope, houseIds, effectivePermissions],
  );

  /** The on-screen access chip exactly describes the link Copy/Send would hand out. */
  const termsMatchHeldLink = heldTerms != null && termsMatch(heldTerms, currentTerms);

  // Reset and read the workspace's existing link every time the sheet opens
  // for a (possibly new) workspace. This never mints — Copy link and Send own
  // that, at the moment the manager actually shares something.
  useEffect(() => {
    if (!open) return;
    setRole("viewer");
    setHouseScope("all");
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

        setRole(nextRole);
        setHouseScope(nextHouseScope);
        setSelectedHouseIds(nextSelectedHouseIds);
        setCustomPermissions(nextCustomPermissions);
        setLinkId(link.id);
        setHeldTerms({ role: nextRole, houseScope: nextHouseScope, houseIds: nextHouseIds, permissions: nextPermissions });
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
   * access chip; otherwise mints a fresh link with `replaceActive: true` so
   * the new URL always matches what is about to be copied or sent, and any
   * URL already out in the world stops working. Only toasts about a
   * replacement when a prior link actually existed to replace.
   */
  const resolveLinkForCurrentTerms = async (): Promise<
    { ok: true; url: string } | { ok: false; error: string }
  > => {
    if (linkId && termsMatchHeldLink) {
      if (linkUrl) return { ok: true, url: linkUrl };
      const result = await revealInviteLinkClient(linkId);
      if (!result.ok) return { ok: false, error: result.error };
      setLinkUrl(result.url);
      return { ok: true, url: result.url };
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
      replaceActive: true,
    });
    if (!result.ok) return { ok: false, error: result.error };
    setLinkId(result.linkId);
    setLinkUrl(result.url);
    setHeldTerms(currentTerms);
    if (hadPriorLink) {
      showToast("Link updated. Anyone with the old link will need the new one.");
    }
    return { ok: true, url: result.url };
  };

  const copyLink = async () => {
    setLinkLoading(true);
    let url: string | null = null;
    try {
      const result = await resolveLinkForCurrentTerms();
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      url = result.url;
    } finally {
      setLinkLoading(false);
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
      //
      // The link must exist and match what is on screen BEFORE the message is
      // built — otherwise a sheet opened onto an existing link, never copied,
      // would email an invite with no URL to accept it with.
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
