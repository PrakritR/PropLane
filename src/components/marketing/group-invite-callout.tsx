"use client";

import { CopyIconAction } from "@/components/portal/portal-icon-action";
import { buildGroupApplyPath } from "@/lib/rental-application/group-apply-link";

/** Roommate invite: label · group id · link · Copy link icon · one short fact. No explanatory sentence. */
export function GroupInviteCallout({
  leaderAppId,
  propertyId,
  className,
  pendingSubmit = false,
}: {
  leaderAppId: string;
  groupSize?: string;
  organizerName?: string;
  propertyId?: string;
  className?: string;
  /** Wizard step: the link is shown early but only works after the organizer submits. */
  pendingSubmit?: boolean;
}) {
  const invitePath = buildGroupApplyPath(leaderAppId, { propertyId });
  const inviteUrl = typeof window !== "undefined" ? `${window.location.origin}${invitePath}` : invitePath;

  return (
    <div className={`text-left ${className ?? ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-[13px] font-semibold text-foreground">Roommate invite</p>
        <span className="font-mono text-[11px] text-muted">{leaderAppId}</span>
        {pendingSubmit ? <span className="ml-auto text-[12px] text-muted">Works after you submit</span> : null}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[11px] text-foreground">
          {inviteUrl}
        </code>
        <CopyIconAction
          label="Copy link"
          data-attr="group-invite-copy"
          onCopy={() => navigator.clipboard.writeText(inviteUrl).catch(() => undefined)}
        />
      </div>
    </div>
  );
}
