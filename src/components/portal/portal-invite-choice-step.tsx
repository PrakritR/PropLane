"use client";

import type { ReactNode } from "react";
import { Link2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Step-one chooser for invite surfaces: a recommended invite-link card, an "or"
 * divider, then a direct path (PropLane ID, email form, etc.).
 */
export function PortalInviteChoiceStep({
  inviteTitle = "Invite by link",
  inviteDescription,
  onCreateInviteLink,
  inviteLinkDataAttr = "portal-invite-choice-link",
  inviteDisabled = false,
  secondaryTitle,
  secondaryDescription,
  secondaryIcon = "id",
  children,
}: {
  inviteTitle?: string;
  inviteDescription: string;
  onCreateInviteLink: () => void;
  inviteLinkDataAttr?: string;
  inviteDisabled?: boolean;
  secondaryTitle: string;
  secondaryDescription: string;
  /** `id` = PropLane ID path; `person` = email / directory path */
  secondaryIcon?: "id" | "person";
  children: ReactNode;
}) {
  const SecondaryIcon = secondaryIcon === "person" ? UserRound : UserRound;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Link2 className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-foreground">{inviteTitle}</p>
              <Badge tone="info" className="rounded-full px-2 py-0 text-[10px] font-semibold uppercase tracking-wide">
                Recommended
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted">{inviteDescription}</p>
            <Button
              type="button"
              variant="primary"
              className="mt-3 rounded-full"
              disabled={inviteDisabled}
              data-attr={inviteLinkDataAttr}
              onClick={onCreateInviteLink}
            >
              <Link2 className="h-4 w-4" aria-hidden />
              <span className="ml-1.5">Create Invite Link</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide text-muted">or</span>
        <div className="h-px flex-1 bg-border" aria-hidden />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-muted">
            <SecondaryIcon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <p className="text-sm font-semibold text-foreground">{secondaryTitle}</p>
              <p className="mt-0.5 text-sm text-muted">{secondaryDescription}</p>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
