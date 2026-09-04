"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { ManagerInbox, type ManagerInboxHandle } from "@/components/portal/pro-inbox";
import {
  InboxComposer,
  InboxReplyChannelPicker,
  InboxScheduledCard,
  InboxScheduledThreadList,
  InboxThreadView,
  InboxTwoPane,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import {
  InboxThreadAssistantStrip,
  buildInboxThreadAssistantContext,
} from "@/components/portal/inbox-thread-assistant-strip";
import { useScheduledPaymentMessages, patchScheduledMessage } from "@/components/portal/payment-schedule-ui";
import {
  sendAutomationScheduledMessageNow,
  sendManualScheduledMessageNow,
} from "@/components/portal/portal-inbox-selection";
import { readPortalApiError } from "@/lib/portal-api-error";
import { scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  formatInboxStamp,
  inboxThreadMessages,
  loadPersistedInbox,
  parseInboxStampMs,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import {
  normalizeManagerSmsConversationsPayload,
  type ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";
import {
  isManualSmsOutcomeUnknown,
  MANUAL_SMS_UNKNOWN_MESSAGE,
  resolveManualSmsAttempt,
  type ManualSmsAttempt,
} from "@/lib/sms/manual-send-attempt";
import {
  INBOX_MAX_ATTACHMENTS,
  createPendingInboxAttachment,
  revokeInboxAttachmentPreview,
  uploadInboxAttachment,
  type InboxComposerAttachment,
} from "@/lib/inbox-attachments";

function loadResidentThreadBubbles(email: string): InboxBubbleMessage[] {
  const norm = email.trim().toLowerCase();
  if (!norm) return [];
  const threads = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []) as PersistedInboxThread[];
  const bubbles: InboxBubbleMessage[] = [];
  for (const thread of threads) {
    if (thread.email.trim().toLowerCase() !== norm || thread.folder === "trash") continue;
    const folder = thread.folder === "sent" ? "sent" : "inbox";
    for (const [i, m] of inboxThreadMessages(thread).entries()) {
      const outbound = m.outbound ?? (i === 0 ? folder === "sent" : true);
      bubbles.push({
        id: m.id,
        author: m.from,
        body: m.body,
        at: m.at,
        direction: outbound ? "outbound" : "inbound",
        channel: "email",
        attachments: m.attachments,
      });
    }
  }
  return bubbles;
}

/** This person's texts as thread bubbles, stamped like the email ones. */
function smsThreadBubbles(
  resident: ManagerSmsResidentConversation | null | undefined,
  displayName: string,
): InboxBubbleMessage[] {
  const messages = Array.isArray(resident?.messages) ? resident.messages : [];
  return messages.map((message, index) => {
    const at = Date.parse(message.createdAt);
    return {
      // Message ids come from a different store than the email ones, so keep
      // them namespaced or a collision would drop a bubble from the timeline.
      id: `sms:${message.id ?? `${message.createdAt}:${index}`}`,
      author: message.direction === "outbound" ? "You" : displayName,
      body: message.body,
      // Render through the SAME stamp the email side uses, so one timeline does
      // not mix two date formats.
      at: Number.isNaN(at) ? "" : formatInboxStamp(new Date(at)),
      direction: message.direction === "outbound" ? "outbound" : "inbound",
      channel: "sms" as const,
    };
  });
}

/**
 * One person, one conversation: email and text history interleaved in time.
 *
 * Both sides must be reduced to milliseconds the SAME way before sorting. Email
 * bubbles carry the canonical inbox stamp ("Aug 3, 5:31 PM" — no year, Pacific)
 * which only `parseInboxStampMs` reads correctly; a bare `Date.parse` on it is
 * timezone- and year-dependent, so sorting raw strings from two stores let an
 * older email outrank a newer text.
 */
function mergeThreadBubbles(
  emailBubbles: InboxBubbleMessage[],
  smsBubbles: InboxBubbleMessage[],
): InboxBubbleMessage[] {
  return [...emailBubbles, ...smsBubbles].sort(
    (a, b) => (parseInboxStampMs(a.at) ?? 0) - (parseInboxStampMs(b.at) ?? 0),
  );
}

/** Direct chat when this resident has no inbox thread yet — same shell as Communication. */
export function ResidentDirectChatPane({
  residentEmail,
  residentName,
  smsResident,
  smsUiEnabled,
  onSent,
  onNewMessage,
  scheduledRefreshKey = 0,
}: {
  residentEmail: string;
  residentName?: string;
  smsResident?: ManagerSmsResidentConversation | null;
  smsUiEnabled: boolean;
  onSent: () => void;
  onNewMessage?: () => void;
  scheduledRefreshKey?: number;
}) {
  const { showToast } = useAppUi();
  const [draft, setDraft] = useState("");
  const smsAttemptRef = useRef<ManualSmsAttempt | null>(null);
  const [replyAttachments, setReplyAttachments] = useState<InboxComposerAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [inboxTick, setInboxTick] = useState(0);
  const [manualScheduledMessages, setManualScheduledMessages] = useState<ScheduledInboxMessageRecord[]>([]);
  const [scheduledBusyId, setScheduledBusyId] = useState<string | null>(null);
  const { messages: scheduledPaymentMessages, reload: reloadAutomationScheduled } = useScheduledPaymentMessages({
    includeHidden: false,
  });

  const reloadManualScheduled = useCallback(async () => {
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setManualScheduledMessages(Array.isArray(body.messages) ? body.messages : []);
    } catch {
      /* keep */
    }
  }, []);

  const reloadScheduled = useCallback(() => {
    void reloadManualScheduled();
    void reloadAutomationScheduled();
  }, [reloadAutomationScheduled, reloadManualScheduled]);

  useEffect(() => {
    reloadScheduled();
  }, [reloadScheduled, scheduledRefreshKey]);

  const email = residentEmail.trim();
  const displayName = residentName?.trim() || email || "Resident";
  const smsAvailable = smsUiEnabled && Boolean(smsResident?.phone?.trim());
  const emailAvailable = Boolean(email);
  const [replyViaEmail, setReplyViaEmail] = useState(!smsAvailable && emailAvailable);
  const [replyViaSms, setReplyViaSms] = useState(smsAvailable);

  useEffect(() => {
    const sync = () => setInboxTick((n) => n + 1);
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
  }, []);

  useEffect(() => {
    setReplyViaSms(smsAvailable);
    setReplyViaEmail(!smsAvailable && emailAvailable);
    setDraft("");
    setReplyAttachments((prev) => {
      prev.forEach(revokeInboxAttachmentPreview);
      return [];
    });
  }, [email, smsAvailable, emailAvailable]);

  const messages = useMemo(() => {
    void inboxTick;
    return mergeThreadBubbles(loadResidentThreadBubbles(email), smsThreadBubbles(smsResident, displayName));
  }, [displayName, email, inboxTick, smsResident]);

  // Channel tags are decided by the timeline primitive itself: it tags bubbles
  // only when the thread actually spans more than one channel, so a plain email
  // conversation stays untagged with no flag to keep in sync here.

  const threadScheduledItems = useMemo(
    () => scheduledItemsForRecipient(email, manualScheduledMessages, scheduledPaymentMessages),
    [email, manualScheduledMessages, scheduledPaymentMessages],
  );

  const cancelScheduledItem = useCallback(
    async (item: { id: string; source: "manual" | "automation" }) => {
      setScheduledBusyId(item.id);
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
        setScheduledBusyId(null);
      }
    },
    [reloadScheduled],
  );

  const sendScheduledItemNow = useCallback(
    async (item: { id: string; source: "manual" | "automation" }) => {
      setScheduledBusyId(item.id);
      try {
        if (item.source === "manual") await sendManualScheduledMessageNow(item.id);
        else await sendAutomationScheduledMessageNow(item.id);
        reloadScheduled();
        onSent();
      } finally {
        setScheduledBusyId(null);
      }
    },
    [onSent, reloadScheduled],
  );

  const saveScheduledEdit = useCallback(
    async (
      item: { id: string; source: "manual" | "automation"; editable: boolean },
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
      reloadScheduled();
    },
    [reloadScheduled],
  );

  const scheduledCards =
    threadScheduledItems.length > 0 ? (
      <InboxScheduledThreadList
        count={threadScheduledItems.length}
        nextSendLabel={threadScheduledItems[0]?.sendLabel}
      >
        {threadScheduledItems.map((item) => (
          <InboxScheduledCard
            key={item.id}
            sendLabel={item.sendLabel}
            subject={item.subject}
            body={item.body}
            meta={item.meta}
            channel={item.channel}
            deliverViaEmail={item.deliverViaEmail}
            deliverViaSms={item.deliverViaSms}
            emailAvailable
            smsAvailable={smsAvailable}
            channelEditable={item.source === "manual" && item.editable}
            source={item.source}
            editable={item.editable}
            busy={scheduledBusyId === item.id}
            onCancel={() => void cancelScheduledItem(item)}
            onSendNow={() => void sendScheduledItemNow(item)}
            onSaveEdit={item.editable ? (next) => saveScheduledEdit(item, next) : undefined}
          />
        ))}
      </InboxScheduledThreadList>
    ) : null;

  const pickReplyAttachments = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      const room = INBOX_MAX_ATTACHMENTS - replyAttachments.length;
      if (room <= 0) {
        showToast(`You can attach up to ${INBOX_MAX_ATTACHMENTS} files.`);
        return;
      }
      const batch = Array.from(files).slice(0, room);
      for (const file of batch) {
        const pending = createPendingInboxAttachment(file);
        setReplyAttachments((prev) => [...prev, pending]);
        void uploadInboxAttachment(file)
          .then((url) => {
            setReplyAttachments((prev) =>
              prev.map((a) => (a.id === pending.id ? { ...a, uploadUrl: url, uploading: false } : a)),
            );
          })
          .catch((e) => {
            setReplyAttachments((prev) =>
              prev.map((a) =>
                a.id === pending.id
                  ? { ...a, uploading: false, error: e instanceof Error ? e.message : "Upload failed" }
                  : a,
              ),
            );
          });
      }
    },
    [replyAttachments.length, showToast],
  );

  const removeReplyAttachment = useCallback((id: string) => {
    setReplyAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) revokeInboxAttachmentPreview(target);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    const attachmentUrls = replyAttachments
      .filter((a) => a.uploadUrl && !a.uploading && !a.error)
      .map((a) => a.uploadUrl!);
    if (!text && attachmentUrls.length === 0) return;
    if (!replyViaEmail && !replyViaSms) {
      showToast("Choose Email, SMS, or both.");
      return;
    }
    if (replyAttachments.some((a) => a.uploading)) {
      showToast("Wait for uploads to finish.");
      return;
    }
    setSending(true);
    try {
      let smsOk = !replyViaSms;
      let emailOk = !replyViaEmail;
      let smsOutcomeUnknown = false;

      if (replyViaSms) {
        const phone = smsResident?.phone?.trim();
        if (!phone) {
          showToast("No phone on file for this resident.");
          return;
        }
        const smsText = text || "(attachment)";
        const attempt = resolveManualSmsAttempt(
          smsAttemptRef.current,
          JSON.stringify([
            phone,
            smsText,
            smsResident?.residentUserId ?? null,
            smsResident?.conversationKey ?? null,
          ]),
          1,
        );
        smsAttemptRef.current = attempt;
        try {
          const res = await fetch("/api/manager/sms-conversations", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": attempt.idempotencyKeys[0]!,
            },
            body: JSON.stringify({
              toPhone: phone,
              text: smsText,
              residentUserId: smsResident?.residentUserId ?? null,
              conversationKey: smsResident?.conversationKey ?? null,
            }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            code?: string;
            error?: string;
            status?: string;
          };
          smsOutcomeUnknown = isManualSmsOutcomeUnknown(body);
          smsOk = res.ok && !smsOutcomeUnknown;
          if (!smsOutcomeUnknown) smsAttemptRef.current = null;
          if (!smsOk && !replyViaEmail && !smsOutcomeUnknown) {
            showToast(body.error ?? "Could not send SMS.");
            return;
          }
        } catch {
          smsOutcomeUnknown = true;
          smsOk = false;
        }
      }

      if (replyViaEmail) {
        const res = await fetch("/api/portal/send-inbox-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            fromName: "Property manager",
            toEmails: [email],
            subject: "Message from your property manager",
            text,
            deliverToPortalInbox: true,
            eventCategory: "messages",
            senderPortal: "manager",
            attachmentUrls: attachmentUrls.length ? attachmentUrls : undefined,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        emailOk = res.ok && data.ok === true;
        if (!emailOk && !smsOk) {
          showToast(data.error ?? "Could not send email.");
          return;
        }
      }

      if (smsOutcomeUnknown) {
        showToast(
          replyViaEmail && emailOk
            ? `Email sent. ${MANUAL_SMS_UNKNOWN_MESSAGE}`
            : MANUAL_SMS_UNKNOWN_MESSAGE,
        );
        return;
      }

      setDraft("");
      setReplyAttachments((prev) => {
        prev.forEach(revokeInboxAttachmentPreview);
        return [];
      });
      if (replyViaEmail && replyViaSms) showToast("Sent via email and SMS.");
      else if (replyViaEmail) showToast("Email sent.");
      else showToast("SMS sent.");
      onSent();
    } catch {
      showToast("Could not send.");
    } finally {
      setSending(false);
    }
  }, [
    draft,
    email,
    onSent,
    replyAttachments,
    replyViaEmail,
    replyViaSms,
    showToast,
    smsResident,
  ]);

  return (
    <InboxThreadView
      title=""
      messages={messages}
      threadKey={`direct-${email}`}
      scrollMode="pane"
      hideIdentityHeader
      emptyLabel="No messages yet. Send the first message below."
      headerActions={
        onNewMessage ? (
          <Button
            type="button"
            variant="primary"
            className="min-h-0 rounded-full px-3 py-1.5 text-xs"
            data-attr="resident-detail-new-message"
            onClick={onNewMessage}
          >
            New message
          </Button>
        ) : null
      }
      composer={
        <>
          {scheduledCards ? (
            <div
              className="shrink-0 border-t border-border bg-card/90 px-2 py-2 md:px-3"
              data-attr="resident-direct-scheduled-pin"
            >
              {scheduledCards}
            </div>
          ) : null}
          <InboxThreadAssistantStrip
            contextHint={buildInboxThreadAssistantContext({
              subject: "Resident conversation",
              from: displayName,
              email,
            })}
            storageScopeKey={`resident-detail-${email.trim().toLowerCase()}`}
          />
          <InboxComposer
            value={draft}
            onChange={setDraft}
            onSubmit={() => void sendMessage()}
            sending={sending}
            disabled={!replyViaEmail && !replyViaSms}
            placeholder="Write a reply…"
            maxLength={replyViaSms && !replyViaEmail ? 1600 : undefined}
            dataAttr="resident-direct-chat-compose"
            channelControl={
              <InboxReplyChannelPicker
                viaEmail={replyViaEmail}
                viaSms={replyViaSms}
                onViaEmailChange={setReplyViaEmail}
                onViaSmsChange={setReplyViaSms}
                emailAvailable={emailAvailable}
                smsAvailable={smsAvailable}
              />
            }
            attachments={replyAttachments}
            onAttachmentsPick={pickReplyAttachments}
            onAttachmentRemove={removeReplyAttachment}
            maxAttachments={INBOX_MAX_ATTACHMENTS}
          />
        </>
      }
    />
  );
}

