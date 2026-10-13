"use client";

import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import type { LeadInviteKind } from "@/lib/lead-invite-email";

export function ShareLeadLinkPreviewPanel({
  kind,
  prospectName,
  prospectEmail,
  prospectPhone,
  propertyTitle,
  viaEmail,
  viaSms,
  senderName,
  workNumber,
  previewBody,
  propertyMissing,
}: {
  kind: LeadInviteKind;
  prospectName: string;
  prospectEmail: string;
  prospectPhone: string;
  propertyTitle: string;
  viaEmail: boolean;
  viaSms: boolean;
  senderName: string;
  workNumber: string;
  previewBody: string;
  propertyMissing: boolean;
}) {
  const channel =
    viaEmail && viaSms ? "Email and text" : viaSms ? "Text" : viaEmail ? "Email" : "Not set";
  const fromLine = viaSms && workNumber ? workNumber : senderName || "PropLane";

  const title =
    kind === "apply"
      ? "Invite preview"
      : kind === "listing"
        ? "Listing preview"
        : kind === "tour"
          ? "Tour preview"
          : "Lease preview";

  return (
    <div className="space-y-3">
      <PreviewPanel
        title={title}
        name={prospectName.trim() || "Prospect"}
        sub={[prospectEmail.trim(), prospectPhone.trim()].filter(Boolean).join(" · ") || "Recipient not set"}
        facts={[
          { label: "Property", value: propertyTitle || "Not set", warn: propertyMissing },
          { label: "Channel", value: channel, warn: !viaEmail && !viaSms },
          { label: "From", value: fromLine },
        ]}
      />
      <section aria-label="Message preview">
        <h3 className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">Recipient receives</h3>
        <div className="max-h-[min(40vh,320px)] overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-border bg-card p-3.5 text-[13px] leading-relaxed text-foreground">
          {previewBody || "Choose a home and recipient to preview the message."}
        </div>
      </section>
    </div>
  );
}
