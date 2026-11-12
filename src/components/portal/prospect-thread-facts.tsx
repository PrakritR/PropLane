"use client";

/**
 * What the prospect spine stamps on a conversation, drawn as plain glyph facts (never pills): the house and room it is
 * about, where it came from, "Moved to text" once a platform inquiry switched to SMS, a delivery issue with its reason,
 * and a held platform draft the manager copies and opens on the site (nothing is sent by PropLane).
 */
import { AlertCircle, ExternalLink, Home, MessageSquareText } from "lucide-react";
import { CopyIconAction } from "@/components/portal/portal-icon-action";

export type ProspectThreadFactsData = {
  /** "5259 Brooklyn Ave NE · Room 4" or "SpareRoom · 4709a Room 9". */
  about?: string | null;
  movedToText?: boolean;
  deliveryIssue?: { reason: string; direction: "inbound" | "outbound" } | null;
  platformDraft?: { body: string; openUrl?: string | null; siteLabel?: string | null } | null;
};

/** Pure: read the spine's stamps off a thread row. Returns null when the row carries none. */
export function prospectFactsFromThread(thread: {
  prospectContext?: { label?: string | null } | null;
  platformState?: { state?: string | null } | null;
  platformDraft?: { body?: string | null; openUrl?: string | null; siteLabel?: string | null } | null;
  deliveryIssue?: { reason?: string | null; direction?: string | null } | null;
} | null | undefined): ProspectThreadFactsData | null {
  if (!thread) return null;
  const about = thread.prospectContext?.label?.trim() || null;
  const movedToText = thread.platformState?.state === "moved";
  const issue = thread.deliveryIssue?.reason?.trim()
    ? { reason: thread.deliveryIssue.reason.trim(), direction: thread.deliveryIssue.direction === "inbound" ? ("inbound" as const) : ("outbound" as const) }
    : null;
  const draftBody = thread.platformDraft?.body?.trim();
  const platformDraft = draftBody
    ? { body: draftBody, openUrl: thread.platformDraft?.openUrl?.trim() || null, siteLabel: thread.platformDraft?.siteLabel?.trim() || null }
    : null;
  if (!about && !movedToText && !issue && !platformDraft) return null;
  return { about, movedToText, deliveryIssue: issue, platformDraft };
}

export function ProspectThreadFacts({ facts }: { facts: ProspectThreadFactsData }) {
  return (
    <section className="border-t border-border px-[18px] py-3" data-attr="communication-prospect-facts">
      {facts.about ? (
        <p className="flex items-center gap-2 py-0.5 text-[13.5px] text-foreground" data-attr="communication-prospect-about">
          <Home className="size-3.5 shrink-0 text-muted" strokeWidth={2} aria-hidden />
          <span className="min-w-0 truncate" title={facts.about}>about {facts.about}</span>
        </p>
      ) : null}
      {facts.movedToText ? (
        <p className="flex items-center gap-2 py-0.5 text-[13.5px] text-foreground" data-attr="communication-moved-to-text">
          <MessageSquareText className="size-3.5 shrink-0 text-muted" strokeWidth={2} aria-hidden />
          Moved to text
        </p>
      ) : null}
      {facts.deliveryIssue ? (
        <p className="flex items-start gap-2 py-0.5 text-[13.5px] font-medium text-rose-600" data-attr="communication-delivery-issue">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span className="min-w-0 break-words">{facts.deliveryIssue.reason}</span>
        </p>
      ) : null}
      {facts.platformDraft ? (
        <div className="mt-2 rounded-md border border-border p-2.5" data-attr="communication-platform-draft">
          <div className="flex items-start gap-1">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-foreground/85">{facts.platformDraft.body}</p>
            <CopyIconAction
              label="Copy reply"
              className="size-7 md:size-7 lg:size-7"
              data-attr="communication-platform-draft-copy"
              onCopy={() => navigator.clipboard?.writeText(facts.platformDraft!.body).catch(() => {})}
            />
          </div>
          {facts.platformDraft.openUrl ? (
            <a
              href={facts.platformDraft.openUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[13px] text-primary hover:underline"
              data-attr="communication-platform-draft-open"
            >
              Open on {facts.platformDraft.siteLabel || "the site"}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
