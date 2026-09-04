"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { ResidentInboxPanel, type ResidentInboxPanelHandle } from "@/components/portal/resident-inbox-panel";
import { RoleSmsPanel } from "@/components/portal/role-sms-panel";
import { ResidentManagerNumberCard } from "@/components/portal/resident-manager-number-card";
import {
  INBOX_LIST_SCROLL,
  InboxConversationRow,
  InboxTwoPane,
  PortalInboxEmptyState,
  type InboxListSegment,
} from "@/components/portal/portal-inbox-ui";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalTextNotificationsBlock } from "@/components/portal/portal-text-notifications-block";
import {
  PORTAL_COMMAND_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
} from "@/components/portal/portal-metrics";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import {
  mergeUnifiedInboxItems,
  parseUnifiedInboxKey,
  unifiedInboxKey,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import {
  PORTAL_INBOX_CHANGED_EVENT,
  RESIDENT_INBOX_STORAGE_KEY,
  inboxThreadMessages,
  inboxThreadSortMs,
  loadPersistedInbox,
} from "@/lib/portal-inbox-storage";
import {
  clearCommunicationThreadUrl,
  selectCommunicationThreadUrl,
} from "@/lib/portal-communication-nav";
import { useCommunicationThreadId } from "@/hooks/use-communication-thread-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import {
  normalizeRoleSmsPayload,
  smsMessageBucket,
  type ManagerSmsBucketId,
  type ManagerSmsMessageRow,
} from "@/lib/manager-sms-messages";
import { formatPacificDate } from "@/lib/pacific-time";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const SMS_THREAD_ID = "text-messages";
const SMS_OPENED_KEY = "axis_role_sms_opened_resident";

