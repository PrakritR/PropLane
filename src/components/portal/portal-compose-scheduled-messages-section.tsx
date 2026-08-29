"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { InboxScheduledCard, InboxScheduledSubjectRow } from "@/components/portal/portal-inbox-ui";
import { useScheduledPaymentMessages, patchScheduledMessage } from "@/components/portal/payment-schedule-ui";
import {
  sendAutomationScheduledMessageNow,
  sendManualScheduledMessageNow,
} from "@/components/portal/portal-inbox-selection";
import { readPortalApiError } from "@/lib/portal-api-error";
import {
  scheduledItemsForRecipient,
  type ThreadScheduledItem,
} from "@/lib/inbox-scheduled-thread";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

/**
 * Scheduled messages for one recipient — subject rows at the bottom of a compose
 * modal; tap a row to open the full card (edit, send now, cancel).
 */
export function PortalComposeScheduledMessagesSection({
  recipientEmail,
  active,
  smsAvailable = false,
  refreshKey = 0,
  onChanged,
  onSendMessage,
  sendMessageLabel = "Send message",
  sendMessageBusy = false,
}: {
  recipientEmail: string;
  /** Parent modal is open — reload when this flips true. */
  active: boolean;
  smsAvailable?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
  /** Primary compose action shown below the scheduled list (image 4 template). */
  onSendMessage?: () => void;
  sendMessageLabel?: string;
  sendMessageBusy?: boolean;
}) {
  const [manualMessages, setManualMessages] = useState<ScheduledInboxMessageRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ThreadScheduledItem | null>(null);
  const { messages: automationMessages, reload: reloadAutomation } = useScheduledPaymentMessages({
    includeHidden: false,
  });

  const reloadManual = useCallback(async () => {
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setManualMessages(Array.isArray(body.messages) ? body.messages : []);
    } catch {
      /* keep */
    }
  }, []);

  const reloadAll = useCallback(() => {
    void reloadManual();
    void reloadAutomation();
  }, [reloadAutomation, reloadManual]);

  useEffect(() => {
    if (!active) return;
    reloadAll();
  }, [active, refreshKey, reloadAll]);

  const items = useMemo(
    () => scheduledItemsForRecipient(recipientEmail, manualMessages, automationMessages),
    [recipientEmail, manualMessages, automationMessages],
  );

  const notifyChanged = useCallback(() => {
    reloadAll();
    onChanged?.();
  }, [onChanged, reloadAll]);

  const cancelItem = useCallback(
    async (item: ThreadScheduledItem) => {
      setBusyId(item.id);
      try {
        if (item.source === "manual") {
          const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(item.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ cancelled: true }),
          });
          if (!res.ok) throw new Error(await readPortalApiError(res, "Could not cancel send."));
        } else {
          await patchScheduledMessage(item.id, { cancelled: true });
        }
        notifyChanged();
        setEditing(null);
      } finally {
        setBusyId(null);
      }
    },
    [notifyChanged],
  );

  const sendNow = useCallback(
    async (item: ThreadScheduledItem) => {
      setBusyId(item.id);
      try {
        if (item.source === "manual") await sendManualScheduledMessageNow(item.id);
        else await sendAutomationScheduledMessageNow(item.id);
        notifyChanged();
        setEditing(null);
      } finally {
        setBusyId(null);
      }
    },
    [notifyChanged],
  );

  const saveEdit = useCallback(
    async (
      item: ThreadScheduledItem,
      next: { subject: string; body: string; deliverViaEmail?: boolean; deliverViaSms?: boolean },
    ) => {
      if (item.source === "manual") {
        const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject: next.subject,
            body: next.body,
            ...(next.deliverViaEmail !== undefined ? { deliverViaEmail: next.deliverViaEmail } : {}),
            ...(next.deliverViaSms !== undefined ? { deliverViaSms: next.deliverViaSms } : {}),
          }),
        });
        if (!res.ok) throw new Error(await readPortalApiError(res, "Could not save changes."));
      } else {
        await patchScheduledMessage(item.id, { customSubject: next.subject, customBody: next.body });
      }
      notifyChanged();
    },
    [notifyChanged],
  );

  if (items.length === 0) return null;

  return (
    <>
      <div className="border-t border-border pt-3" data-attr="compose-scheduled-messages">
        <p className="text-xs font-semibold text-muted">Scheduled messages</p>
        <ul className="mt-2 max-h-[min(28vh,12rem)] space-y-1.5 overflow-y-auto overscroll-contain pr-0.5 [-webkit-overflow-scrolling:touch]">
          {items.map((item) => (
            <li key={item.id}>
              <InboxScheduledSubjectRow
                subject={item.subject}
                sendLabel={item.sendLabel}
                onClick={() => setEditing(item)}
              />
            </li>
          ))}
        </ul>
        {onSendMessage ? (
          <div className="mt-3 flex justify-end border-t border-border pt-3">
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="compose-scheduled-send-message"
              disabled={sendMessageBusy}
              onClick={onSendMessage}
            >
              {sendMessageBusy ? "Sending…" : sendMessageLabel}
            </Button>
          </div>
        ) : null}
      </div>

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title="Scheduled message"
        dense
        fullScreenMobile={false}
        panelClassName="max-w-lg p-3 sm:p-4"
        dataAttr="compose-scheduled-detail-modal"
      >
        {editing ? (
          <InboxScheduledCard
            key={editing.id}
            sendLabel={editing.sendLabel}
            subject={editing.subject}
            body={editing.body}
            meta={editing.meta}
            channel={editing.channel}
            deliverViaEmail={editing.deliverViaEmail}
            deliverViaSms={editing.deliverViaSms}
            emailAvailable
            smsAvailable={smsAvailable}
            channelEditable={editing.source === "manual" && editing.editable}
            source={editing.source}
            editable={editing.editable}
            busy={busyId === editing.id}
            presentation="detail"
            onCancel={() => void cancelItem(editing)}
            onSendNow={() => void sendNow(editing)}
            onSaveEdit={
              editing.editable ? (next) => saveEdit(editing, next) : undefined
            }
          />
        ) : null}
      </Modal>
    </>
  );
}
