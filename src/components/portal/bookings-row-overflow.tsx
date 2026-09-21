"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";

/**
 * Bookings row ⋯ — canonical order (docs/agents/record-page.md; PLAN-0920-1058
 * area 1e): own actions (Edit dates, Move room — block bookings only), Message,
 * Copy link, then Cancel in red. Never a View item — the row itself already
 * opens the record page (`RecordActionMenu` only adds View when `onOpen` is
 * passed, and this component never does).
 */
export function BookingsRowOverflow({
  label,
  onEditDates,
  editDatesLabel = "Edit dates",
  onMoveRoom,
  onMessage,
  onCopyLink,
  onCancel,
  cancelLabel = "Cancel booking",
  children,
}: {
  label: string;
  /** Present only for a block-sourced booking — the only kind this screen can actually edit —
   *  or, with `editDatesLabel` overridden, a jump to the Lease/listing record that owns it. */
  onEditDates?: () => void;
  /** "Open lease" / "Open listing" when `onEditDates` is repurposed for a non-block booking, or "Edit booking" in the day pop-up. */
  editDatesLabel?: string;
  onMoveRoom?: () => void;
  onMessage?: () => void;
  onCopyLink?: () => void;
  /** Present only for a block-sourced booking (deletes the hold) — a lease or channel import cannot be cancelled here. */
  onCancel?: () => void;
  /** "Delete booking" in the day pop-up; every other caller keeps the default. */
  cancelLabel?: string;
  /** When set, this provides the ⋯ context for a list row (one menu). Otherwise it draws its own ⋯. */
  children?: ReactNode;
}) {
  return (
    <RecordActionContext.Provider
      value={{
        scope: label,
        clear: () => {},
        actions: (
          <>
            {onEditDates ? (
              <Button type="button" variant="outline" data-attr="bookings-row-edit-dates" data-record-action-id="edit-dates" onClick={onEditDates}>
                {editDatesLabel}
              </Button>
            ) : null}
            {onMoveRoom ? (
              <Button type="button" variant="outline" data-attr="bookings-row-move-room" data-record-action-id="move-room" onClick={onMoveRoom}>
                Move room
              </Button>
            ) : null}
            {onMessage ? (
              <Button type="button" variant="outline" data-attr="bookings-row-message" data-record-action-id="message" onClick={onMessage}>
                {`Message ${label}`}
              </Button>
            ) : null}
            {onCopyLink ? (
              <Button type="button" variant="outline" data-attr="bookings-row-copy-link" data-record-action-id="copy-link" onClick={onCopyLink}>
                Copy link
              </Button>
            ) : null}
            {onCancel ? (
              <Button type="button" variant="danger" data-attr="bookings-row-cancel" data-record-action-id="delete" onClick={onCancel}>
                {cancelLabel}
              </Button>
            ) : null}
          </>
        ),
      }}
    >
      {children ?? <RecordActionMenu label={label} activate={() => {}} />}
    </RecordActionContext.Provider>
  );
}
