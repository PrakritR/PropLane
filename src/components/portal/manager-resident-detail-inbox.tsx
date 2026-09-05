"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { ManagerInbox, type ManagerInboxHandle } from "@/components/portal/manager-inbox";
import { ManagerSmsPanel, type ManagerSmsPanelHandle } from "@/components/portal/manager-sms-panel";
import { InboxThreadAssistantStrip, buildInboxThreadAssistantContext } from "@/components/portal/inbox-thread-assistant-strip";
import {
  InboxComposer,
  InboxReplyChannelPicker,
  InboxThreadView,
  InboxTwoPane,
} from "@/components/portal/portal-inbox-ui";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import {
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  inboxThreadMessages,
  inboxThreadSortMs,
  loadPersistedInbox,
} from "@/lib/portal-inbox-storage";
import {
  mergeUnifiedInboxItems,
  parseUnifiedInboxKey,
  unifiedInboxKey,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import {
  normalizeManagerSmsConversationsPayload,
  smsConversationDisplayName,
  smsConversationSubtitle,
  smsThreadHasUnread,
  type ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";

function previewLine(body: string, max = 80) {
  const t = body.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function smsConversationId(resident: ManagerSmsResidentConversation): string {
  return (
    resident.conversationKey ??
    resident.phone ??
    resident.residentUserId ??
    resident.residentEmail ??
    resident.name
  );
}

function loadSmsOpenedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem("axis_manager_sms_opened_v1");
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function iosListTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const dayDiff = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

const RESIDENT_DETAIL_DIRECT_CHAT_KEY = "__resident_direct__";

function ResidentDirectChatPane({
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
  const [sending, setSending] = useState(false);
  const email = residentEmail.trim();
  const displayName = residentName?.trim() || email || "Resident";
  const subtitle = smsResident?.propertyLabel?.trim() || email;
  const smsAvailable = smsUiEnabled && Boolean(smsResident?.phone?.trim());
  const emailAvailable = Boolean(email);
  const [replyViaEmail, setReplyViaEmail] = useState(!smsAvailable && emailAvailable);
  const [replyViaSms, setReplyViaSms] = useState(smsAvailable);

  useEffect(() => {
    setReplyViaSms(smsAvailable);
    setReplyViaEmail(!smsAvailable && emailAvailable);
    setDraft("");
  }, [email, smsAvailable, emailAvailable]);

  // The compiler declines to re-memoize this one and reports the bailout as an error. It is
  // an optimization notice, not a correctness problem: the explicit useCallback below still
  // does the memoizing, exactly as it did before the compiler was introduced.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    if (!replyViaEmail && !replyViaSms) {
      showToast("Choose Email, SMS, or both.");
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
            text,
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
    replyViaEmail,
    replyViaSms,
    showToast,
    smsResident,
  ]);

  return (
    <InboxThreadView
      title={displayName}
      avatarName={displayName}
      subtitle={subtitle}
      messages={[]}
      emptyLabel="No messages yet. Send the first message below."
      threadKey={`direct-${email}`}
      scrollMode="page"
      composer={
        <>
          <InboxThreadAssistantStrip
            contextHint={buildInboxThreadAssistantContext({
              subject: "Resident conversation",
              from: displayName,
              email: subtitle,
            })}
            storageScopeKey={`resident-direct-${email}`}
          />
          <InboxComposer
            value={draft}
            onChange={setDraft}
            onSubmit={() => void sendMessage()}
            sending={sending}
            disabled={!replyViaEmail && !replyViaSms}
            placeholder={replyViaSms && !replyViaEmail ? "Text message" : "Write a message…"}
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
          />
        </>
      }
    />
  );
}

/**
 * Unified conversation inbox for one resident inside the manager Residents detail
 * panel — direct chat with this resident (no conversation list sidebar).
 */
export function ManagerResidentDetailInbox({
  residentEmail,
  residentName,
  portalBase,
  smsUiEnabled = false,
  inboxRef,
  smsRef,
}: {
  residentEmail: string;
  residentName?: string;
  portalBase: string;
  smsUiEnabled?: boolean;
  inboxRef?: RefObject<ManagerInboxHandle | null>;
  smsRef?: RefObject<ManagerSmsPanelHandle | null>;
}) {
  const commBase = `${portalBase}/communication`;
  const emailNorm = residentEmail.trim().toLowerCase();
  const [emailThreads, setEmailThreads] = useState(() => loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []));
  const [smsResidents, setSmsResidents] = useState<ManagerSmsResidentConversation[]>([]);
  const [smsOpenedIds, setSmsOpenedIds] = useState<Set<string>>(() => loadSmsOpenedIds());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const sync = () => setEmailThreads(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []));
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
  }, []);

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

  const handleSmsConversationOpened = useCallback(() => {
    setSmsOpenedIds(loadSmsOpenedIds());
  }, []);

  const filteredEmail = useMemo(() => {
    const scoped = emailThreads.filter((t) => t.email.trim().toLowerCase() === emailNorm);
    return filterEmailInboxThreads(scoped, { keepSmsLike: !smsUiEnabled });
  }, [emailNorm, smsUiEnabled, emailThreads]);

  const emailListItems = useMemo((): UnifiedInboxListItem[] => {
    let rows = filteredEmail;
    if (showArchived) {
      rows = rows.filter((t) => t.folder === "trash");
    } else {
      rows = rows.filter((t) => t.folder !== "trash");
    }

    return rows.map((t) => {
      const msgs = inboxThreadMessages(t);
      const lastMsg = msgs[msgs.length - 1];
      const sentSemantics = t.folder === "sent";
      const displayName = sentSemantics ? t.email || "Unknown recipient" : t.from || t.email || "Unknown sender";
      const lastOutbound = lastMsg?.outbound ?? (msgs.length > 1 ? true : t.folder === "sent");
      return {
        key: unifiedInboxKey("email", t.id),
        channel: "email" as const,
        threadId: t.id,
        name: displayName,
        subtitle: t.subject,
        preview: previewLine(lastMsg?.body ?? t.preview ?? "", 80),
        previewPrefix: lastOutbound ? "You: " : undefined,
        time: t.time,
        unread: t.folder === "inbox" && t.unread,
        sortMs: inboxThreadSortMs(t.id, lastMsg?.at),
      };
    });
  }, [filteredEmail, showArchived]);

  const smsListItems = useMemo((): UnifiedInboxListItem[] => {
    if (!smsUiEnabled || showArchived) return [];
    const scoped = smsResidents.filter((r) => r.residentEmail?.trim().toLowerCase() === emailNorm);
    return scoped
      .map((resident) => {
        const messages = Array.isArray(resident.messages) ? resident.messages : [];
        const lastMessage = messages[messages.length - 1] ?? null;
        if (!lastMessage) return null;
        const rowId = smsConversationId(resident);
        const unread = smsThreadHasUnread(messages, smsOpenedIds);
        const lastOutbound = lastMessage.direction === "outbound";
        const item: UnifiedInboxListItem = {
          key: unifiedInboxKey("sms", rowId),
          channel: "sms",
          threadId: rowId,
          name: smsConversationDisplayName(resident),
          subtitle: smsConversationSubtitle(resident) || undefined,
          preview: previewLine(lastMessage.body, 80),
          previewPrefix: lastOutbound ? "You: " : undefined,
          time: iosListTimestamp(lastMessage.createdAt),
          unread,
          sortMs: Date.parse(lastMessage.createdAt) || 0,
        };
        return item;
      })
      .filter((x): x is UnifiedInboxListItem => x !== null);
  }, [emailNorm, showArchived, smsOpenedIds, smsResidents, smsUiEnabled]);

  const mergedRows = useMemo(
    () => mergeUnifiedInboxItems([...emailListItems, ...smsListItems]),
    [emailListItems, smsListItems],
  );

  const archivedCount = useMemo(
    () => filteredEmail.filter((t) => t.folder === "trash").length,
    [filteredEmail],
  );

  const smsResidentForEmail = useMemo(
    () => smsResidents.find((r) => r.residentEmail?.trim().toLowerCase() === emailNorm) ?? null,
    [emailNorm, smsResidents],
  );

  const selection = useMemo(() => {
    if (!selectedKey || selectedKey === RESIDENT_DETAIL_DIRECT_CHAT_KEY) return null;
    return parseUnifiedInboxKey(selectedKey);
  }, [selectedKey]);

  const refreshConversations = useCallback(() => {
    setEmailThreads(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []));
    void loadSms();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(PORTAL_INBOX_CHANGED_EVENT));
    }
  }, [loadSms]);

  useEffect(() => {
    setShowArchived(false);
  }, [emailNorm]);

  useEffect(() => {
    if (showArchived) {
      if (mergedRows.length === 0) {
        setSelectedKey(null);
      } else {
        setSelectedKey((cur) => (cur && mergedRows.some((r) => r.key === cur) ? cur : mergedRows[0]!.key));
      }
      return;
    }
    if (mergedRows.length === 0) {
      setSelectedKey(RESIDENT_DETAIL_DIRECT_CHAT_KEY);
      return;
    }
    setSelectedKey((cur) => {
      if (cur === RESIDENT_DETAIL_DIRECT_CHAT_KEY) return mergedRows[0]!.key;
      return cur && mergedRows.some((r) => r.key === cur) ? cur : mergedRows[0]!.key;
    });
  }, [mergedRows, showArchived, emailNorm]);

  const showDirectChat =
    !showArchived &&
    (selectedKey === RESIDENT_DETAIL_DIRECT_CHAT_KEY || (mergedRows.length === 0 && !selection));

  const threadPane = showDirectChat ? (
    <ResidentDirectChatPane
      residentEmail={residentEmail}
      residentName={residentName}
      smsResident={smsResidentForEmail}
      smsUiEnabled={smsUiEnabled}
      onSent={refreshConversations}
    />
  ) : selection?.channel === "email" ? (
      <ManagerInbox
        ref={inboxRef}
        tabId={showArchived ? "trash" : "unopened"}
        embeddedInCommunication
        externalTitleActions
        suppressCompose={false}
        suppressListPane
        pageScroll
        commBase={commBase}
        smsUiEnabled={smsUiEnabled}
        smsRecipients={smsResidents}
        controlledExpandedId={selection.threadId}
        onControlledExpandedIdChange={(id) => {
          if (!id) setSelectedKey(null);
        }}
      />
    ) : selection?.channel === "sms" ? (
      <ManagerSmsPanel
        ref={smsRef}
        filterResidentEmail={residentEmail}
        allowInlineCompose={false}
        suppressListPane
        pageScroll
        controlledActiveId={selection.threadId}
        onControlledActiveIdChange={(id) => {
          if (!id) setSelectedKey(null);
        }}
        onConversationOpened={handleSmsConversationOpened}
      />
    ) : (
      <div className="flex min-h-[min(16rem,40vh)] flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <p className="text-sm font-semibold text-foreground">No archived messages</p>
        <p className="mt-1 text-xs text-muted">Archived conversations with this resident will appear here.</p>
      </div>
    );

  const threadOpen = showDirectChat || Boolean(selection);

  return (
    <div className="portal-resident-detail-inbox flex flex-col">
      {archivedCount > 0 ? (
        <PortalSectionActionRow className="mb-2">
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
        className="w-full"
        heightMode="flow"
        fillViewport={false}
        listHidden
        threadOpen={threadOpen}
        list={null}
        thread={threadPane}
      />
    </div>
  );
}
