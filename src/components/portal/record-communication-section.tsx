"use client";

/**
 * "Communication" as a section inside a record page (PLAN-0920-1058, area 1b
 * — see `docs/agents/communication-inbox.md` § recordRef). Wraps the SAME
 * three inbox components the standalone Communication page uses — never a
 * parallel list — narrowed with `threadFilters.recordRefs` to just this
 * record, plus a compose that stamps the ref on send and a folded hint at
 * other conversations with the same contact on the same property.
 *
 * Registered against the record-section registry (`record-section-renderers.tsx`)
 * as the `"communication"` section for every record kind.
 */
import { useEffect, useMemo, useState } from "react";
import { PenSquare } from "lucide-react";
import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";
import { ResidentCommunication } from "@/components/portal/resident-communication";
import { VendorCommunication } from "@/components/portal/vendor-communication";
import { ScopedInboxComposeModal, type ScopedInboxSendPayload } from "@/components/portal/inbox-scoped-compose-modal";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalEmptyState } from "@/components/portal/portal-empty-state";
import {
  MANAGER_INBOX_STORAGE_KEY,
  RESIDENT_INBOX_STORAGE_KEY,
  VENDOR_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  loadPersistedInbox,
} from "@/lib/portal-inbox-storage";
import { threadPassesCommunicationFilters, type CommunicationThreadFilters } from "@/lib/communication-thread-filters";
import type { RecordRef } from "@/lib/portals/record-kinds";

export type RecordCommunicationSectionRole = "manager" | "resident" | "vendor";

export type RecordCommunicationSectionProps = {
  role: RecordCommunicationSectionRole;
  recordRef: RecordRef;
  /** House this record belongs to, when it has one — used only to fold "other conversations" and (manager/vendor) to fan out to co-managers. Never sent on a resident compose (see below). */
  propertyId?: string;
  /** The person(s) this record's thread is naturally with (e.g. the resident on a lease, the vendor on a job). First entry is who compose addresses. */
  contactIds?: string[];
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

export function RecordCommunicationSection({ role, recordRef, propertyId, contactIds }: RecordCommunicationSectionProps) {
  const [composeOpen, setComposeOpen] = useState(false);
  const scope = SCOPE_BY_ROLE[role];
  const primaryContact = contactIds?.[0];

  // Best-effort client-side read of the already-synced inbox cache, purely to
  // decide (a) whether to show the "no messages yet" empty banner above the
  // embedded list and (b) the folded "N other conversations" count. The
  // embedded inbox component below does its own authoritative server sync and
  // is what actually renders the thread list — this is display-only.
  const [threads, setThreads] = useState(() => loadPersistedInbox(scope, []));
  useEffect(() => {
    const sync = () => setThreads(loadPersistedInbox(scope, []));
    sync();
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
  }, [scope]);

  const threadFilters = useMemo<CommunicationThreadFilters>(
    () => ({
      propertyIds: [],
      roles: [],
      contactIds: [],
      recordRefs: [{ kind: recordRef.kind, id: recordRef.id }],
    }),
    [recordRef.kind, recordRef.id],
  );

  const matchingCount = useMemo(
    () =>
      threads.filter((t) => t.folder !== "trash" && threadPassesCommunicationFilters({ filters: threadFilters, contacts: [], counterpartyEmail: t.email, recordRef: t.recordRef })).length,
    [threads, threadFilters],
  );

  const otherConversationsCount = useMemo(() => {
    if (!primaryContact) return 0;
    const contact = primaryContact.trim().toLowerCase();
    return threads.filter((t) => {
      if (t.folder === "trash") return false;
      if ((t.email ?? "").trim().toLowerCase() !== contact) return false;
      if (t.recordRef?.kind === recordRef.kind && t.recordRef?.id === recordRef.id) return false;
      if (propertyId && t.houses?.length && !t.houses.some((h) => h.propertyId === propertyId)) return false;
      return true;
    }).length;
  }, [threads, primaryContact, propertyId, recordRef.kind, recordRef.id]);

  const kindLabel = KIND_LABEL[recordRef.kind];
  const commBase = role === "manager" ? "/portal/communication" : `/${role}/communication`;

  async function handleSend(payload: ScopedInboxSendPayload): Promise<boolean> {
    const directEmails = payload.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean);
    const res = await fetch("/api/portal/send-inbox-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        fromName: payload.senderName,
        fromEmail: payload.senderEmail,
        toEmails: directEmails,
        toBroadcast: payload.broadcastCategories,
        subject: payload.subject.trim() || recordRef.label,
        text: payload.body.trim(),
        deliverToPortalInbox: true,
        deliverViaEmail: payload.deliverViaEmail !== false,
        deliverViaSms: payload.deliverViaSms === true,
        eventCategory: "messages",
        senderPortal: role,
        // A resident's own compose auto-detects a general "property chat" when
        // it carries a propertyId with no thread yet (see
        // `deliverResidentPropertyManagerChatMessage` in the send route) — a
        // DIFFERENT delivery path that does not know about `recordRef`. Never
        // send it from here; manager/vendor composes are unaffected by that
        // heuristic and may still fan out to co-managers on the house.
        ...(role !== "resident" && propertyId ? { propertyId } : {}),
        recordRef: { kind: recordRef.kind, id: recordRef.id, label: recordRef.label },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return Boolean(res.ok && data.ok !== false);
  }

  const composeModal = (
    <ScopedInboxComposeModal
      open={composeOpen}
      onClose={() => setComposeOpen(false)}
      onSend={async (payload) => {
        const sent = await handleSend(payload);
        if (sent) setComposeOpen(false);
        return sent;
      }}
      portal={role}
      title={`Message about ${recordRef.label}`}
      initialDraft={{
        subject: recordRef.label,
        body: "",
        recipientEmail: primaryContact,
        propertyId: role !== "resident" ? propertyId : undefined,
      }}
    />
  );

  const emptyBanner =
    matchingCount === 0 ? (
      <div className="mb-3">
        <PortalEmptyState
          title={`No messages about this ${kindLabel} yet`}
          action={
            <PortalPrimaryIconAction
              icon={PenSquare}
              label={`Message about this ${kindLabel}`}
              data-attr="record-communication-empty-compose"
              onClick={() => setComposeOpen(true)}
            />
          }
        />
      </div>
    ) : null;

  const foldedHint =
    otherConversationsCount > 0 ? (
      <a
        href={commBase}
        className="mt-2 block truncate text-xs text-muted hover:text-foreground"
        data-attr="record-communication-other-conversations"
      >
        {otherConversationsCount} other conversation{otherConversationsCount === 1 ? "" : "s"} with this contact
        {propertyId ? " · this property" : ""} ›
      </a>
    ) : null;

  const composeAction = (
    <PortalPrimaryIconAction icon={PenSquare} label={`Message about this ${kindLabel}`} data-attr="record-communication-compose" onClick={() => setComposeOpen(true)} />
  );

  return (
    <div data-attr="record-communication-section" className="flex min-h-0 flex-1 flex-col">
      {emptyBanner}
      <div className="min-h-0 flex-1">
        {role === "manager" ? (
          <ManagerUnifiedInbox
            tabId="record-communication"
            commBase={commBase}
            listChrome="internal"
            threadFilters={threadFilters}
            onAddConversation={() => setComposeOpen(true)}
            listActions={composeAction}
          />
        ) : role === "resident" ? (
          <ResidentCommunication threadFilters={threadFilters} />
        ) : (
          <VendorCommunication threadFilters={threadFilters} />
        )}
      </div>
      {foldedHint}
      {composeModal}
    </div>
  );
}
