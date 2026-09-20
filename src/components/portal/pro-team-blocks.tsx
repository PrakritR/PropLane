"use client";

/**
 * Members and pending invites, rendered inside each workspace card on
 * Settings → Workspaces (under "Managers & permissions") and on the Teams page.
 *
 * Per-record actions live in a far-right ⋯ (Edit permissions, Disconnect),
 * matching Properties. Edit permissions opens a sheet on this page — not a
 * member tab. The owner row has no menu. Invite sits on the section header,
 * not inside this block.
 */

import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { InboxAvatar } from "@/components/portal/portal-inbox-ui";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { cn } from "@/lib/utils";

export type TeamMemberRow = {
  id: string;
  name: string;
  /** Axis id or email — the second line under the name. */
  detail: string;
  role: "owner" | "co_manager";
  /** Product role stamp on a co-manager (Viewer, Leasing, …). */
  roleLabel?: string;
  /** "3 houses · Ash Flats 6, Birch Flats 7" */
  propertiesLabel: string;
  /** ISO date the link became active; null for the owner. */
  joinedAt: string | null;
  onEdit?: () => void;
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
      <DropdownMenuContent align="end" glass={false} backdrop={false} aria-label={`Actions for ${label}`} data-attr="team-member-actions-menu">
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

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const ROLE_PILL: Record<TeamMemberRow["role"], { label: string; className: string }> = {
  owner: { label: "Owner", className: "bg-primary/10 text-primary" },
  co_manager: { label: "Co-manager", className: "bg-[var(--secondary)] text-muted" },
};

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

const MEMBER_GRID = "md:grid md:grid-cols-[minmax(0,1.4fr)_110px_minmax(0,1fr)_120px_44px] md:items-center md:gap-x-3";

/**
 * `embedded` drops the card shell: the workspace card already is the card, and
 * its "Managers & permissions" header carries the title and Invite.
 */
export function TeamMembersBlock({ members, embedded = false }: { members: TeamMemberRow[]; embedded?: boolean }) {
  const columns = (
    <div className={cn("hidden px-4 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted/70", MEMBER_GRID)} aria-hidden>
      <span>Member</span>
      <span>Role</span>
      <span>Properties</span>
      <span>Joined</span>
      <span />
    </div>
  );
  const rows = (
      <ul>
        {members.map((m) => {
          const pill = ROLE_PILL[m.role];
          const pillLabel = m.role === "co_manager" ? (m.roleLabel ?? pill.label) : pill.label;
          const items = ([
            m.onEdit ? { id: "edit", label: "Edit permissions", onSelect: m.onEdit, dataAttr: "team-member-edit" } : null,
            m.onDisconnect ? { id: "disconnect", label: "Disconnect", onSelect: m.onDisconnect, destructive: true, dataAttr: "team-member-disconnect" } : null,
          ] as (TeamRowMenuItem | null)[]).filter((item): item is TeamRowMenuItem => item != null);
          return (
            <li key={m.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2.5", MEMBER_GRID)} data-attr="team-member-row">
              <span className="flex min-w-0 items-center gap-2.5">
                <InboxAvatar name={m.name} className="h-8 w-8 shrink-0 text-[11px]" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold text-foreground">{m.name}</span>
                  <span className="block truncate text-[12px] text-muted">{m.detail}</span>
                </span>
              </span>
              <span>
                <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", pill.className)}>{pillLabel}</span>
              </span>
              <span className="min-w-0 truncate text-[13px] text-foreground max-md:basis-full max-md:text-[12px] max-md:text-muted">{m.propertiesLabel}</span>
              <span className="text-[12.5px] text-muted max-md:hidden">{shortDate(m.joinedAt)}</span>
              <span className="ml-auto md:ml-0 md:justify-self-end">
                <TeamRowMenu label={m.name} items={items} />
              </span>
            </li>
          );
        })}
      </ul>
  );
  if (embedded) {
    return (
      <div data-attr="team-members-block">
        {columns}
        {rows}
      </div>
    );
  }
  return (
    <BlockShell title="Members" count={members.length} dataAttr="team-members-block">
      {columns}
      {rows}
    </BlockShell>
  );
}

export function TeamPendingInvitesBlock({
  invites,
  propertiesLabel,
  onRevoke,
  onAccept,
  onDecline,
  onOpen,
  expiryLabel,
  embedded = false,
}: {
  invites: AccountLinkInviteDto[];
  /** Inside a workspace card: plain rows under the members, no card shell. */
  embedded?: boolean;
  propertiesLabel: (inv: AccountLinkInviteDto) => string;
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
                { id: "edit", label: "Edit", onSelect: () => onOpen(inv), dataAttr: "team-pending-edit" },
                { id: "revoke", label: "Revoke", onSelect: () => onRevoke(inv), destructive: true, dataAttr: "team-pending-revoke" },
              ]
            : [
                { id: "accept", label: "Accept", onSelect: () => onAccept(inv), dataAttr: "team-pending-accept" },
                { id: "decline", label: "Decline", onSelect: () => onDecline(inv), destructive: true, dataAttr: "team-pending-decline" },
              ];
          return (
            <li key={inv.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 px-4 py-2.5" data-attr="team-pending-row">
              <button type="button" onClick={() => onOpen(inv)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                <InboxAvatar name={name} className="h-8 w-8 shrink-0 text-[11px]" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold text-foreground">{name}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {outgoing ? "Invited" : `Invited you`} · {propertiesLabel(inv)} · {expiryLabel(inv.expiresAt)}
                  </span>
                </span>
              </button>
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
