"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  INBOX_TAB_DEFS,
  PortalInboxEmptyState,
  PortalInboxMessageTable,
  inboxTabEmptyCopy,
  type PortalInboxTableRow,
} from "@/components/portal/portal-inbox-ui";
import { ManagerPortalPageShell, ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import { AdminInboxSchedulePanel } from "@/components/portal/admin-inbox-schedule-panel";
import { isUpcomingScheduledInboxMessage, type ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import {
  appendInboxMessage,
  appendThreadReply,
  emptyAdminInboxTrash,
  markInboxMessageRead,
  moveInboxMessageToTrash,
  permanentlyDeleteInboxMessage,
  readInboxMessages,
  restoreInboxMessageFromTrash,
  roleAllowsThread,
  syncInboxMessagesFromServer,
  type AdminComposeSendMode,
  type InboxMessage,
} from "@/lib/demo-admin-partner-inbox";
import { isDemoModeActive } from "@/lib/demo/demo-session";

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function toAdminTableRows(list: InboxMessage[]): PortalInboxTableRow[] {
  // Display semantics are per-ROW folder, not the active tab — the unified "all"
  // list mixes inbox (show sender) and sent (show recipient label) rows.
  return list.map((row) => {
    const isSent = row.folder === "sent";
    return {
      id: row.id,
      name: isSent ? row.composeRecipientLabel ?? row.name : row.name,
      email:
        isSent &&
        (row.composeAudience === "all" ||
          row.composeAudience === "all_managers" ||
          row.composeAudience === "all_residents")
          ? ""
          : row.email,
      subject: row.topic,
      whenLabel: formatWhen(row.createdAt),
      read: row.read,
    };
  });
}

const ADMIN_COMPOSE_MODE_OPTIONS: { value: AdminComposeSendMode; label: string }[] = [
  { value: "all_portal", label: "Everyone (managers & residents)" },
  { value: "all_managers", label: "All managers" },
  { value: "all_residents", label: "All residents" },
  { value: "pick_managers", label: "Choose managers…" },
  { value: "pick_residents", label: "Choose residents…" },
];

type Recipient = { id: string; name: string; email: string };

function defaultScheduleAtLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ComposeModal({
  open,
  onClose,
  onSent,
  recipients,
  initialSchedule,
}: {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  recipients: { managers: Recipient[]; residents: Recipient[] };
  /** Open pre-set to "Schedule for later" (used by the Schedule tab's "Schedule message" button). */
  initialSchedule?: boolean;
}) {
  const { showToast } = useAppUi();
  const [mode, setMode] = useState<AdminComposeSendMode>("pick_managers");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [topic, setTopic] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [sendAtLocal, setSendAtLocal] = useState(defaultScheduleAtLocal());

  const pickPool = useMemo(() => {
    if (mode === "pick_managers") return recipients.managers;
    if (mode === "pick_residents") return recipients.residents;
    return [] as Recipient[];
  }, [mode, recipients]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setTopic("");
      setBody("");
      setMode("pick_managers");
      const first = recipients.managers[0]?.id;
      setSelectedIds(first ? new Set([first]) : new Set());
      setSendMode(initialSchedule ? "schedule" : "now");
      setSendAtLocal(defaultScheduleAtLocal());
    });
  }, [open, recipients.managers, initialSchedule]);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickHeading =
    mode === "pick_managers" ? "Which managers" : mode === "pick_residents" ? "Which residents" : null;

  const resolvePicked = (): Recipient[] => {
    if (mode === "all_portal") return [...recipients.managers, ...recipients.residents];
    if (mode === "all_managers") return recipients.managers;
    if (mode === "all_residents") return recipients.residents;
    const pool = mode === "pick_managers" ? recipients.managers : recipients.residents;
    return pool.filter((p) => selectedIds.has(p.id));
  };

  const submitSendNow = (topicTrim: string, bodyTrim: string) => {
    let toUserIds: string[] = [];

    if (mode === "all_portal" || mode === "all_managers" || mode === "all_residents") {
      const label =
        mode === "all_portal"
          ? "All managers & residents"
          : mode === "all_managers"
            ? "All managers"
            : "All residents";
      const emailStub =
        mode === "all_portal"
          ? "all-portal@axis.local"
          : mode === "all_managers"
            ? "all-managers@axis.local"
            : "all-residents@axis.local";
      appendInboxMessage({
        name: "Broadcast",
        email: emailStub,
        topic: topicTrim,
        body: bodyTrim,
        folder: "sent",
        senderRole: "admin",
        composeAudience: mode === "all_portal" ? "all" : mode,
        composeRecipientLabel: label,
      });
      toUserIds = resolvePicked().map((p) => p.id);
    } else {
      const picked = resolvePicked();
      if (picked.length === 0) {
        showToast("Select at least one recipient.");
        return false;
      }
      const roleLabel = mode === "pick_managers" ? "Manager" : "Resident";
      appendInboxMessage({
        name: picked.length === 1 ? picked[0]!.name : `${picked.length} recipients`,
        email: picked.map((p) => p.email).filter(Boolean).join("; "),
        topic: topicTrim,
        body: bodyTrim,
        folder: "sent",
        senderRole: "admin",
        composeAudience: picked.length > 1 ? "multi" : mode === "pick_managers" ? "manager" : "resident",
        composeRecipientLabel:
          picked.length === 1
            ? `${picked[0]!.name} (${roleLabel})`
            : `${picked.length} ${roleLabel.toLowerCase()}s (${picked.map((p) => p.name).join(", ")})`,
      });
      toUserIds = picked.map((p) => p.id);
    }

    // Deliver to each recipient's real portal inbox (admin's own "Sent" record above is separate).
    if (toUserIds.length > 0) {
      void fetch("/api/portal/send-inbox-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromName: "PropLane Admin",
          toUserIds,
          subject: topicTrim,
          text: bodyTrim,
          deliverViaEmail: false,
          senderPortal: "manager",
        }),
      }).catch(() => undefined);
    }

    showToast("Message sent. It appears under Sent.");
    return true;
  };

  const submitSchedule = async (topicTrim: string, bodyTrim: string) => {
    const sendAt = new Date(sendAtLocal);
    if (Number.isNaN(sendAt.getTime())) {
      showToast("Choose a valid send date and time.");
      return false;
    }
    if (sendAt.getTime() < Date.now() - 60_000) {
      showToast("Send time must be in the future.");
      return false;
    }
    const picked = resolvePicked();
    if (picked.length === 0) {
      showToast("Select at least one recipient.");
      return false;
    }

    const results = await Promise.all(
      picked.map((p) =>
        fetch("/api/portal/scheduled-inbox-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject: topicTrim,
            body: bodyTrim,
            sendAt: sendAt.toISOString(),
            recipientEmail: p.email,
            recipientName: p.name,
            recipientUserId: p.id,
            deliverViaEmail: false,
          }),
        })
          .then((res) => res.ok)
          .catch(() => false),
      ),
    );
    if (results.some((ok) => !ok)) {
      showToast("Some recipients could not be scheduled.");
      return false;
    }

    showToast(
      picked.length === 1 ? "Message scheduled." : `Message scheduled for ${picked.length} recipients.`,
    );
    return true;
  };

  const submit = async () => {
    const isPick = mode.startsWith("pick");
    if (isPick && selectedIds.size === 0) {
      showToast("Select at least one recipient.");
      return;
    }

    const topicTrim = topic.trim();
    const bodyTrim = body.trim();
    if (!topicTrim || !bodyTrim) {
      showToast("Add a subject and message.");
      return;
    }

    setBusy(true);
    try {
      const ok =
        sendMode === "schedule" ? await submitSchedule(topicTrim, bodyTrim) : submitSendNow(topicTrim, bodyTrim);
      if (!ok) return;
      onSent();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initialSchedule ? "Schedule message" : "New message"}
      description={
        initialSchedule
          ? "Choose recipients, write the message, and set when it should be delivered."
          : "Broadcast to a group or choose specific managers or residents."
      }
      panelClassName={MODAL_LARGE_PANEL_CLASS}
      footer={
        <ModalFooter>
          <Button type="button" className="rounded-full" onClick={() => submit()} disabled={busy}>
            {busy ? "Sending…" : sendMode === "schedule" ? "Schedule" : "Send"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Send to</label>
            <Select
              className="mt-1.5"
              value={mode}
              onChange={(e) => {
                const v = e.target.value as AdminComposeSendMode;
                setMode(v);
                if (v === "pick_managers") {
                  const first = recipients.managers[0]?.id;
                  setSelectedIds(first ? new Set([first]) : new Set());
                } else if (v === "pick_residents") {
                  const first = recipients.residents[0]?.id;
                  setSelectedIds(first ? new Set([first]) : new Set());
                } else {
                  setSelectedIds(new Set());
                }
              }}
              aria-label="Recipient type"
            >
              {ADMIN_COMPOSE_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>

          {pickHeading && pickPool.length > 0 ? (
            <div className="rounded-xl border border-border bg-accent/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{pickHeading}</span>
                <button
                  type="button"
                  className="text-xs font-semibold text-primary hover:underline"
                  onClick={() => setSelectedIds(new Set(pickPool.map((p) => p.id)))}
                >
                  Select all
                </button>
              </div>
              <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto pr-1">
                {pickPool.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-card px-2 py-2 text-sm ring-1 ring-border hover:bg-accent/30">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleId(c.id)}
                      />
                      <span>
                        <span className="font-medium text-foreground">{c.name}</span>
                        <span className="mt-0.5 block text-xs text-muted">{c.email}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Subject</label>
            <Input className="mt-1.5" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Subject" />
          </div>

          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Message</label>
            <Textarea
              className="mt-1.5 min-h-[140px]"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message…"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">When</label>
            <div className="mt-1.5 flex gap-2">
              <button
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${sendMode === "now" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted"}`}
                onClick={() => setSendMode("now")}
                disabled={busy}
              >
                Send now
              </button>
              <button
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${sendMode === "schedule" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted"}`}
                onClick={() => setSendMode("schedule")}
                disabled={busy}
              >
                Schedule for later
              </button>
            </div>
            {sendMode === "schedule" ? (
              <Input
                type="datetime-local"
                className="mt-2"
                value={sendAtLocal}
                onChange={(e) => setSendAtLocal(e.target.value)}
                disabled={busy}
              />
            ) : null}
          </div>
        </div>
    </Modal>
  );
}

export type AdminInboxClientHandle = {
  openCompose: () => void;
  emptyTrash: () => void;
};

export type AdminInboxTabCounts = {
  unopened: number;
  opened: number;
  schedule: number;
  sent: number;
  trash: number;
};

export const AdminInboxClient = forwardRef<
  AdminInboxClientHandle,
  {
    tabId: string;
    /** Which status pill opens active, from the folder named in the URL. */
    initialEmailTab?: "unopened" | "opened" | "sent";
    /** Base path for tab nav — defaults to the legacy `/admin/inbox` path (redirects to Communication → Email). */
    commBase?: string;
    embeddedInCommunication?: boolean;
    externalTitleActions?: boolean;
    onTabCountsChange?: (counts: AdminInboxTabCounts) => void;
  }
>(function AdminInboxClient(
  {
    tabId,
    initialEmailTab,
    commBase = "/admin/inbox",
    embeddedInCommunication = false,
    externalTitleActions = false,
    onTabCountsChange,
  },
  ref,
) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [tick, setTick] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  // Messages marked read while viewing "Unopened" stay listed here until the tab
  // is switched or the page is refreshed; they only move to "Opened" on reset.
  const [retainedIds, setRetainedIds] = useState<Set<string>>(() => new Set());
  const [composeInitialSchedule, setComposeInitialSchedule] = useState(false);
  const [recipients, setRecipients] = useState<{ managers: Recipient[]; residents: Recipient[] }>({
    managers: [],
    residents: [],
  });
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledInboxMessageRecord[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(true);
  // Seeded from the folder in the URL, so a link to `…/inbox/sent` opens on Sent
  // rather than silently showing Unopened.
  const [embeddedInboxTab, setEmbeddedInboxTab] = useState<"unopened" | "opened" | "sent">(
    initialEmailTab ?? "unopened",
  );
  const effectiveTabId =
    embeddedInCommunication && tabId === "all" ? embeddedInboxTab : tabId;

  const reloadScheduled = useCallback(async () => {
    setScheduledLoading(true);
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setScheduledMessages(Array.isArray(body.messages) ? body.messages : []);
    } catch {
      /* ignore */
    } finally {
      setScheduledLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadScheduled();
  }, [reloadScheduled]);

  const scheduleCount = useMemo(
    () => scheduledMessages.filter((m) => isUpcomingScheduledInboxMessage(m.sendAt, m.status) && m.status === "scheduled").length,
    [scheduledMessages],
  );

  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(ADMIN_UI_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(ADMIN_UI_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);

  useEffect(() => {
    void syncInboxMessagesFromServer().then(() => setTick((t) => t + 1));
  }, []);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/portal-users", { credentials: "include" });
        const body = (await res.json()) as {
          managers?: Recipient[];
          residents?: Recipient[];
        };
        if (!res.ok || cancelled) return;
        setRecipients({
          managers: body.managers ?? [],
          residents: body.residents ?? [],
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const all = useMemo(() => {
    void tick;
    return readInboxMessages();
  }, [tick]);

  const rows = useMemo(() => {
    // Unified Communication view: ONE list of every live conversation (inbox +
    // sent), newest first, no folder tabs. Trash is reachable via the archive
    // toggle. The legacy per-tab callers keep their exact behavior.
    if (effectiveTabId === "all")
      return all
        .filter((m) => m.folder === "inbox" || m.folder === "sent")
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (effectiveTabId === "unopened")
      return all.filter((m) => m.folder === "inbox" && (!m.read || retainedIds.has(m.id)));
    if (effectiveTabId === "opened") return all.filter((m) => m.folder === "inbox" && m.read);
    if (effectiveTabId === "sent") return all.filter((m) => m.folder === "sent");
    if (effectiveTabId === "trash") return all.filter((m) => m.folder === "trash");
    return [] as InboxMessage[];
  }, [all, effectiveTabId, retainedIds]);

  // Reset the "keep read messages listed" retention whenever the tab changes,
  // so returning to Unopened (or refreshing) shows the true unread set.
  useEffect(() => {
    setRetainedIds(new Set());
  }, [effectiveTabId]);

  const folderCounts = useMemo(() => {
    return {
      unopened: all.filter((m) => m.folder === "inbox" && !m.read).length,
      opened: all.filter((m) => m.folder === "inbox" && m.read).length,
      schedule: scheduleCount,
      sent: all.filter((m) => m.folder === "sent").length,
      trash: all.filter((m) => m.folder === "trash").length,
    };
  }, [all, scheduleCount]);

  const inboxTabs = useMemo(
    () => INBOX_TAB_DEFS.map(({ id, label }) => ({ id, label, count: folderCounts[id as keyof typeof folderCounts] })),
    [folderCounts],
  );

  useEffect(() => {
    if (embeddedInCommunication) onTabCountsChange?.(folderCounts);
  }, [embeddedInCommunication, onTabCountsChange, folderCounts]);

  const emptyTrash = useCallback(() => {
    const trashCount = folderCounts.trash;
    if (trashCount === 0) return;
    if (!window.confirm(`Delete all ${trashCount} trash message${trashCount === 1 ? "" : "s"}? This cannot be undone.`)) return;
    void emptyAdminInboxTrash().then((ok) => {
      if (ok) {
        showToast("Trash cleared.");
        setExpandedId(null);
        setTick((t) => t + 1);
      } else {
        showToast("Could not clear trash.");
      }
    });
  }, [folderCounts.trash, showToast]);

  useImperativeHandle(
    ref,
    () => ({
      openCompose: () => {
        setComposeInitialSchedule(false);
        setComposeOpen(true);
      },
      emptyTrash,
    }),
    [emptyTrash],
  );

  useEffect(() => {
    if (expandedId && !rows.some((r) => r.id === expandedId)) {
      queueMicrotask(() => setExpandedId(null));
    }
  }, [rows, expandedId]);

  const tableRows = useMemo(() => toAdminTableRows(rows), [rows]);

  // Opening a message no longer marks it read — reading keeps it in Unopened.
  const toggleExpand = (id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
  };

  const markRead = (id: string) => {
    if (markInboxMessageRead(id)) {
      setRetainedIds((prev) => new Set(prev).add(id));
      setTick((t) => t + 1);
    }
  };

  const emptyCopy = inboxTabEmptyCopy(effectiveTabId);

  const fromOrToHeader =
    effectiveTabId === "all" ? "From / To" : effectiveTabId === "sent" ? "To" : "From";

  const bodyById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const row of rows) m[row.id] = row.body;
    return m;
  }, [rows]);

  const titleAside = (
    <>
      <Button
        type="button"
        variant="primary"
        className="shrink-0 rounded-full"
        onClick={() => {
          setComposeInitialSchedule(false);
          setComposeOpen(true);
        }}
      >
        New message
      </Button>
      {tabId === "trash" && folderCounts.trash > 0 ? (
        <Button
          type="button"
          variant="outline"
          className="shrink-0 rounded-full border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]"
          onClick={emptyTrash}
        >
          Delete all trash
        </Button>
      ) : null}
    </>
  );

  const inboxBody = (
    <>
      {embeddedInCommunication && !externalTitleActions ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">{titleAside}</div>
      ) : null}
      {embeddedInCommunication && tabId === "all" ? (
        <div className="mb-4">
          <ManagerPortalStatusPills
            activeTone="primary"
            tabs={inboxTabs.filter((tab) => tab.id === "unopened" || tab.id === "opened" || tab.id === "sent")}
            activeId={embeddedInboxTab}
            onChange={(id) => setEmbeddedInboxTab(id as "unopened" | "opened" | "sent")}
          />
        </div>
      ) : null}
      <div className="space-y-5">
        <ComposeModal
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setTick((t) => t + 1);
            void reloadScheduled();
          }}
          recipients={recipients}
          initialSchedule={composeInitialSchedule}
        />

        {tabId === "schedule" ? (
          <AdminInboxSchedulePanel
            messages={scheduledMessages}
            loading={scheduledLoading}
            onReload={() => void reloadScheduled()}
            onScheduleNew={() => {
              setComposeInitialSchedule(true);
              setComposeOpen(true);
            }}
          />
        ) : rows.length === 0 ? (
          <PortalInboxEmptyState title={emptyCopy} />
        ) : (
          <PortalInboxMessageTable
            rows={tableRows}
            primaryPartyHeader={fromOrToHeader}
            onMarkRead={effectiveTabId === "unopened" || tabId === "all" ? markRead : undefined}
            getDetailBody={(row) => bodyById[row.id]}
            getThreadMessages={(row) => {
              const message = rows.find((r) => r.id === row.id);
              if (!message) return [];
              return [
                {
                  id: `${message.id}-root`,
                  from: message.name,
                  body: message.body,
                  at: formatWhen(message.createdAt),
                },
                ...message.thread.map((t) => ({
                  id: t.id,
                  from: t.authorLabel,
                  body: t.body,
                  at: formatWhen(t.createdAt),
                })),
              ];
            }}
            onReply={
              tabId === "trash"
                ? undefined
                : (row, text) => {
                    const message = rows.find((r) => r.id === row.id);
                    if (!message) return;
                    if (!roleAllowsThread(message.senderRole)) return;
                    if (message.folder !== "inbox" && message.folder !== "sent") return;
                    void (async () => {
                      if (isDemoModeActive()) {
                        if (appendThreadReply(row.id, "PropLane admin", text)) {
                          showToast("Added to thread.");
                          setTick((t) => t + 1);
                        } else {
                          showToast("Could not add reply.");
                        }
                        return;
                      }
                      try {
                        const res = await fetch("/api/admin/inbox-reply", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          credentials: "include",
                          body: JSON.stringify({ threadId: row.id, text }),
                        });
                        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
                        if (!res.ok || !data.ok) {
                          showToast(data.error ?? "Could not send reply.");
                          return;
                        }
                        await syncInboxMessagesFromServer({ force: true });
                        showToast("Reply sent.");
                        setTick((t) => t + 1);
                      } catch {
                        showToast("Could not send reply.");
                      }
                    })();
                  }
            }
            expandedId={expandedId}
            onToggleExpand={toggleExpand}
            renderExtraActions={(row) => {
              if (tabId === "trash") {
                return (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className={PORTAL_DETAIL_BTN}
                      onClick={() => {
                        void restoreInboxMessageFromTrash(row.id).then((ok) => {
                          if (ok) {
                            showToast("Restored.");
                            setExpandedId(null);
                            setTick((t) => t + 1);
                          } else {
                            showToast("Could not restore message.");
                          }
                        });
                      }}
                    >
                      Restore
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className={`${PORTAL_DETAIL_BTN} !border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`}
                      onClick={() => {
                        void permanentlyDeleteInboxMessage(row.id).then((ok) => {
                          if (ok) {
                            showToast("Deleted permanently.");
                            setExpandedId(null);
                            setTick((t) => t + 1);
                          } else {
                            showToast("Could not delete message.");
                          }
                        });
                      }}
                    >
                      Delete forever
                    </Button>
                  </>
                );
              }
              return (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_DETAIL_BTN}
                  onClick={() => {
                    void moveInboxMessageToTrash(row.id).then((ok) => {
                      if (ok) {
                        showToast("Moved to trash.");
                        setExpandedId(null);
                        setTick((t) => t + 1);
                      } else {
                        showToast("Could not move message to trash.");
                      }
                    });
                  }}
                >
                  Move to trash
                </Button>
              );
            }}
          />
        )}
      </div>
    </>
  );

  if (embeddedInCommunication) return inboxBody;

  return (
    <ManagerPortalPageShell
      title="Inbox"
      titleAside={titleAside}
      filterRow={
        <ManagerPortalStatusPills
          activeTone="primary"
          tabs={inboxTabs}
          activeId={tabId}
          onChange={(id) => navigate(`${commBase}/${id}`)}
        />
      }
    >
      {inboxBody}
    </ManagerPortalPageShell>
  );
});
