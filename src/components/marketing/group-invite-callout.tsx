"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { buildGroupApplyPath } from "@/lib/rental-application/group-apply-link";

export function GroupInviteCallout({
  leaderAppId,
  groupSize,
  organizerName,
  propertyId,
  className,
  pendingSubmit = false,
}: {
  leaderAppId: string;
  groupSize?: string;
  organizerName?: string;
  propertyId?: string;
  className?: string;
  /** Wizard step — link is shown early but only works after the organizer submits. */
  pendingSubmit?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const invitePath = buildGroupApplyPath(leaderAppId, { propertyId });
  const inviteUrl =
    typeof window !== "undefined" ? `${window.location.origin}${invitePath}` : invitePath;
  const size = Number.parseInt((groupSize ?? "").trim(), 10);
  const others = Number.isFinite(size) && size >= 2 ? size - 1 : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — link stays visible to copy manually.
    }
  };

  return (
    <div className={`text-left ${className ?? ""}`}>
      {/* Compact: one header line carries the label, the recipient count and the
          Group ID that used to occupy three stacked blocks. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-[13px] font-semibold text-foreground">Roommate invite</p>
        {others != null ? (
          <span className="text-[12px] text-muted">
            send to {others} {others === 1 ? "roommate" : "roommates"} of {size}
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted">{leaderAppId}</span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">
        Each roommate opens this link and applies on their own
        {organizerName ? `, joining ${organizerName}'s group` : ""}.
        {pendingSubmit ? (
          <span className="font-medium text-amber-800 [html[data-theme=dark]_&]:text-amber-200">
            {" "}
            Works once you submit this application.
          </span>
        ) : null}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[11px] text-foreground">
          {inviteUrl}
        </code>
        <Button
          type="button"
          variant="outline"
          className="h-9 shrink-0 rounded-full px-4 text-xs"
          data-attr="group-invite-copy"
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </div>
  );
}
