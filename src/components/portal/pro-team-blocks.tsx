"use client";

/**
 * Members and pending invites, rendered inside each workspace card on
 * Settings → Workspaces (under "Managers & permissions").
 *
 * Per-record actions live in a far-right ⋯ (Edit permissions, Remove),
 * matching Properties. Edit permissions opens a sheet on this page — not a
 * member tab. The owner row has no menu. Invite sits on the section header,
 * not inside this block.
 */

import type { ReactNode } from "react";
import { Hourglass, MoreHorizontal } from "lucide-react";
import { InboxAvatar } from "@/components/portal/portal-inbox-ui";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";

export type TeamMemberRow = {
  id: string;
  name: string;
  /** Axis id or email — the second line under the name. */
  detail: string;
  role: "owner" | "co_manager";
  /** Product role stamp on a co-manager (Viewer, Leasing, …). */
  roleLabel?: string;
  /** "All houses" or "3 of 10 houses" */
  propertiesLabel: string;
  /** ISO date the link became active; null for the owner. */
  joinedAt: string | null;
  /** A one-line flag under the name, such as a legacy-rights review. */
  note?: string;
  /** Menu wording for the destructive action; "Disconnect" when absent. */
  removeLabel?: string;
  onEdit?: () => void;
  /** Promotes this member to main manager of one or more houses. */
  onTransfer?: () => void;
  onDisconnect?: () => void;
};

type TeamRowMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  dataAttr?: string;
};

function TeamRowMenu({ label, items }: { label: string; items: TeamRowMenuItem[] }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        aria-label={`Actions for ${label}`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-portal-row-ignore
        data-attr="team-member-actions"
      >
        <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={`Actions for ${label}`} data-attr="team-member-actions-menu">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            data-attr={item.dataAttr}
            className={item.destructive ? "text-[var(--status-overdue-fg)]" : undefined}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Role and houses as one plain line (e.g. "Leasing · All houses"). Editing is via ⋯ → Edit permissions. */
export function TeamRowValues({ row }: { row: TeamMemberRow }) {
  if (row.role === "owner") {
    return <span className="whitespace-nowrap text-sm text-foreground" data-attr="team-owner-values">Owner · {row.propertiesLabel}</span>;
  }
  const role = row.roleLabel ?? "Co-manager";
  return (
    <span className="whitespace-nowrap text-sm text-foreground" data-attr="team-row-values">
      {role} · {row.propertiesLabel}
    </span>
  );
}

function BlockShell({
  title,
  count,
  aside,
  children,
  dataAttr,
}: {
  title: string;
  count?: number;
  aside?: ReactNode;
  children: ReactNode;
  dataAttr: string;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <h3 className="text-[14.5px] font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
        {count != null && count > 0 ? (
          <span className="rounded-full bg-[var(--secondary)] px-2 py-px text-[11px] font-semibold tabular-nums text-muted">{count}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">{aside}</span>
      </div>
      {children}
    </section>
  );
}

export function TeamMembersBlock({ members, embedded = false }: { members: TeamMemberRow[]; embedded?: boolean }) {
  const rows = <ul>{members.map((m) => {
    const items = ([
      m.onEdit ? { id: "edit", label: "Edit permissions", onSelect: m.onEdit, dataAttr: "team-member-edit" } : null,
      m.onTransfer ? { id: "transfer", label: "Transfer ownership", onSelect: m.onTransfer, dataAttr: "team-member-transfer" } : null,
      m.onDisconnect ? { id: "disconnect", label: "Remove", onSelect: m.onDisconnect, destructive: true, dataAttr: "team-member-disconnect" } : null,
    ] as (TeamRowMenuItem | null)[]).filter((item): item is TeamRowMenuItem => item != null);
    return <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-0" data-attr="team-member-row">
      <InboxAvatar name={m.name} className="h-8 w-8 shrink-0 text-[11px]" />
      <span className="min-w-[8rem] flex-1"><span className="block truncate text-[15px]">{m.name}</span><span className="block truncate text-xs text-muted">{m.detail}</span>{m.note ? <span className="text-xs text-muted" data-attr="team-member-note">{m.note}</span> : null}</span>
      <TeamRowValues row={m} />{items.length > 0 ? <TeamRowMenu label={m.name} items={items} /> : <span className="hidden size-11 shrink-0 sm:block" aria-hidden />}
    </li>;
  })}</ul>;
  return embedded ? <div data-attr="team-members-block">{rows}</div> : <BlockShell title="Managers" dataAttr="team-members-block">{rows}</BlockShell>;
}

export function TeamPendingInvitesBlock({
  invites,
  propertiesLabel,
  onRevoke,
  onAccept,
  onDecline,
  onOpen,
  expiryLabel,
  roleLabel,
  embedded = false,
}: {
  invites: AccountLinkInviteDto[];
  /** Inside a workspace card: plain rows under the members, no card shell. */
  embedded?: boolean;
  propertiesLabel: (inv: AccountLinkInviteDto) => string;
  /** "Leasing" — the role the invite carries; omitted on lists that do not show roles. */
  roleLabel?: (inv: AccountLinkInviteDto) => string;
  /** "Expires in 12 days" — the panel owns the wording. */
  expiryLabel: (expiresAt: string | null | undefined) => string;
  onRevoke: (inv: AccountLinkInviteDto) => void;
  onAccept: (inv: AccountLinkInviteDto) => void;
  onDecline: (inv: AccountLinkInviteDto) => void;
  onOpen: (inv: AccountLinkInviteDto) => void;
}) {
  if (invites.length === 0) return null;
  const rows = (
      <ul>
        {invites.map((inv) => {
          const outgoing = inv.direction === "outgoing";
          const name = inv.linkedDisplayName ?? (inv.openInvite ? "Anyone with the link" : inv.linkedAxisId) ?? "Invite";
          const items: TeamRowMenuItem[] = outgoing
            ? [
                { id: "edit", label: "Edit permissions", onSelect: () => onOpen(inv), dataAttr: "team-pending-edit" },
                { id: "revoke", label: "Revoke", onSelect: () => onRevoke(inv), destructive: true, dataAttr: "team-pending-revoke" },
              ]
            : [
                { id: "accept", label: "Accept", onSelect: () => onAccept(inv), dataAttr: "team-pending-accept" },
                { id: "decline", label: "Decline", onSelect: () => onDecline(inv), destructive: true, dataAttr: "team-pending-decline" },
              ];
          return (
            <li key={inv.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3" data-attr="team-pending-row">
              <button type="button" onClick={() => onOpen(inv)} className="flex min-w-[8rem] flex-1 items-center gap-3 text-left">
                <InboxAvatar name={name} className="h-8 w-8 shrink-0 border border-dashed border-border bg-transparent text-[11px]" />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] text-foreground">{name}</span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted">
                    <Hourglass className="size-3 shrink-0" aria-hidden />
                    {outgoing ? "Invited" : "Invited you"}
                    {expiryLabel(inv.expiresAt) ? ` · ${expiryLabel(inv.expiresAt)}` : ""}
                  </span>
                </span>
              </button>
              <TeamRowValues row={{ id: inv.id, name, detail: "", role: "co_manager", roleLabel: roleLabel?.(inv), propertiesLabel: propertiesLabel(inv), joinedAt: null }} />
              <TeamRowMenu label={name} items={items} />
            </li>
          );
        })}
      </ul>
  );
  if (embedded) return <div data-attr="team-pending-block">{rows}</div>;
  return (
    <BlockShell title="Pending invites" count={invites.length} dataAttr="team-pending-block">
      {rows}
    </BlockShell>
  );
}