/**
 * Single-page chat for one resident inside the manager Residents detail panel.
 */
export function ManagerResidentDetailInbox({
  residentEmail,
  residentName,
  portalBase,
  smsUiEnabled = false,
  inboxRef,
  emptyThreadFallback,
  onScheduleMessage,
  onNewMessage,
  scheduledRefreshKey = 0,
}: {
  residentEmail: string;
  residentName?: string;
  portalBase: string;
  smsUiEnabled?: boolean;
  inboxRef?: RefObject<ManagerInboxHandle | null>;
  emptyThreadFallback?: ReactNode;
  /** @deprecated Use onNewMessage */
  onScheduleMessage?: () => void;
  /** Opens the compose modal. */
  onNewMessage?: () => void;
  scheduledRefreshKey?: number;
}) {
  const commBase = `${portalBase}/communication`;
  const emailNorm = residentEmail.trim().toLowerCase();
  const [showArchived, setShowArchived] = useState(false);
  const [smsResidents, setSmsResidents] = useState<ManagerSmsResidentConversation[]>([]);
  const [inboxTick, setInboxTick] = useState(0);

  const loadSms = useCallback(async () => {
    if (!smsUiEnabled) return;
    try {
      const res = await fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { residents?: ManagerSmsResidentConversation[] };
      setSmsResidents(normalizeManagerSmsConversationsPayload(body).residents);
    } catch {
      /* keep */
    }
  }, [smsUiEnabled]);

  useEffect(() => {
    void loadSms();
  }, [loadSms]);

  useEffect(() => {
    const sync = () => setInboxTick((n) => n + 1);
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
  }, []);

  const archivedCount = useMemo(() => {
    void inboxTick;
    const rows = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []) as PersistedInboxThread[];
    return filterEmailInboxThreads(rows).filter(
      (t) => t.email.trim().toLowerCase() === emailNorm && t.folder === "trash",
    ).length;
  }, [emailNorm, inboxTick]);

  const smsResidentForEmail = useMemo(
    () => smsResidents.find((r) => r.residentEmail?.trim().toLowerCase() === emailNorm) ?? null,
    [emailNorm, smsResidents],
  );

  const refreshConversations = useCallback(() => {
    setInboxTick((n) => n + 1);
    void loadSms();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(PORTAL_INBOX_CHANGED_EVENT));
    }
  }, [loadSms]);

  useEffect(() => {
    setShowArchived(false);
  }, [emailNorm]);

  const directFallback =
    emptyThreadFallback ??
    (
      <ResidentDirectChatPane
        residentEmail={residentEmail}
        residentName={residentName}
        smsResident={smsResidentForEmail}
        smsUiEnabled={smsUiEnabled}
        onSent={refreshConversations}
        onNewMessage={onNewMessage ?? onScheduleMessage}
        scheduledRefreshKey={scheduledRefreshKey}
      />
    );

  return (
    <div className="portal-resident-detail-inbox portal-communication-inbox flex min-h-0 min-h-[min(72dvh,100%)] flex-1 flex-col">
      {archivedCount > 0 ? (
        <PortalSectionActionRow className="mb-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              showArchived
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted hover:bg-foreground/5 hover:text-foreground"
            }`}
            data-attr="resident-detail-inbox-archived-toggle"
            aria-pressed={showArchived}
          >
            {showArchived ? "← Back to messages" : `Archived (${archivedCount})`}
          </button>
        </PortalSectionActionRow>
      ) : null}
      <InboxTwoPane
        className="w-full flex-1"
        heightMode="viewport"
        fillParent
        fillViewport
        listHidden
        threadOpen
        list={null}
        thread={
          <ManagerInbox
            ref={inboxRef}
            tabId={showArchived ? "trash" : "unopened"}
            embeddedInCommunication
            externalTitleActions
            suppressCompose
            suppressListPane
            filterResidentEmail={residentEmail}
            emptyThreadFallback={directFallback}
            commBase={commBase}
            smsUiEnabled={smsUiEnabled}
            smsRecipients={smsResidents}
            onNewMessage={onNewMessage ?? onScheduleMessage}
            scheduledRefreshKey={scheduledRefreshKey}
          />
        }
      />
    </div>
  );
}
