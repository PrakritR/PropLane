"use client";

/**
 * The three blocks of the Team tab (Mobbin polish §12), referencing Linear's
 * and Loom's members pages:
 *
 * 1. **Members** — a table: member (avatar, name, id/email) · role pill ·
 *    properties · joined · an Access button that opens the per-member access
 *    editor (the four-level module control from slice 5).
 * 2. **Pending invites** — each with what it grants and when it lapses, and
 *    the two actions that matter: Copy link (resend) and Revoke. An invite
 *    someone sent YOU shows Accept / Decline instead.
 * 3. **Invite by link** — one card; minting a fresh link is what "Reset" means.
 *
 * Pure presentation: every action is a callback the panel already owns.
 */

import { Copy, Link2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { InboxAvatar } from "@/components/portal/portal-inbox-ui";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import { cn } from "@/lib/utils";

export type TeamMemberRow = {
  id: string;
  name: string;
  /** Axis id or email — the second line under the name. */
  detail: string;
  role: "owner" | "co_manager";
  /** "3 houses · Ash Flats 6, Birch Flats 7" */
  propertiesLabel: string;
  /** ISO date the link became active; null for the owner. */
  joinedAt: string | null;
  /** Opens the member's access editor. Absent for the owner. */
  onAccess?: () => void;
  /** Row selection for the bulk Remove bar. Absent for the owner. */
  checked?: boolean;
  onSelectedChange?: (checked: boolean) => void;
};

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
  aside?: React.ReactNode;
  children: React.ReactNode;
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

const MEMBER_GRID = "md:grid md:grid-cols-[16px_minmax(0,1.4fr)_110px_minmax(0,1fr)_120px_92px] md:items-center md:gap-x-3";

export function TeamMembersBlock({ members, onInvite, inviteDisabled }: { members: TeamMemberRow[]; onInvite: () => void; inviteDisabled?: boolean }) {
  return (
    <BlockShell
      title="Members"
      count={members.length}
      dataAttr="team-members-block"
      aside={
        <Button type="button" variant="outline" onClick={onInvite} disabled={inviteDisabled} className="h-8 min-h-0 rounded-full px-3 text-[12.5px]" data-attr="team-members-invite">
          <UserPlus className="size-4" aria-hidden />
          Invite a manager
        </Button>
      }
    >
      <div className={cn("hidden px-4 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted/70", MEMBER_GRID)} aria-hidden>
        <span />
        <span>Member</span>
        <span>Role</span>
        <span>Properties</span>
        <span>Joined</span>
        <span />
      </div>
      <ul>
        {members.map((m) => {
          const pill = ROLE_PILL[m.role];
          return (
            <li key={m.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2.5", MEMBER_GRID)} data-attr="team-member-row">
              <span className="flex w-4 shrink-0 items-center justify-center">
                {m.onSelectedChange ? (
                  <RowSelectCheckbox
                    checked={m.checked ?? false}
                    onChange={(e) => m.onSelectedChange?.(e.target.checked)}
                    aria-label={`Select ${m.name}`}
                  />
                ) : null}
              </span>
              <span className="flex min-w-0 items-center gap-2.5">
                <InboxAvatar name={m.name} className="h-8 w-8 shrink-0 text-[11px]" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold text-foreground">{m.name}</span>
                  <span className="block truncate text-[12px] text-muted">{m.detail}</span>
                </span>
              </span>
              <span>
                <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", pill.className)}>{pill.label}</span>
              </span>
              <span className="min-w-0 truncate text-[13px] text-foreground max-md:basis-full max-md:text-[12px] max-md:text-muted">{m.propertiesLabel}</span>
              <span className="text-[12.5px] text-muted max-md:hidden">{shortDate(m.joinedAt)}</span>
              <span className="md:text-right">
                {m.onAccess ? (
                  <Button type="button" variant="outline" onClick={m.onAccess} className="h-8 min-h-0 rounded-full px-3 text-[12.5px]" data-attr="team-member-access">
                    Access
                  </Button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </BlockShell>
  );
}

export function TeamPendingInvitesBlock({
  invites,
  propertiesLabel,
  onCopyLink,
  onRevoke,
  onAccept,
  onDecline,
  onOpen,
  expiryLabel,
}: {
  invites: AccountLinkInviteDto[];
  propertiesLabel: (inv: AccountLinkInviteDto) => string;
  /** "Expires in 12 days" — the panel owns the wording. */
  expiryLabel: (expiresAt: string | null | undefined) => string;
  onCopyLink: (inv: AccountLinkInviteDto) => void;
  onRevoke: (inv: AccountLinkInviteDto) => void;
  onAccept: (inv: AccountLinkInviteDto) => void;
  onDecline: (inv: AccountLinkInviteDto) => void;
  onOpen: (inv: AccountLinkInviteDto) => void;
}) {
  if (invites.length === 0) return null;
  return (
    <BlockShell title="Pending invites" count={invites.length} dataAttr="team-pending-block">
      <ul>
        {invites.map((inv) => {
          const outgoing = inv.direction === "outgoing";
          const name = inv.linkedDisplayName ?? (inv.openInvite ? "Anyone with the link" : inv.linkedAxisId);
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
              <span className="flex shrink-0 items-center gap-1.5">
                {outgoing ? (
                  <>
                    <Button type="button" variant="outline" onClick={() => onCopyLink(inv)} className="h-8 min-h-0 rounded-full px-3 text-[12.5px]" data-attr="team-pending-resend">
                      <Copy className="size-3.5" aria-hidden />
                      Copy link
                    </Button>
                    <Button type="button" variant="outline" onClick={() => onRevoke(inv)} className="h-8 min-h-0 rounded-full border-rose-200 px-3 text-[12.5px] text-rose-800 portal-danger-outline" data-attr="team-pending-revoke">
                      Revoke
                    </Button>
                  </>
                ) : (
                  <>
                    <Button type="button" onClick={() => onAccept(inv)} className="h-8 min-h-0 rounded-full px-3 text-[12.5px]" data-attr="team-pending-accept">
                      Accept
                    </Button>
                    <Button type="button" variant="outline" onClick={() => onDecline(inv)} className="h-8 min-h-0 rounded-full px-3 text-[12.5px]" data-attr="team-pending-decline">
                      Decline
                    </Button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </BlockShell>
  );
}

export function TeamInviteLinkBlock({ onCreate, disabled }: { onCreate: () => void; disabled?: boolean }) {
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] px-4 py-3" data-attr="team-invite-link-block">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-card text-primary shadow-sm" aria-hidden>
        <Link2 className="size-4" />
      </span>
      <span className="min-w-0 flex-1 basis-[14rem]">
        <span className="block text-[13.5px] font-semibold text-foreground">Invite by link</span>
        <span className="block text-[12px] leading-relaxed text-muted">
          Anyone who opens it signs in and joins. Copying a pending link issues a fresh one and the old one stops working.
        </span>
      </span>
      <Button type="button" variant="outline" onClick={onCreate} disabled={disabled} className="h-9 min-h-0 rounded-full px-3.5 text-[13px]" data-attr="team-invite-link-create">
        Create link
      </Button>
    </section>
  );
}
