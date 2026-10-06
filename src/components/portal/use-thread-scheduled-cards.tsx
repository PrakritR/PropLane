"use client";

/**
 * A conversation's scheduled sends, drawn inline above its timeline — the same pinned "N scheduled" card
 * and per-send cards the Communication thread shows (`InboxScheduledThreadList` / `InboxScheduledCard`).
 * A record's Communication section uses this so "Schedule for later" in its composer lands where the
 * manager can see, edit or cancel it, exactly like the main thread. It reads and writes the same
 * scheduled-inbox-messages API as the main composer; it never sends anything itself.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { InboxScheduledCard, InboxScheduledThreadList } from "@/components/portal/portal-inbox-ui";
import { useScheduledPaymentMessages, patchScheduledMessage } from "@/components/portal/payment-schedule-ui";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { readPortalApiError } from "@/lib/portal-api-error";
import { automationChannelDefaultsFromSettings, scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

type ScheduledRef = { id: string; source: "manual" | "automation" };

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
  const [failure, setFailure] = useState<string | null>(null);
  const showToast = useOptionalAppUi()?.showToast;
  const { messages: automation, settings, reload: reloadAutomation } = useScheduledPaymentMessages({ includeHidden: false, enabled });

  // Every call that only a real workspace can answer is gated on this: the reads, and the manual
  // scheduled-inbox API (`/demo` has no manual rows to act on, and never writes real ones). A disabled
  // hook (its section is not showing) must not reach the API through a stale callback either.
  // `patchScheduledMessage` is deliberately NOT gated: it applies any patch locally under `/demo`, so
  // Cancel and Save on a projected demo reminder take effect in the sandbox instead of silently doing
  // nothing. Only a disabled hook makes these no-ops.
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

  /**
   * Cancel is fire-and-forget from the card, so a rejection has nowhere to land on its
   * own: without this the card simply re-enabled and the send stayed scheduled. The message is both
   * toasted and kept above the list, so it survives the toast.
   */
  const report = useCallback(
    (error: unknown, fallback: string) => {
      const message = error instanceof Error && error.message.trim() ? error.message : fallback;
      setFailure(message);
      showToast?.(message);
    },
    [showToast],
  );

  const cancel = useCallback(
    async (item: ScheduledRef) => {
      if (!enabled) return;
      if (item.source === "manual" && !live()) return;
      setBusyId(item.id);
      setFailure(null);
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

  const saveEdit = useCallback(
    async (
      item: ScheduledRef,
      next: { subject: string; body: string; deliverViaInbox?: boolean; deliverViaEmail?: boolean; deliverViaSms?: boolean; sendAt?: string },
    ) => {
      if (!enabled) return;
      if (item.source === "manual") {
        if (!live()) return;
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

  // The bar reads its children's props as scheduled rows, so the refusal sits above it, never inside.
  const failureNote = failure ? (
    <p role="alert" className="mx-1 mb-2 rounded-xl border border-border p-3 text-sm" data-attr="thread-scheduled-error">
      {failure}
    </p>
  ) : null;

  const scheduledCards =
    items.length > 0 || failureNote ? (
      <>
      {failureNote}
      {items.length > 0 ? (
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
              if (item.deliveryStatus !== "sending") {
                void cancel(item).catch((error) => report(error, "Could not cancel send."));
              }
            }}
            onSaveEdit={item.editable ? (next) => saveEdit(item, next) : undefined}
          />
        ))}
      </InboxScheduledThreadList>
      ) : null}
      </>
    ) : null;

  return { scheduledCards, reloadScheduled };
}
