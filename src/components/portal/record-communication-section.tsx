"use client";

/**
 * "Communication" as a section inside a record page (approved design slice —
 * see `docs/agents/communication-inbox.md` § recordRef). Renders ONLY the
 * record's own thread: a thread-card header (counterparty avatar + name +
 * Archive), the message timeline with day dividers, and an inline reply
 * composer matching the main Communication page's — never the full inbox
 * chrome (search box, Active/Archived segments, work-number/work-email
 * identity cards, conversation list). Those stay on `ManagerUnifiedInbox` /
 * `ResidentCommunication` / `VendorCommunication`, which this component does
 * NOT mount.
 *
 * Data source and send path are unchanged from the prior embedded-inbox
 * version: the record's thread(s) are read from the SAME persisted inbox
 * cache (`loadPersistedInbox` / `syncPersistedInboxFromServer`,
 * `PORTAL_INBOX_CHANGED_EVENT`) narrowed with `threadFilters.recordRefs`, and
 * a send still goes through `POST /api/portal/send-inbox-message` with the
 * stamped `recordRef` — a message enters the store only AFTER the send is
 * authorized server-side, exactly as every other send does.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive } from "lucide-react";
import {
  INBOX_THREAD_ICON_BTN,
  InboxComposer,
  InboxThreadView,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";
import { InboxComposerAiMenu, InboxComposerChannelMenu } from "@/components/portal/inbox-composer-tools";
import { openAxisAssistant } from "@/lib/axis-assistant/open-store";
import {
  MANAGER_INBOX_STORAGE_KEY,
  RESIDENT_INBOX_STORAGE_KEY,
  VENDOR_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  inboxThreadMessages,
  inboxThreadSortMs,
  lastInboundChannelOf,
  loadPersistedInbox,
  syncPersistedInboxFromServer,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { inboxThreadHasEmail } from "@/lib/manager-inbox-reply-channels";
import { inboxTurnDirection } from "@/lib/inbox-turn-direction";
import { emailReplySubjectFor, inboxEmailBubbleFields } from "@/lib/inbox-email-display";
import { threadPassesCommunicationFilters, type CommunicationThreadFilters } from "@/lib/communication-thread-filters";
import { archivePersistedInboxThreads } from "@/lib/communication-inbox-thread-mutations";
import {
  INBOX_MAX_ATTACHMENTS,
  createPendingInboxAttachment,
  revokeInboxAttachmentPreview,
  uploadInboxAttachment,
  type InboxComposerAttachment,
} from "@/lib/inbox-attachments";
import type { RecordRef } from "@/lib/portals/record-kinds";

export type RecordCommunicationSectionRole = "manager" | "resident" | "vendor";

export type RecordCommunicationSectionProps = {
  role: RecordCommunicationSectionRole;
  recordRef: RecordRef;
  /** House this record belongs to, when it has one — used only to fold "other conversations" and (manager/vendor) to fan out to co-managers. Never sent on a resident compose (see below). */
  propertyId?: string;
  /** The person(s) this record's thread is naturally with (e.g. the resident on a lease, the vendor on a job). First entry is who the composer addresses. */
  contactIds?: string[];
  /** Phone for Send via SMS when the contact is not yet a portal user. */
  contactPhone?: string;
  /** Focus the reply composer immediately — the record's "Message" header/phone action lands here with the cursor already in the field. */
  autoOpenCompose?: boolean;
  /** Create or resolve the roster row before the first send (catalog vendors). */
  onEnsureRecord?: () => Promise<RecordRef | null>;
};

const SCOPE_BY_ROLE: Record<RecordCommunicationSectionRole, string> = {
  manager: MANAGER_INBOX_STORAGE_KEY,
  resident: RESIDENT_INBOX_STORAGE_KEY,
  vendor: VENDOR_INBOX_STORAGE_KEY,
};

const KIND_LABEL: Record<RecordRef["kind"], string> = {
  property: "property",
  resident: "resident",
  payment: "charge",
  "outgoing-payment": "payment",
  lease: "lease",
  application: "application",
  inspection: "inspection",
  service: "service",
  task: "task",
  vendor: "vendor",
  tour: "tour",
  booking: "booking",
  document: "document",
};

/** Same shape as the main inbox's thread → bubble builder (`inboxThreadBubbles` in
 * `pro-resident-detail-inbox.tsx`), scoped to a single thread — the record pane
 * shows exactly one conversation, never a merged multi-thread history. */
