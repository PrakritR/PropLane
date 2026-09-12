"use client";

import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";

export function buildInboxThreadAssistantContext({
  subject,
  email,
  from,
  sentSemantics = false,
}: {
  subject?: string;
  email?: string;
  from?: string;
  sentSemantics?: boolean;
}): string {
  const party = sentSemantics ? email || "recipient" : from || email || "sender";
  const direction = sentSemantics ? "To" : "From";
  const subjectBit = subject?.trim() ? ` · Subject: ${subject.trim()}` : "";
  return `Communication thread · ${direction}: ${party}${subjectBit}`;
}

/** Collapsible PropLane Assistant directly above the thread reply composer. */
export function InboxThreadAssistantStrip({
  contextHint,
  storageScopeKey = "Communication thread",
  hideTrigger = false,
  openSignal,
}: {
  contextHint: string;
  storageScopeKey?: string;
  /** The composer's ✦ menu owns the entry point; keep the strip's own off. */
  hideTrigger?: boolean;
  openSignal?: number;
}) {
  if (!contextHint.trim()) return null;
  return (
    <ModalAssistantStrip
      contextHint={contextHint}
      storageScopeKey={storageScopeKey}
      hideTrigger={hideTrigger}
      openSignal={openSignal}
      className={hideTrigger ? "hidden" : "shrink-0 bg-card px-1 md:px-2"}
    />
  );
}
