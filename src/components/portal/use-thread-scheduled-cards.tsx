"use client";

/**
 * A conversation's scheduled sends, drawn inline above its timeline — the same pinned "N scheduled" card
 * and per-send cards the Communication thread shows (`InboxScheduledThreadList` / `InboxScheduledCard`).
 * A record's Communication section uses this so "Schedule for later" in its composer lands where the
 * manager can see, edit, send now or cancel it, exactly like the main thread. It reads and writes the same
 * scheduled-inbox-messages API as the main composer; it never sends anything itself.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { InboxScheduledCard, InboxScheduledThreadList } from "@/components/portal/portal-inbox-ui";
import { useScheduledPaymentMessages, patchScheduledMessage } from "@/components/portal/payment-schedule-ui";
import { sendAutomationScheduledMessageNow, sendManualScheduledMessageNow } from "@/components/portal/portal-inbox-selection";
import { readPortalApiError } from "@/lib/portal-api-error";
import { automationChannelDefaultsFromSettings, scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

type ScheduledRef = { id: string; source: "manual" | "automation" };

export function useThreadScheduledCards({
  recipientEmail,
  smsAvailable,
  enabled = true,
  refreshKey = 0,
  onSent,
}: {
  recipientEmail: string;
  smsAvailable: boolean;
  enabled?: boolean;
  /** Bump to reload (e.g. right after the composer scheduled something). */
  refreshKey?: number;
  onSent?: () => void;
}): { scheduledCards: ReactNode; reloadScheduled: () => void } {
  const [manual, setManual] = useState<ScheduledInboxMessageRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { messages: automation, settings, reload: reloadAutomation } = useScheduledPaymentMessages({ includeHidden: false });

  const reloadManual = useCallback(async () => {
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setManual(Array.isArray(body.messages) ? body.messages : []);
    } catch {
      /* keep what is drawn */
    }
  }, []);

  const reloadScheduled = useCallback(() => {
    void reloadManual();
    void reloadAutomation();
  }, [reloadAutomation, reloadManual]);

  useEffect(() => {
    if (enabled) reloadScheduled();
  }, [enabled, refreshKey, reloadScheduled]);

  const items = useMemo(
    () => (enabled ? scheduledItemsForRecipient(recipientEmail, manual, automation, automationChannelDefaultsFromSettings(settings)) : []),
    [automation, enabled, manual, recipientEmail, settings],
  );

  const cancel = useCallback(
    async (item: ScheduledRef) => {
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
        reloadScheduled();
      } finally {
        setBusyId(null);
      }
    },
    [reloadScheduled],
  );

  const sendNow = useCallback(
    async (item: ScheduledRef) => {
      setBusyId(item.id);
      try {
        if (item.source === "manual") await sendManualScheduledMessageNow(item.id);
        else await sendAutomationScheduledMessageNow(item.id);
        reloadScheduled();
        onSent?.();
      } finally {
        setBusyId(null);
      }
    },
    [onSent, reloadScheduled],
  );

  const saveEdit = useCallback(
    async (
      item: ScheduledRef,
      next: { subject: string; body: string; deliverViaInbox?: boolean; deliverViaEmail?: boolean; deliverViaSms?: boolean; sendAt?: string },
    ) => {
      if (item.source === "manual") {
        const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject: next.subject,
            body: next.body,
            ...(next.deliverViaInbox !== undefined ? { deliverViaInbox: next.deliverViaInbox } : {}),
            ...(next.deliverViaEmail !== undefined ? { deliverViaEmail: next.deliverViaEmail } : {}),
            ...(next.deliverViaSms !== undefined ? { deliverViaSms: next.deliverViaSms } : {}),
            ...(next.sendAt ? { sendAt: next.sendAt } : {}),
          }),
        });
        if (!res.ok) throw new Error(await readPortalApiError(res, "Could not save changes."));
      } else {
        await patchScheduledMessage(item.id, {
          customSubject: next.subject,
          customBody: next.body,
          ...(next.sendAt ? { customSendAt: next.sendAt } : {}),
          ...(next.deliverViaInbox !== undefined ? { customDeliverViaInbox: next.deliverViaInbox } : {}),
          ...(next.deliverViaEmail !== undefined ? { customDeliverViaEmail: next.deliverViaEmail } : {}),
          ...(next.deliverViaSms !== undefined ? { customDeliverViaSms: next.deliverViaSms } : {}),
        });
      }
      reloadScheduled();
    },
    [reloadScheduled],
  );

  const scheduledCards =
    items.length > 0 ? (
      <InboxScheduledThreadList placement="bar" count={items.length} nextSendLabel={items[0]?.sendLabel}>
        {items.map((item) => (
          <InboxScheduledCard
            key={item.id}
            sendLabel={item.sendLabel}
            subject={item.subject}
            body={item.body}
            meta={item.meta}
            channel={item.channel}
            deliverViaInbox={item.deliverViaInbox}
            deliverViaEmail={item.deliverViaEmail}
            deliverViaSms={item.deliverViaSms}
            emailAvailable
            smsAvailable={smsAvailable}
            channelEditable={item.editable}
            source={item.source}
            editable={item.editable}
            busy={busyId === item.id || item.deliveryStatus === "sending"}
            recipient={recipientEmail}
            sendAt={item.sendAt}
            onCancel={() => {
              if (item.deliveryStatus !== "sending") void cancel(item);
            }}
            onSendNow={() => {
              if (item.deliveryStatus !== "sending") void sendNow(item);
            }}
            onSaveEdit={item.editable ? (next) => saveEdit(item, next) : undefined}
          />
        ))}
      </InboxScheduledThreadList>
    ) : null;

  return { scheduledCards, reloadScheduled };
}