function previewLine(body: string, max = 80) {
  const t = body.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function loadOpenedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SMS_OPENED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function ResidentUnifiedInbox({
  inboxRef,
  smsUiEnabled,
  listSegment,
  routeThreadId,
  onRouteThreadChange,
  onThreadOpenChange,
  onThreadSelectedChange,
  commBase,
  onAddConversation,
}: {
  inboxRef: React.RefObject<ResidentInboxPanelHandle | null>;
  smsUiEnabled: boolean;
  listSegment: InboxListSegment;
  routeThreadId?: string;
  onRouteThreadChange?: (threadId: string | undefined) => void;
  onThreadOpenChange?: (open: boolean) => void;
  onThreadSelectedChange?: (selected: boolean) => void;
  commBase: string;
  onAddConversation?: () => void;
}) {
  // Inbox rows hydrate from sessionStorage — never read them in useState initializers (SSR mismatch).
  const [emailThreads, setEmailThreads] = useState<PersistedInboxThread[]>([]);
  const [smsMessages, setSmsMessages] = useState<ManagerSmsMessageRow[]>([]);
  const [smsOpened, setSmsOpened] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    const syncEmail = () => setEmailThreads(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, []));
    syncEmail();
    setSmsOpened(loadOpenedIds());
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
  }, []);

  useEffect(() => {
    if (!smsUiEnabled) return;
    void (async () => {
      try {
        const res = await fetch("/api/resident/sms-conversations", { credentials: "include", cache: "no-store" });
        if (!res.ok) return;
        const body = await res.json();
        setSmsMessages(normalizeRoleSmsPayload(body).messages);
      } catch {
        /* keep */
      }
    })();
  }, [smsUiEnabled]);

  useEffect(() => {
    setSelectedKey(null);
  }, [listSegment]);

  const filteredEmail = useMemo(
    () => filterEmailInboxThreads(emailThreads, { keepSmsLike: !smsUiEnabled }),
    [emailThreads, smsUiEnabled],
  );

  const emailItems = useMemo((): UnifiedInboxListItem[] => {
    let rows = filteredEmail;
    if (listSegment === "archived") {
      rows = rows.filter((t) => t.folder === "trash");
    } else if (listSegment === "unread") {
      rows = rows.filter((t) => t.folder !== "trash" && t.folder === "inbox" && t.unread);
    } else {
      rows = rows.filter((t) => t.folder !== "trash");
    }

    const items = rows.map((t) => {
      const msgs = inboxThreadMessages(t);
      const lastMsg = msgs[msgs.length - 1];
      const sentSemantics = t.folder === "sent";
      return {
        key: unifiedInboxKey("email", t.id),
        channel: "email" as const,
        threadId: t.id,
        name: sentSemantics ? t.email || "Recipient" : t.from || t.email || "Sender",
        subtitle: t.subject,
        preview: previewLine(lastMsg?.body ?? t.preview ?? "", 80),
        previewPrefix: t.folder === "sent" ? "You: " : undefined,
        time: t.time,
        unread: t.folder === "inbox" && t.unread,
        // Sort on the SAME field the row is labelled with — only `thread.time`
        // is normalized; `lastMsg.at` is whatever shape its writer built.
        sortMs: inboxThreadSortMs(t.id, t.time),
      };
    });
    if (listSegment === "unread") return items.filter((item) => item.unread);
    return items;
  }, [filteredEmail, listSegment]);

  const smsItems = useMemo((): UnifiedInboxListItem[] => {
    if (!smsUiEnabled || listSegment === "archived") return [];
    const scoped = smsMessages;
    if (scoped.length === 0) return [];
    const last = [...scoped].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    const unread = scoped.some((m) => m.direction === "inbound" && smsMessageBucket(m, smsOpened) === "unopened");
    const item: UnifiedInboxListItem = {
      key: unifiedInboxKey("sms", SMS_THREAD_ID),
      channel: "sms",
      threadId: SMS_THREAD_ID,
      name: "Text messages",
      subtitle: "Property manager",
      preview: previewLine(last.body, 80),
      previewPrefix: last.direction === "outbound" ? "You: " : undefined,
      time: formatPacificDate(last.createdAt, { hour: "numeric", minute: "2-digit" }),
      unread,
      sortMs: Date.parse(last.createdAt) || 0,
    };
    if (listSegment === "unread" && !unread) return [];
    return [item];
  }, [listSegment, smsMessages, smsOpened, smsUiEnabled]);

  const merged = useMemo(
    () => mergeUnifiedInboxItems([...emailItems, ...smsItems], "recent"),
    [emailItems, smsItems],
  );
  const selection = useMemo(() => (selectedKey ? parseUnifiedInboxKey(selectedKey) : null), [selectedKey]);

  useEffect(() => {
    if (!routeThreadId) return;
    const match = merged.find((r) => r.threadId === routeThreadId);
    if (match) setSelectedKey(match.key);
  }, [routeThreadId, merged]);

  useEffect(() => {
    onThreadOpenChange?.(Boolean(routeThreadId) && Boolean(selection));
  }, [onThreadOpenChange, routeThreadId, selection]);

  useEffect(() => {
    onThreadSelectedChange?.(Boolean(selection));
  }, [onThreadSelectedChange, selection]);

  const listPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Above the list on purpose: the first thing on the screen they opened in
          order to reach someone, and it does not scroll away inside a thread. */}
      <ResidentManagerNumberCard />
      <div className={INBOX_LIST_SCROLL}>
        {merged.length === 0 ? (
          listSegment === "archived" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No archived conversations." />
            </div>
          ) : listSegment === "unread" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No unread conversations." />
            </div>
          ) : null
        ) : (
          merged.map((row) => (
            <InboxConversationRow
              key={row.key}
              name={row.name}
              subtitle={row.subtitle}
              preview={row.preview}
              previewPrefix={row.previewPrefix}
              time={row.time}
              unread={row.unread}
              selected={selectedKey === row.key}
              onOpen={() => {
                setSelectedKey(row.key);
                onRouteThreadChange?.(row.threadId);
                const href = `${commBase}/${listSegment}/${encodeURIComponent(row.threadId)}`;
                if (routeThreadId !== row.threadId) {
                  selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
                }
              }}
            />
          ))
        )}
      </div>
    </div>
  );

  const smsSelected = selection?.channel === "sms";
  const threadPane = (
    <>
      {smsSelected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <RoleSmsPanel apiPath="/api/resident/sms-conversations" storageScope="resident" tabId={"all" as ManagerSmsBucketId} />
        </div>
      ) : null}
      <div className={smsSelected ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ResidentInboxPanel
          ref={inboxRef}
          tabId={listSegment === "archived" ? "trash" : "all"}
          embeddedInCommunication
          externalTitleActions
          suppressListPane
          smsUiEnabled={smsUiEnabled}
          controlledExpandedId={selection?.channel === "email" ? selection.threadId : null}
          onControlledExpandedIdChange={(id) => {
            if (!id) {
              setSelectedKey(null);
              onRouteThreadChange?.(undefined);
              clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
              return;
            }
            setSelectedKey(unifiedInboxKey("email", id));
            onRouteThreadChange?.(id);
            const href = `${commBase}/${listSegment}/${encodeURIComponent(id)}`;
            if (routeThreadId !== id) {
              selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
            }
          }}
        />
      </div>
    </>
  );

  return (
    <InboxTwoPane
      heightMode="viewport"
      fillViewport={Boolean(selection)}
      fillParent
      mobileCompact
      className="min-h-0 flex-1 max-md:rounded-xl max-md:shadow-[var(--shadow-sm)]"
      threadOpen={Boolean(selection)}
      list={listPane}
      thread={threadPane}
    />
  );
}

