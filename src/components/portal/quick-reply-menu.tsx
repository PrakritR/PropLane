"use client";

import { Zap } from "lucide-react";
import Link from "next/link";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useVendorQuickReplies } from "@/lib/use-vendor-quick-replies";

/** Where a vendor manages their saved replies. */
export const VENDOR_QUICK_REPLIES_SETTINGS_HREF = "/vendor/profile?tab=quick-replies";

const COMPOSER_TOOL_BTN =
  "inline-flex size-7 shrink-0 touch-manipulation items-center justify-center rounded-md text-foreground/80 outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-40 max-md:size-9";

/**
 * ⚡ Quick replies — the vendor's own saved messages in one menu. Picking one
 * calls `onPick(text)`; the caller inserts it into its field (see
 * `insertQuickReplyText`), where it stays editable. Reusable anywhere a vendor
 * types a message: the Communication composer, a review reply, and (later) the
 * bid note.
 *
 * `variant="composer"` is the bordered tool button that sits beside the
 * composer's other tools; `"icon"` is the bare utility icon for a field label
 * or a dialog header.
 */
export function QuickReplyMenu({
  onPick,
  variant = "icon",
  disabled = false,
  side = "top",
  dataAttr = "quick-reply-menu",
  className,
  open,
  onOpenChange,
  defaultOpen = false,
}: {
  onPick: (text: string) => void;
  variant?: "icon" | "composer";
  disabled?: boolean;
  side?: "top" | "bottom";
  dataAttr?: string;
  className?: string;
  /** Controlled open state, for a caller that opens the menu itself (a dialog waits for its own focus to settle first). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Opens the menu as soon as it mounts — "Reply with a quick reply" in a row ⋯. */
  defaultOpen?: boolean;
}) {
  const { replies, loading } = useVendorQuickReplies();
  return (
    <DropdownMenu defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        {variant === "composer" ? (
          <button
            type="button"
            aria-label="Quick replies"
            title="Quick replies"
            disabled={disabled}
            className={cn(COMPOSER_TOOL_BTN, className)}
            data-attr={dataAttr}
          >
            <Zap className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <PortalIconAction icon={Zap} label="Quick replies" disabled={disabled} className={className} data-attr={dataAttr} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} className="max-h-[min(22rem,70vh)] min-w-[15rem] max-w-[min(22rem,90vw)] overflow-y-auto">
        {loading ? (
          <div className="px-3 py-2 text-sm text-muted">Loading…</div>
        ) : replies.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted" data-attr={`${dataAttr}-empty`}>
            No quick replies yet
          </div>
        ) : (
          replies.map((reply) => (
            <DropdownMenuItem
              key={reply.id}
              onSelect={() => onPick(reply.text)}
              data-attr={`${dataAttr}-item`}
              className="whitespace-normal"
            >
              {reply.text}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild data-attr={`${dataAttr}-manage`}>
          <Link href={VENDOR_QUICK_REPLIES_SETTINGS_HREF} className="font-semibold text-primary">
            Manage quick replies
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The same replies as a plain in-flow list, for a field inside a dialog: a
 * dropdown portaled out of a modal dialog sits outside the dialog's own layer
 * and cannot be clicked, so a dialog (the review reply) toggles this list under
 * its field instead. Picking one calls `onPick(text)`; the caller inserts it.
 */
export function QuickReplyList({
  onPick,
  dataAttr = "quick-reply-list",
}: {
  onPick: (text: string) => void;
  dataAttr?: string;
}) {
  const { replies, loading } = useVendorQuickReplies();
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card" data-attr={dataAttr}>
      {loading ? (
        <p className="px-3 py-2 text-sm text-muted">Loading…</p>
      ) : replies.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted">No quick replies yet</p>
      ) : (
        <ul>
          {replies.map((reply) => (
            <li key={reply.id} className="border-b border-border last:border-0">
              <button
                type="button"
                onClick={() => onPick(reply.text)}
                data-attr={`${dataAttr}-item`}
                className="block min-h-11 w-full px-3 py-2.5 text-left text-[13.5px] font-medium transition hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {reply.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Link
        href={VENDOR_QUICK_REPLIES_SETTINGS_HREF}
        className="block min-h-11 border-t border-border px-3 py-2.5 text-[13.5px] font-semibold text-primary"
        data-attr={`${dataAttr}-manage`}
      >
        Manage quick replies
      </Link>
    </div>
  );
}
