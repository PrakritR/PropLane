"use client";

/**
 * Labeled destination into archived conversations.
 *
 * Filter still owns status (All / Read / Unread / Archived) and there is no
 * folder-tab rail. This is the same job as admin's `admin-inbox-archived-toggle`:
 * a visible button that takes the manager to `/communication/archived` and,
 * when that view is already open, back to the live inbox.
 */
import Link from "next/link";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InboxListSegment } from "@/components/portal/portal-inbox-ui";
import { cn } from "@/lib/utils";

export function CommunicationArchivedInboxButton({
  commBase,
  listSegment,
  onViewChange,
  className,
}: {
  commBase: string;
  listSegment: InboxListSegment;
  /** Keeps Filter status in lockstep when the URL does not change. */
  onViewChange?: (next: Extract<InboxListSegment, "active" | "archived">) => void;
  className?: string;
}) {
  const viewingArchived = listSegment === "archived";
  const href = viewingArchived ? `${commBase}/active` : `${commBase}/archived`;
  const nextView = viewingArchived ? "active" : "archived";

  return (
    <Button
      variant="outline"
      asChild
      className={cn("h-10 min-h-10 w-full shrink-0 px-5 py-0 md:min-h-0", className)}
      aria-pressed={viewingArchived || undefined}
      data-attr="communication-archived-inbox-toggle"
    >
      <Link href={href} aria-label="Archived messages" onClick={() => onViewChange?.(nextView)}>
        <Archive className="h-4 w-4" aria-hidden />
        Archived
      </Link>
    </Button>
  );
}
