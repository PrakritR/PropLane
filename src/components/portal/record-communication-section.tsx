"use client";

/**
 * "Communication" as a section inside a record page (approved design slice —
 * see `docs/agents/communication-inbox.md` § recordRef). Renders ONE merged
 * timeline of EVERY conversation with this record's contact(s): a thread-card
 * header (counterparty avatar + name + Archive), the interleaved message
 * timeline with day dividers, and an inline reply composer matching the main
 * Communication page's — never the full inbox chrome (search box,
 * Active/Archived segments, work-number/work-email identity cards,
 * conversation list). Those stay on `ManagerUnifiedInbox` /
 * `ResidentCommunication` / `VendorCommunication`, which this component does
 * NOT mount.
 *
 * `mergedThreads` is every thread whose stamped `recordRef` matches this
 * record OR whose counterparty email matches one of `contactIds`
 * (case-insensitive) OR — when the thread shape carries a phone
 * (`smsNoticePhone`) — matches `contactPhone`, INCLUDING archived (folder
 * "trash") threads, across every property. Their messages interleave
 * chronologically into one timeline (day dividers and the per-message
 * channel tag both already come from `InboxMessageTimeline` /
 * `buildInboxMessageTimeline` reading the merged `at` order — nothing new was
 * added here, so this stays free of subtext per AGENTS.md). There is no more
 * separate "N other conversations" link: this IS all of them. Replying still
 * goes to the record's OWN thread only — `primaryThread` prefers a
 * recordRef match, then the newest thread with the contact, then null (a
 * fresh send stamps a brand-new thread with this recordRef, same as before).
 *
 * Data source and send path are otherwise unchanged from the prior
 * embedded-inbox version: threads are read from the SAME persisted inbox
 * cache (`loadPersistedInbox` / `syncPersistedInboxFromServer`,
 * `PORTAL_INBOX_CHANGED_EVENT`), and a send still goes through
 * `POST /api/portal/send-inbox-message` with the stamped `recordRef` — a
 * message enters the store only AFTER the send is authorized server-side,
 * exactly as every other send does.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Phone } from "lucide-react";
import {
  INBOX_THREAD_ICON_BTN,
  InboxComposer,
  InboxThreadView,
  InboxTwoPane,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";
import {
  InboxComposerAiMenu,
  InboxComposerChannelMenu,
  InboxComposerScheduleMenu,
} from "@/components/portal/inbox-composer-tools";
import { defaultScheduleSendAtLocal } from "@/components/portal/portal-message-compose-fields";
import { useThreadScheduledCards } from "@/components/portal/use-thread-scheduled-cards";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { setInboxFullScreen } from "@/lib/inbox-full-screen";
import { formatTourContactPhoneDisplay } from "@/lib/tour-contact-quality";
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
  parseInboxStampMs,
  syncPersistedInboxFromServer,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { smsNoticePhone } from "@/lib/sms-inbox-identity";
import { phoneKey } from "@/lib/communication/conversation-key";
import { normalizeE164 } from "@/lib/phone-e164";
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
import { isSelfThread, resolveCounterpartyName } from "@/lib/record-communication-counterparty";
import { serviceThreadsForParty } from "@/lib/service-communication-scope";

export type RecordCommunicationSectionRole = "manager" | "resident" | "vendor";

export type RecordCommunicationSectionProps = {
  role: RecordCommunicationSectionRole;
  recordRef: RecordRef;
  /** House this record belongs to, when it has one — used only (manager/vendor) to fan out a new send to co-managers. Never sent on a resident compose (see below). Never narrows the merged history shown, which now spans every property. */
  propertyId?: string;
  /** The person(s) this record's thread is naturally with (e.g. the resident on a lease, the vendor on a job). First entry is who the composer addresses. */
  contactIds?: string[];
  /** Who the pane is WITH, by name (the resident on a service, the vendor on a job). Titles the pane; the thread's own sender never does. */
  contactName?: string;
  /** Phone for Send via SMS when the contact is not yet a portal user. */
  contactPhone?: string;
  /** Focus the reply composer immediately — the record's "Message" header/phone action lands here with the cursor already in the field. */
  autoOpenCompose?: boolean;
  /** Create or resolve the roster row before the first send (catalog vendors). */
  onEnsureRecord?: () => Promise<RecordRef | null>;
  /**
   * Communication-page parity: the same two-pane shell the main Communication page uses
   * (thread only), filling the record page's height with the composer pinned to the bottom,
   * the thread header's icon actions and Full screen, and the composer's schedule clock.
   */
  fill?: boolean;
  /**
   * A service's section: show ONLY the threads stamped with these record ids (the service and, for an
   * add-on, its linked vendor job) and with this party - never the person-wide history matched by
   * counterparty email or phone (`service-communication-scope.ts`).
   */
  serviceScope?: { recordIds: string[]; party: { email?: string; phone?: string } | null };
  /** The footer link to the main Communication page ("Open the full conversation in Communication"). */
  fullConversationHref?: string;
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
 * `pro-resident-detail-inbox.tsx`), scoped to one thread's own messages —
 * `mergedThreadBubbles` below interleaves several of these into one timeline. */
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
      // Prefixed with the source thread id: several stored threads now
      // interleave into one timeline, and two different threads' own message
      // ids are not guaranteed distinct from each other.
      id: `${thread.id}:${message.id}`,
      author: message.from,
      body: fields.body,
      at: message.at,
      direction: inboxTurnDirection(thread, message, i, folder),
      channel,
      ...(message.houseLabel ? { houseLabel: message.houseLabel } : {}),
      ...(fields.subject ? { subject: fields.subject } : {}),
      attachments: message.attachments,
    });
  }
  return bubbles;
}

