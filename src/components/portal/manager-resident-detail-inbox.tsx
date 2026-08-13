"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { ManagerInbox, type ManagerInboxHandle } from "@/components/portal/manager-inbox";
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
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  inboxThreadMessages,
  loadPersistedInbox,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import { scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import {
  normalizeManagerSmsConversationsPayload,
  type ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";
import {
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages";
import { useScheduledPaymentMessages } from "@/components/portal/payment-schedule-ui";
import { sendManualScheduledMessageNow } from "@/components/portal/portal-inbox-selection";
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
  return bubbles.sort((a, b) => {
    const ta = Date.parse(a.at ?? "") || 0;
    const tb = Date.parse(b.at ?? "") || 0;
    return ta - tb;
  });
}

/** Direct chat when this resident has no inbox thread yet — same shell as Communication. */
export function ResidentDirectChatPane({
  residentEmail,
  residentName,
  smsResident,
  smsUiEnabled,
  onSent,
}: {
  residentEmail: string;
  residentName?: string;
  smsResident?: ManagerSmsResidentConversation | null;
  smsUiEnabled: boolean;
  onSent: () => void;
}) {
  const { showToast } = useAppUi();
  const [draft, setDraft] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<InboxComposerAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [inboxTick, setInboxTick] = useState(0);
  const [manualScheduledMessages, setManualScheduledMessages] = useState<ScheduledInboxMessageRecord[]>([]);
  const [scheduledBusyId, setScheduledBusyId] = useState<string | null>(null);
  const { messages: scheduledPaymentMessages, reload: reloadAutomationScheduled } = useScheduledPaymentMessages({
    includeHidden: false,
  });

  const email = residentEmail.trim();
  const smsAvailable = smsUiEnabled && Boolean(smsResident?.phone?.trim());
  const emailAvailable = Boolean(email);
  const [replyViaEmail, setReplyViaEmail] = useState(!smsAvailable && emailAvailable);
  const [replyViaSms, setReplyViaSms] = useState(smsAvailable);

  const reloadScheduled = useCallback(async () => {
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setManualScheduledMessages(Array.isArray(body.messages) ? body.messages : []);
    } catch {
      /* keep */
    }
    void reloadAutomationScheduled();
  }, [reloadAutomationScheduled]);

  useEffect(() => {
    void reloadScheduled();
  }, [reloadScheduled]);

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
    return loadResidentThreadBubbles(email);
  }, [email, inboxTick]);

  const threadScheduledItems = useMemo(
    () => scheduledItemsForRecipient(email, manualScheduledMessages, scheduledPaymentMessages),
    [email, manualScheduledMessages, scheduledPaymentMessages],
  );

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

      if (replyViaSms) {
        const phone = smsResident?.phone?.trim();
        if (!phone) {
          showToast("No phone on file for this resident.");
          return;
        }
        const res = await fetch("/api/manager/sms-conversations", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toPhone: phone,
            text: text || "(attachment)",
            residentUserId: smsResident?.residentUserId ?? null,
            conversationKey: smsResident?.conversationKey ?? null,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        smsOk = res.ok;
        if (!smsOk && !replyViaEmail) {
          showToast(body.error ?? "Could not send SMS.");
          return;
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

  const scheduledCards =
    threadScheduledItems.length > 0 ? (
      <InboxScheduledThreadList
        count={threadScheduledItems.length}
        nextSendLabel={threadScheduledItems[0]?.sendLabel}
        defaultCollapsed={threadScheduledItems.length > 2}
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
            source={item.source}
            editable={item.editable}
            busy={scheduledBusyId === item.id}
            onCancel={() => {
              setScheduledBusyId(item.id);
              void fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(item.id)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ status: "cancelled" }),
              }).finally(() => {
                setScheduledBusyId(null);
                void reloadScheduled();
              });
            }}
            onSendNow={() => {
              setScheduledBusyId(item.id);
              void sendManualScheduledMessageNow(item.id).finally(() => {
                setScheduledBusyId(null);
                void reloadScheduled();
                onSent();
              });
            }}
          />
        ))}
      </InboxScheduledThreadList>
    ) : null;

  return (
    <InboxThreadView
      title=""
      messages={messages}
      threadKey={`direct-${email}`}
      scrollMode="pane"
      hideIdentityHeader
      emptyLabel="No messages yet. Send the first message below."
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
}: {
  residentEmail: string;
  residentName?: string;
  portalBase: string;
  smsUiEnabled?: boolean;
  inboxRef?: RefObject<ManagerInboxHandle | null>;
  emptyThreadFallback?: ReactNode;
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
      />
    );

  return (
    <div className="portal-resident-detail-inbox flex min-h-0 flex-1 flex-col">
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
          />
        }
      />
    </div>
  );
}