function threadBubbles(thread: PersistedInboxThread): InboxBubbleMessage[] {
  const folder = thread.folder === "sent" ? "sent" : "inbox";
  let lastShownSubject = "";
  const bubbles: InboxBubbleMessage[] = [];
  for (const [i, message] of inboxThreadMessages(thread).entries()) {
    const channel = message.channel ?? thread.rootChannel;
    const fields = inboxEmailBubbleFields(
      { body: message.body, subject: message.subject ?? (i === 0 ? thread.subject : undefined), channel },
      lastShownSubject,
    );
    lastShownSubject = fields.lastShownSubject;
    bubbles.push({
      id: message.id,
      author: message.from,
      body: fields.body,
      at: message.at,
      direction: inboxTurnDirection(thread, message, i, folder),
      channel,
      ...(fields.subject ? { subject: fields.subject } : {}),
      attachments: message.attachments,
    });
  }
  return bubbles;
}

export function RecordCommunicationSection({
  role,
  recordRef,
  propertyId,
  contactIds,
  contactPhone,
  autoOpenCompose,
  onEnsureRecord,
}: RecordCommunicationSectionProps) {
  const scope = SCOPE_BY_ROLE[role];
  const primaryContact = contactIds?.[0]?.trim().toLowerCase() || undefined;

  // The real signed-in name, not a hardcoded fallback — same source
  // (`GET /api/profile`) every other compose surface reads (vendor's own
  // inbox reads the vendor-specific twin, `/api/vendor/profile`).
  const [senderIdentity, setSenderIdentity] = useState<{ name: string; email: string } | null>(null);
  useEffect(() => {
    let active = true;
    void fetch(role === "vendor" ? "/api/vendor/profile" : "/api/profile", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { fullName?: string; email?: string; profile?: { name?: string; email?: string } } | null) => {
        if (!active || !data) return;
        const name = String(data.fullName ?? data.profile?.name ?? "").trim();
        const email = String(data.email ?? data.profile?.email ?? "").trim();
        if (name || email) setSenderIdentity({ name, email });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [role]);

  // The authoritative source is the same persisted inbox cache every other
  // Communication surface reads — this pane never invents a parallel store.
  const [threads, setThreads] = useState(() => loadPersistedInbox(scope, []));
  const [activeRef, setActiveRef] = useState(recordRef);
  useEffect(() => {
    setActiveRef(recordRef);
  }, [recordRef.kind, recordRef.id, recordRef.label]);
  // A hard reload of this record page starts with whatever `loadPersistedInbox`
  // finds in the LOCAL cache, which is empty until `syncPersistedInboxFromServer`
  // below completes at least once — this pane rendered the confident "No
  // messages about this X yet" empty state during that gap, before the real
  // thread had even been fetched, so the exact same conversation intermittently
  // "had no messages" depending on how fast the reload happened to land versus
  // the sync's own network latency. `initialSyncDone` distinguishes "still
  // checking" from "checked, and there really is nothing" so the empty label
  // only ever reflects the server's actual answer.
  const [initialSyncDone, setInitialSyncDone] = useState(false);
  useEffect(() => {
    setInitialSyncDone(false);
    const sync = () => setThreads(loadPersistedInbox(scope, []));
    sync();
    void syncPersistedInboxFromServer(scope)
      .then(sync)
      .catch(() => {})
      .finally(() => setInitialSyncDone(true));
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
  }, [scope]);

  const threadFilters = useMemo<CommunicationThreadFilters>(
    () => ({
      propertyIds: [],
      roles: [],
      contactIds: [],
      recordRefs: [{ kind: activeRef.kind, id: activeRef.id }],
    }),
    [activeRef.kind, activeRef.id],
  );

  const recordThreads = useMemo(
    () =>
      threads.filter(
        (t) => t.folder !== "trash" && threadPassesCommunicationFilters({ filters: threadFilters, contacts: [], counterpartyEmail: t.email, recordRef: t.recordRef }),
      ),
    [threads, threadFilters],
  );

  // A record's thread belongs to whoever first composed from it, so there is
  // ordinarily exactly one match; prefer the one addressed to this record's
  // own contact and fall back to the most recently active match.
  const primaryThread = useMemo(() => {
    if (recordThreads.length === 0) return null;
    if (primaryContact) {
      const byContact = recordThreads.find((t) => t.email.trim().toLowerCase() === primaryContact);
      if (byContact) return byContact;
    }
    return [...recordThreads].sort((a, b) => inboxThreadSortMs(b.id, b.time) - inboxThreadSortMs(a.id, a.time))[0] ?? null;
  }, [recordThreads, primaryContact]);

  const otherConversationsCount = useMemo(() => {
    if (!primaryContact) return 0;
    return threads.filter((t) => {
      if (t.folder === "trash") return false;
      if ((t.email ?? "").trim().toLowerCase() !== primaryContact) return false;
      if (t.recordRef?.kind === recordRef.kind && t.recordRef?.id === recordRef.id) return false;
      if (propertyId && t.houses?.length && !t.houses.some((h) => h.propertyId === propertyId)) return false;
      return true;
    }).length;
  }, [threads, primaryContact, propertyId, recordRef.kind, recordRef.id]);

  const messages = useMemo<InboxBubbleMessage[]>(() => (primaryThread ? threadBubbles(primaryThread) : []), [primaryThread]);

  const recipientEmail = (primaryThread?.email ?? primaryContact ?? "").trim();
  const emailAvailable = primaryThread ? inboxThreadHasEmail(primaryThread.email) : Boolean(recipientEmail.includes("@"));

  // Default reply channel follows "a reply leaves on the channel the person
  // reached you on" (docs/agents/communication-inbox.md) once a thread
  // exists; before the first message, fall back to Email when the contact
  // looks like an address, else In-app.
  const [viaEmail, setViaEmail] = useState(true);
  const [viaSms, setViaSms] = useState(false);
  const [viaProplane, setViaProplane] = useState(false);
  const smsAvailable = Boolean(contactPhone?.trim());
  useEffect(() => {
    if (primaryThread) {
      const channel = lastInboundChannelOf(primaryThread);
      if (channel === "email") {
        setViaEmail(true);
        setViaSms(false);
        setViaProplane(false);
      } else if (channel === "sms" && smsAvailable) {
        setViaEmail(false);
        setViaSms(true);
        setViaProplane(false);
      } else {
        setViaEmail(false);
        setViaSms(false);
        setViaProplane(true);
      }
    } else if (recipientEmail.includes("@")) {
      setViaEmail(true);
      setViaSms(false);
      setViaProplane(false);
    } else if (smsAvailable) {
      setViaEmail(false);
      setViaSms(true);
      setViaProplane(false);
    } else {
      setViaEmail(false);
      setViaSms(false);
      setViaProplane(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryThread?.id, smsAvailable]);

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<InboxComposerAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);

  useEffect(() => {
    if (autoOpenCompose) setFocusSignal((n) => n + 1);
  }, [autoOpenCompose]);

  const pickAttachments = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const room = INBOX_MAX_ATTACHMENTS - attachments.length;
      if (room <= 0) {
        setSendError(`Up to ${INBOX_MAX_ATTACHMENTS} attachments.`);
        return;
      }
      for (const file of Array.from(files).slice(0, room)) {
        const pending = createPendingInboxAttachment(file);
        setAttachments((prev) => [...prev, pending]);
        void uploadInboxAttachment(file)
          .then((url) => setAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, uploadUrl: url, uploading: false } : a))))
          .catch((error: unknown) => {
            setAttachments((prev) =>
              prev.map((a) => (a.id === pending.id ? { ...a, uploading: false, error: error instanceof Error ? error.message : "Upload failed." } : a)),
            );
          });
      }
    },
    [attachments.length],
  );

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    const attachmentUrls = attachments.filter((a) => a.uploadUrl && !a.uploading && !a.error).map((a) => a.uploadUrl!);
    if (!text && attachmentUrls.length === 0) return;
    if (attachments.some((a) => a.uploading)) {
      setSendError("Wait for attachments to finish uploading.");
      return;
    }
    const to = recipientEmail;
    if (!to) {
      setSendError(`No contact to message about this ${KIND_LABEL[activeRef.kind]} yet.`);
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      let ref = activeRef;
      if (onEnsureRecord) {
        const next = await onEnsureRecord();
        if (!next) {
          setSendError("Could not add this vendor.");
          return;
        }
        ref = next;
        setActiveRef(next);
      }
      const subject = viaEmail ? emailReplySubjectFor(primaryThread?.subject || ref.label) : ref.label;
      const res = await fetch("/api/portal/send-inbox-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromName: senderIdentity?.name ?? "",
          fromEmail: senderIdentity?.email ?? "",
          toEmails: [to],
          subject,
          text,
          deliverToPortalInbox: true,
          deliverViaEmail: viaEmail,
          deliverViaSms: viaSms && smsAvailable,
          ...(viaSms ? {} : { eventCategory: "messages" }),
          senderPortal: role,
          ...(role !== "resident" && propertyId ? { propertyId } : {}),
          recordRef: { kind: ref.kind, id: ref.id, label: ref.label },
          ...(attachmentUrls.length ? { attachmentUrls } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        setSendError(data.error || "Could not send message.");
        return;
      }
      for (const att of attachments) revokeInboxAttachmentPreview(att);
      setDraft("");
      setAttachments([]);
      const rows = await syncPersistedInboxFromServer(scope, { force: true });
      setThreads(rows);
    } catch {
      setSendError("Could not send message.");
    } finally {
      setSending(false);
    }
  }, [activeRef, attachments, draft, onEnsureRecord, primaryThread, propertyId, recipientEmail, role, scope, senderIdentity, smsAvailable, viaEmail, viaSms]);

  const handleArchive = useCallback(async () => {
    if (!primaryThread || archiving) return;
    setArchiving(true);
    try {
      const { ok } = await archivePersistedInboxThreads(scope, [primaryThread.id]);
      if (ok) setThreads(loadPersistedInbox(scope, []));
    } finally {
      setArchiving(false);
    }
  }, [archiving, primaryThread, scope]);

  const kindLabel = KIND_LABEL[activeRef.kind];
  const commBase = role === "manager" ? "/portal/communication" : `/${role}/communication`;
  const counterpartyName = primaryThread?.from?.trim() || activeRef.label || recipientEmail || "Contact";

  const headerActions = primaryThread ? (
    <button
      type="button"
      className={INBOX_THREAD_ICON_BTN}
      aria-label="Archive thread"
      title="Archive thread"
      disabled={archiving}
      data-attr="record-communication-archive"
      onClick={() => void handleArchive()}
    >
      <Archive className="h-4 w-4" strokeWidth={2} aria-hidden />
    </button>
  ) : undefined;

  const channelControl = (
    <InboxComposerChannelMenu
      viaEmail={viaEmail}
      viaSms={viaSms}
      onViaEmailChange={setViaEmail}
      onViaSmsChange={setViaSms}
      viaProplane={viaProplane}
      onViaProplaneChange={setViaProplane}
      emailAvailable={emailAvailable}
      smsAvailable={smsAvailable}
      proplaneAvailable
      disabled={sending}
      sendingAs={{ proplane: "PropLane", email: senderIdentity?.email, sms: contactPhone }}
    />
  );

  const composer = (
    <InboxComposer
      value={draft}
      onChange={setDraft}
      onSubmit={() => void handleSend()}
      sending={sending}
      disabled={!recipientEmail}
      placeholder="Write a reply…"
      dataAttr="record-communication-composer"
      channelControl={channelControl}
      trailingControls={<InboxComposerAiMenu onAsk={() => openAxisAssistant()} />}
      attachments={attachments}
      onAttachmentsPick={pickAttachments}
      onAttachmentRemove={(id) => {
        setAttachments((prev) => {
          const target = prev.find((a) => a.id === id);
          if (target) revokeInboxAttachmentPreview(target);
          return prev.filter((a) => a.id !== id);
        });
      }}
      maxAttachments={INBOX_MAX_ATTACHMENTS}
      focusSignal={focusSignal}
      hint={sendError ? <span className="text-rose-600">{sendError}</span> : undefined}
    />
  );

  return (
    <div data-attr="record-communication-section" className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <InboxThreadView
        title={counterpartyName}
        avatarName={counterpartyName}
        messages={messages}
        headerActions={headerActions}
        composer={composer}
        emptyLabel={
          initialSyncDone
            ? `No messages about this ${kindLabel} yet — write the first one below`
            : "Loading messages…"
        }
        threadKey={primaryThread?.id ?? `record:${activeRef.kind}:${activeRef.id}`}
        scrollMode="page"
      />
      {otherConversationsCount > 0 ? (
        <a
          href={commBase}
          className="block px-3 py-2 text-xs text-muted hover:text-foreground sm:px-4"
          data-attr="record-communication-other-conversations"
        >
          {otherConversationsCount} other conversation{otherConversationsCount === 1 ? "" : "s"} with this contact
          {propertyId ? " · this property" : ""} ›
        </a>
      ) : null}
    </div>
  );
}
