"use client";

/**
 * A conversation's scheduled sends, drawn inline above its timeline — the same pinned "N scheduled" card
 * and per-send cards the Communication thread shows (`InboxScheduledThreadList` / `InboxScheduledCard`).
 * A record's Communication section uses this so "Schedule for later" in its composer lands where the
 * manager can see, edit or cancel it, exactly like the main thread. It reads and writes the same
 * scheduled-inbox-messages API as the main composer; Its pop-up can send a scheduled message now, through the existing send-now routes.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { InboxScheduledCard, InboxScheduledThreadList } from "@/components/portal/portal-inbox-ui";
import { useScheduledPaymentMessages, patchScheduledMessage } from "@/components/portal/payment-schedule-ui";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { DEMO_UNAVAILABLE_MESSAGE, sendScheduledItemNow } from "@/components/portal/portal-inbox-selection";
import { readPortalApiError } from "@/lib/portal-api-error";
import { automationChannelDefaultsFromSettings, scheduledItemsForRecipient, type ThreadScheduledItem } from "@/lib/inbox-scheduled-thread";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

type ScheduledRef = { id: string; source: "manual" | "automation" };

/**
 * The scheduled sends this hook already loaded for a conversation, by recipient email, so a sibling
 * pane (the Communication contact-details column) can list them without a second fetch. The thread
 * pane publishes while it is mounted and withdraws when it unmounts; a reader with no thread open
 * sees an empty list.
 */
const publishedScheduled = new Map<string, ThreadScheduledItem[]>();
const publishedListeners = new Set<() => void>();
const NO_SCHEDULED: ThreadScheduledItem[] = [];
const scheduledKey = (email: string) => email.trim().toLowerCase();

function publishThreadScheduledItems(email: string, items: ThreadScheduledItem[]): void {
  const key = scheduledKey(email);
  if (!key) return;
  if (items.length === 0) publishedScheduled.delete(key);
  else publishedScheduled.set(key, items);
  for (const listener of publishedListeners) listener();
}

/**
 * Publish the scheduled sends a thread pane already holds for `email` (call it where the items are
 * computed). Withdrawn when the pane unmounts or the conversation changes.
 */
export function usePublishThreadScheduledItems(email: string, items: ThreadScheduledItem[]): void {
  useEffect(() => {
    publishThreadScheduledItems(email, items);
    return () => publishThreadScheduledItems(email, []);
  }, [email, items]);
}

/** The scheduled sends the open conversation's thread pane loaded for `email` (read only). */
export function useThreadScheduledItems(email: string): ThreadScheduledItem[] {
  const key = scheduledKey(email);
  return useSyncExternalStore(
    (onChange) => {
      publishedListeners.add(onChange);
      return () => {
        publishedListeners.delete(onChange);
      };
    },
    () => publishedScheduled.get(key) ?? NO_SCHEDULED,
    () => NO_SCHEDULED,
  );
}

export function useThreadScheduledCards({
  recipientEmail,
  smsAvailable,
  enabled = true,
  refreshKey = 0,
}: {
  recipientEmail: string;
  smsAvailable: boolean;
  enabled?: boolean;
  /** Bump to reload (e.g. right after the composer scheduled something). */
  refreshKey?: number;
}): { scheduledCards: ReactNode; reloadScheduled: () => void } {
  const [manual, setManual] = useState<ScheduledInboxMessageRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { messages: automation, settings, reload: reloadAutomation } = useScheduledPaymentMessages({ includeHidden: false, enabled });

  // Every call that only a real workspace can answer is gated on this: the reads, and the manual
  // scheduled-inbox API (`/demo` has no manual rows to act on, and never writes real ones). A disabled
  // hook (its section is not showing) must not reach the API through a stale callback either.
  // `patchScheduledMessage` is deliberately NOT gated: it applies any patch locally under `/demo`, so
  // Cancel and Save on a projected demo reminder take effect in the sandbox instead of silently doing
  // nothing. A manual row has no local equivalent, so the sandbox refuses out loud rather than
  // returning quietly — the pop-up treats a silent return as a completed action.
  const live = useCallback(() => enabled && !isDemoModeActive(), [enabled]);

  const reloadManual = useCallback(async () => {
    if (!live()) return;
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setManual(Array.isArray(body.messages) ? body.messages : []);
    } catch {
      /* keep what is drawn */
    }
  }, [live]);

  const reloadScheduled = useCallback(() => {
    if (!live()) return;
    void reloadManual();
    void reloadAutomation();
  }, [live, reloadAutomation, reloadManual]);

  useEffect(() => {
    if (enabled) reloadScheduled();
  }, [enabled, refreshKey, reloadScheduled]);

  const items = useMemo(
    () => (enabled ? scheduledItemsForRecipient(recipientEmail, manual, automation, automationChannelDefaultsFromSettings(settings)) : []),
    [automation, enabled, manual, recipientEmail, settings],
  );

  usePublishThreadScheduledItems(recipientEmail, items);

  const cancel = useCallback(
    async (item: ScheduledRef) => {
      if (!enabled) return;
      if (item.source === "manual" && !live()) throw new Error(DEMO_UNAVAILABLE_MESSAGE);
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
    [enabled, live, reloadScheduled],
  );

  /** `/demo` has no local equivalent of a send, so the pop-up shows the refusal instead of going quiet. */
  const sendNow = useCallback(
    async (item: ScheduledRef) => {
      if (!enabled) return;
      setBusyId(item.id);
      try {
        await sendScheduledItemNow(item);
        reloadScheduled();
      } finally {
        setBusyId(null);
      }
    },
    [enabled, reloadScheduled],
  );

  const saveEdit = useCallback(
    async (
      item: ScheduledRef,
      next: { subject: string; body: string; deliverViaInbox?: boolean; deliverViaEmail?: boolean; deliverViaSms?: boolean; sendAt?: string },
    ) => {
      if (!enabled) return;
      if (item.source === "manual") {
        if (!live()) throw new Error(DEMO_UNAVAILABLE_MESSAGE);
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
    [enabled, live, reloadScheduled],
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
            deliveryStatus={item.deliveryStatus}
            editable={item.editable}
            busy={busyId === item.id}
            recipient={recipientEmail}
            sendAt={item.sendAt}
            onCancel={() => cancel(item)}
            onSendNow={item.editable ? () => sendNow(item) : undefined}
            onSaveEdit={item.editable ? (next) => saveEdit(item, next) : undefined}
          />
        ))}
      </InboxScheduledThreadList>
    ) : null;

  return { scheduledCards, reloadScheduled };
}