/**
 * Every message from every merged thread, interleaved chronologically into
 * one timeline. Day dividers and the per-message channel tag are already
 * derived from message order by `InboxMessageTimeline` /
 * `buildInboxMessageTimeline` — merging here is the only change needed for
 * them to span threads correctly.
 */
function mergedThreadBubbles(threads: PersistedInboxThread[]): InboxBubbleMessage[] {
  return threads
    .flatMap((thread) => threadBubbles(thread).map((bubble) => ({ bubble, sortMs: parseInboxStampMs(bubble.at) ?? 0 })))
    .sort((a, b) => a.sortMs - b.sortMs)
    .map((entry) => entry.bubble);
}

export function RecordCommunicationSection({
  role,
  recordRef,
  propertyId,
  contactIds,
  contactName,
  contactPhone,
  autoOpenCompose,
  onEnsureRecord,
  fill = false,
  serviceScope,
  fullConversationHref,
}: RecordCommunicationSectionProps) {
  const appUi = useOptionalAppUi();
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

  const contactEmailSet = useMemo(
    () => new Set((contactIds ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean)),
    [contactIds],
  );
  const contactPhoneKey = useMemo(() => {
    const e164 = normalizeE164(contactPhone);
    return e164 ? phoneKey(e164) : "";
  }, [contactPhone]);
  const normalizedContactPhone = useMemo(
    () => (contactPhone?.trim() ? smsNoticePhone(contactPhone) : ""),
    [contactPhone],
  );

  // Every conversation with this record's contact(s) — matched by stamped
  // recordRef OR counterparty email OR (when the thread shape carries one) a
  // matching phone — INCLUDING archived threads, across every property. This
  // is now the whole history with this person, not just this one record's
  // labeled thread.
  const mergedThreads = useMemo(
    () => {
      if (serviceScope) {
        // A service shows its own conversation only: stamped with the service (or its linked job) and
        // with this party. No counterparty-only matching, no phone-key history.
        return serviceThreadsForParty(
          threads.filter((t) => !isSelfThread(t, senderIdentity?.email)),
          serviceScope,
        );
      }
      return threads.filter((t) => {
        // The viewer's own self-thread (addressed to themselves) is never the contact's conversation.
        if (isSelfThread(t, senderIdentity?.email)) return false;
        if (threadPassesCommunicationFilters({ filters: threadFilters, contacts: [], counterpartyEmail: t.email, recordRef: t.recordRef })) {
          return true;
        }
        const email = (t.email ?? "").trim().toLowerCase();
        if (email && contactEmailSet.has(email)) return true;
        if (normalizedContactPhone && t.smsNoticePhone && smsNoticePhone(t.smsNoticePhone) === normalizedContactPhone) {
          return true;
        }
        // The person-conversation key: a thread keyed to this contact's phone is
        // theirs whatever email (or none) it was stored under. Flagged keys stay out.
        if (contactPhoneKey && !t.identityFlag && t.conversationKey === contactPhoneKey) return true;
        return false;
      });
    },
    [threads, threadFilters, contactEmailSet, normalizedContactPhone, contactPhoneKey, senderIdentity?.email, serviceScope],
  );

  // Replying still targets exactly one thread: prefer the one stamped with
  // THIS record's own recordRef, else the newest thread with the contact,
  // else none (a send then stamps a brand-new thread with this recordRef).
  const primaryThread = useMemo(() => {
    if (mergedThreads.length === 0) return null;
    const byRecordRef = mergedThreads.find(
      (t) =>
        t.recordRef?.kind === activeRef.kind &&
        (t.recordRef?.id === activeRef.id || Boolean(serviceScope?.recordIds.includes(t.recordRef?.id ?? ""))),
    );
    if (byRecordRef) return byRecordRef;
    const candidates = primaryContact
      ? mergedThreads.filter((t) => t.email.trim().toLowerCase() === primaryContact)
      : mergedThreads;
    const pool = candidates.length > 0 ? candidates : mergedThreads;
    return [...pool].sort((a, b) => inboxThreadSortMs(b.id, b.time) - inboxThreadSortMs(a.id, a.time))[0] ?? null;
  }, [mergedThreads, activeRef.kind, activeRef.id, primaryContact, serviceScope]);

  const messages = useMemo<InboxBubbleMessage[]>(() => mergedThreadBubbles(mergedThreads), [mergedThreads]);

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

  // Full screen is a session-wide preference; a record page never opens already covering itself.
  useEffect(() => {
    if (!fill) return;
    setInboxFullScreen(false);
    return () => setInboxFullScreen(false);
  }, [fill]);

  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduleSendAt, setScheduleSendAt] = useState(() => defaultScheduleSendAtLocal());
  // Scheduled sends render inline above the timeline (pinned "N scheduled" card), like the main thread.
  const { scheduledCards, reloadScheduled } = useThreadScheduledCards({
    recipientEmail,
    smsAvailable,
    enabled: fill && role === "manager",
  });

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
    if (fill && scheduleLater) {
      if (attachmentUrls.length > 0) {
        setSendError("Scheduled messages cannot carry attachments. Remove them or send now.");
        return;
      }
      const sendAt = new Date(scheduleSendAt);
      if (Number.isNaN(sendAt.getTime())) {
        setSendError("Choose a valid send date and time.");
        return;
      }
      if (sendAt.getTime() < Date.now() - 60_000) {
        setSendError("Send time must be in the future.");
        return;
      }
      if (!viaEmail && !viaSms && !viaProplane) {
        setSendError("Choose PropLane, Email, SMS, or a combination.");
        return;
      }
      setSending(true);
      setSendError(null);
      try {
        const res = await fetch("/api/portal/scheduled-inbox-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            senderPortal: role,
            subject: primaryThread?.subject || activeRef.label,
            body: text,
            sendAt: sendAt.toISOString(),
            recipientEmail: to,
            recipientName: primaryThread?.from || activeRef.label,
            deliverViaInbox: viaProplane,
            deliverViaEmail: viaEmail && emailAvailable,
            deliverViaSms: viaSms && smsAvailable,
          }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setSendError(payload?.error ?? "Could not schedule message.");
          return;
        }
        setDraft("");
        setScheduleLater(false);
        appUi?.showToast("Message scheduled.");
        // Pull the pinned "N scheduled" card in so the manager sees it landed.
        reloadScheduled();
      } catch {
        setSendError("Could not schedule message.");
      } finally {
        setSending(false);
      }
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
  }, [activeRef, appUi, attachments, draft, emailAvailable, fill, onEnsureRecord, primaryThread, propertyId, recipientEmail, role, scheduleLater, scheduleSendAt, scope, senderIdentity, smsAvailable, viaEmail, viaProplane, viaSms, reloadScheduled]);

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

  const counterpartyName = resolveCounterpartyName({
    contactName,
    thread: primaryThread,
    recordLabel: activeRef.label,
    recipientEmail,
  });

  const kindLabel = KIND_LABEL[activeRef.kind];
  const archiveButton = primaryThread ? (
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

  const callPhone = contactPhone?.trim() || "";
  const headerActions = fill ? (
    <>
      {callPhone ? (
        <a
          href={`tel:${callPhone}`}
          className={INBOX_THREAD_ICON_BTN}
          aria-label="Call"
          title={`Call ${formatTourContactPhoneDisplay(callPhone)}`}
          data-attr="record-communication-call"
        >
          <Phone className="h-4 w-4" strokeWidth={2} aria-hidden />
        </a>
      ) : null}
      {archiveButton}
    </>
  ) : archiveButton;

  const threadSubtitle = fill
    ? [
        kindLabel.charAt(0).toUpperCase() + kindLabel.slice(1),
        callPhone ? formatTourContactPhoneDisplay(callPhone) : null,
        recipientEmail || null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

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
      trailingControls={
        <>
          <InboxComposerAiMenu onAsk={() => openAxisAssistant()} />
          {fill && emailAvailable ? (
            <InboxComposerScheduleMenu
              scheduleLater={scheduleLater}
              onScheduleLaterChange={setScheduleLater}
              sendAt={scheduleSendAt}
              onSendAtChange={setScheduleSendAt}
              disabled={sending}
            />
          ) : null}
          {/* In the tools row beside the field (AI · schedule · channel · Send), exactly like the main Communication
              composer. Floating it over the field's right edge covered the text at desktop width, where the menu
              carries its label. */}
          {channelControl}
        </>
      }
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

  if (fill) {
    return (
      <div data-attr="record-communication-section" data-fill="true" className="flex min-h-0 flex-1 flex-col">
        <InboxTwoPane
          list={null}
          listHidden
          threadOpen
          fillParent
          panes="split"
          fullScreenable
          // The record page's column has no definite height, so flex-1 would
          // shrink the pane to its content; keep the measured viewport height.
          className="flex-none!"
          thread={
            <InboxThreadView
              title={counterpartyName}
              subtitle={threadSubtitle}
              avatarName={counterpartyName}
              messages={messages}
              headerActions={headerActions}
              underHeader={scheduledCards}
              composer={composer}
              emptyLabel={initialSyncDone ? "No messages yet." : "Loading messages…"}
              threadKey={primaryThread?.id ?? `record:${activeRef.kind}:${activeRef.id}`}
              scrollMode="pane"
            />
          }
        />
        {fullConversationHref ? (
          <p className="pt-2 text-[13px]" data-attr="record-communication-full-conversation">
            <Link href={fullConversationHref} className="font-medium text-primary hover:underline">
              Open the full conversation in Communication
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

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
    </div>
  );
}