/** @deprecated Folder tabs removed; kept so legacy routes still resolve. */
export type ResidentEmailTabId = "unopened" | "opened" | "schedule" | "sent" | "trash";

export function ResidentCommunication({
  listSegment = "active",
  threadId,
  smsUiEnabled = false,
}: {
  /** Routed conversation list segment (Active / Unread / Archived). */
  listSegment?: InboxListSegment;
  /** Deep-linked thread id from `/communication/{segment}/{threadId}`. */
  threadId?: string;
  /** @deprecated Folder tabs removed; kept so legacy routes still resolve. */
  inboxTabId?: ResidentEmailTabId;
  smsUiEnabled?: boolean;
}) {
  const commBase = `${RESIDENT_PORTAL_BASE_PATH}/communication`;
  const inboxRef = useRef<ResidentInboxPanelHandle>(null);
  const { activeThreadId, setActiveThreadId } = useCommunicationThreadId(commBase, threadId);
  const [threadOpen, setThreadOpen] = useState(Boolean(threadId));
  const [threadSelected, setThreadSelected] = useState(Boolean(threadId));
  const [communicationSettingsOpen, setCommunicationSettingsOpen] = useState(false);
  const demo = isDemoModeActive();

  const openCompose = () => inboxRef.current?.openCompose();

  const communicationNewMessageButton = (
    <Button
      type="button"
      className={PORTAL_COMMAND_PRIMARY_ACTION_BTN}
      style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
      data-attr="communication-new-message"
      aria-label="New message"
      onClick={openCompose}
    >
      <span className="sm:hidden" aria-hidden="true">
        Message
      </span>
      <span className="hidden sm:inline">New message</span>
    </Button>
  );

  const communicationCommandActions = (
    <>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        data-attr="communication-settings-open"
        onClick={() => setCommunicationSettingsOpen(true)}
      >
        Settings
      </Button>
      {communicationNewMessageButton}
    </>
  );

  const controlStack = (
    <PortalListControlStack
      variant="command"
      stickyDestinations={false}
      destinations={[
        { id: "active", label: "Active", href: `${commBase}/active`, dataAttr: "communication-segment-active" },
        {
          id: "archived",
          label: "Archived",
          href: `${commBase}/archived`,
          dataAttr: "communication-segment-archived",
        },
      ]}
      activeDestinationId={listSegment === "unread" ? "active" : listSegment}
      destinationAriaLabel="Conversation folders"
      actions={communicationCommandActions}
    />
  );

  return (
    <PortalCommunicationShell
      title="Communication"
      hideTitleOnMobileNav
      controlStack={controlStack}
      hideMobileFilterRow={threadOpen}
      mobileThreadReading={threadOpen}
      threadSelected={threadSelected}
      hideAssistantFab
    >
      <ResidentUnifiedInbox
        inboxRef={inboxRef}
        smsUiEnabled={smsUiEnabled}
        listSegment={listSegment}
        routeThreadId={activeThreadId}
        onRouteThreadChange={setActiveThreadId}
        onThreadOpenChange={setThreadOpen}
        onThreadSelectedChange={setThreadSelected}
        commBase={commBase}
        onAddConversation={() => inboxRef.current?.openCompose()}
      />
      <Modal
        open={communicationSettingsOpen}
        onClose={() => setCommunicationSettingsOpen(false)}
        title="Messaging"
        panelClassName={MODAL_LARGE_PANEL_CLASS}
      >
        <PortalTextNotificationsBlock
          dataAttrPrefix="resident"
          demo={demo}
          description="Verify your mobile number to receive property updates and securely use the resident text assistant."
        />
      </Modal>
    </PortalCommunicationShell>
  );
}
