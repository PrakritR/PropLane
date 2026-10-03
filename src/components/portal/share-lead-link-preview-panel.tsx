"use client";

import { PreviewPanel, type CreatesItem } from "@/components/portal/add-workspace/parts";
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
  recipientReady,
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
  recipientReady: boolean;
}) {
  const channel =
    viaEmail && viaSms ? "Email and text" : viaSms ? "Text" : viaEmail ? "Email" : "Not set";
  const fromLine = viaSms && workNumber ? workNumber : senderName || "PropLane";

  const creates: CreatesItem[] = [];
  if (kind === "apply") {
    creates.push(
      { tone: propertyMissing || !recipientReady ? "warn" : "yes", text: "Application invite with a secure apply link" },
      { tone: viaEmail ? "yes" : "no", text: viaEmail ? "Email to the prospect" : "No email" },
      { tone: viaSms ? "yes" : "no", text: viaSms ? "Text from your work number" : "No text message" },
    );
  } else if (kind === "listing") {
    creates.push(
      { tone: propertyMissing || !recipientReady ? "warn" : "yes", text: "Public listing link in the message" },
      { tone: viaEmail ? "yes" : "no", text: viaEmail ? "Email to the prospect" : "No email" },
      { tone: viaSms ? "yes" : "no", text: viaSms ? "Text from your work number" : "No text message" },
    );
  } else if (kind === "tour") {
    creates.push(
      { tone: propertyMissing || !recipientReady ? "warn" : "yes", text: "Tour scheduling link" },
      { tone: viaEmail ? "yes" : "no", text: viaEmail ? "Email to the prospect" : "No email" },
      { tone: viaSms ? "yes" : "no", text: viaSms ? "Text from your work number" : "No text message" },
    );
  } else {
    creates.push(
      { tone: propertyMissing || !recipientReady ? "warn" : "yes", text: "Lease signing link" },
      { tone: viaEmail ? "yes" : "no", text: viaEmail ? "Email to the prospect" : "No email" },
      { tone: viaSms ? "yes" : "no", text: viaSms ? "Text from your work number" : "No text message" },
    );
  }

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
        creates={creates}
        createsHeading="This will send"
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
