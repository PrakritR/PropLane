"use client";

import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useInboxThreadScroll } from "@/hooks/use-inbox-thread-scroll";
import {
  buildInboxMessageTimeline,
  inboxBubbleClusterRadius,
  type InboxBubbleClusterPosition,
} from "@/lib/inbox-message-timeline";
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Check, Clock, FileText, Paperclip, Pencil, Plus, Sparkles, X } from "lucide-react";
import { PortalEmptyIcon, PortalEmptyState } from "@/components/portal/portal-empty-state";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_TALL_PANEL_CLASS, PORTAL_MODAL_BODY_SCROLL_CLASS } from "@/components/ui/modal-styles";
import { DEMO_INBOX_REPLY_PREFILL_EVENT } from "@/lib/demo/demo-playback";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import { downloadOrShareFile } from "@/lib/native/download-or-share";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import {
  defaultPortalMessageChannelSelection,
  PortalMessageSendViaField,
  portalMessageChannelsFromSelection,
} from "@/components/portal/portal-message-compose-fields";
import {
  PORTAL_DATA_TABLE, 
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PortalDataTableColGroup,
  portalTableColumnPercents,
  PORTAL_TABLE_INBOX_COLUMN_WEIGHTS,
  PORTAL_DETAIL_BTN,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TR,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
  PortalTableInlineExpand,
  PortalResponsiveDataView,
  PortalTableDetailActions,
  createPortalRowExpandClick,
} from "@/components/portal/portal-data-table";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";
import type { TabItem } from "@/components/ui/tabs";
import type { InboxThreadMessage } from "@/lib/portal-inbox-storage";
import {
  INBOX_ATTACHMENT_ACCEPT,
  inboxAttachmentDisplayName,
  inboxAttachmentPathFromServeUrl,
} from "@/lib/inbox-attachments";
import { cn } from "@/lib/utils";

/** Same chrome as other portal data tables */
export const PORTAL_INBOX_TABLE_WRAP = PORTAL_DATA_TABLE_WRAP;

export const PORTAL_INBOX_EMPTY_WRAP =
  "flex flex-col items-center justify-center rounded-2xl border border-border bg-accent/25 px-4 py-16 text-center sm:py-20";

export function InboxEmptyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

export function PortalInboxEmptyState({ title }: { title: string; hint?: ReactNode }) {
  return <PortalEmptyState title={title} icon="inbox" />;
}

/** Dashed add row for an empty Communication conversation list (replaces “No conversations yet.”). */
export function InboxConversationListAddRow({
  onClick,
  dataAttr = "communication-add-conversation",
}: {
  onClick: () => void;
  dataAttr?: string;
}) {
  return (
    <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
      <PortalListAddRow
        label="Add"
        ariaLabel="Add conversation"
        icon={PORTAL_LIST_ADD_ICONS.conversation}
        onClick={onClick}
        dataAttr={dataAttr}
      />
    </div>
  );
}

/**
 * Tab-specific empty-state copy, shared by every Communication surface (manager
 * unified inbox, resident, admin, vendor) so all four read the same polished
 * "No <tab> messages yet." wording as the Schedule tab's
 * "No scheduled messages in this window." Keep this the single source of truth
 * for the list-pane empty copy — a hand-rolled string in one panel drifts.
 */
export function inboxTabEmptyCopy(tabId: string): string {
  switch (tabId) {
    case "all":
      return "No conversations yet.";
    case "unopened":
      return "No unopened messages yet.";
    case "opened":
      return "No opened messages yet.";
    case "sent":
      return "No sent messages yet.";
    case "trash":
      return "No trash messages yet.";
    case "schedule":
      return "No scheduled messages in this window.";
    default:
      return "No messages yet.";
  }
}

export const INBOX_TAB_DEFS = [
  { id: "unopened", label: "Unopened" },
  { id: "opened", label: "Opened" },
  { id: "schedule", label: "Schedule" },
  { id: "sent", label: "Sent" },
  { id: "trash", label: "Trash" },
] as const;

/** Compose and send an outbound message (client state only until a backend exists). */
export function InboxComposeModal({
  open,
  onClose,
  onSend,
  title = "New message",
}: {
  open: boolean;
  onClose: () => void;
  onSend: (payload: { to: string; subject: string; body: string }) => void;
  title?: string;
}) {
  const { showToast } = useAppUi();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setTo("");
        setSubject("");
        setBody("");
      });
    }
  }, [open]);

  const submit = () => {
    const t = to.trim();
    const s = subject.trim();
    const b = body.trim();
    if (!t || !s || !b) {
      showToast("Enter recipient email, subject, and message.");
      return;
    }
    onSend({ to: t, subject: s, body: b });
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" className="rounded-full" onClick={submit}>
            Send
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-muted" htmlFor="inbox-compose-to">
            To (email)
          </label>
          <Input
            id="inbox-compose-to"
            type="email"
            className="mt-1.5"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
            autoComplete="email"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted" htmlFor="inbox-compose-subject">
            Subject
          </label>
          <Input id="inbox-compose-subject" className="mt-1.5" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted" htmlFor="inbox-compose-body">
            Message
          </label>
          <Textarea
            id="inbox-compose-body"
            className="mt-1.5 min-h-[140px]"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message…"
          />
        </div>
      </div>
    </Modal>
  );
}

export type InboxTabId = (typeof INBOX_TAB_DEFS)[number]["id"];

export function inboxTabItems(basePath: string): TabItem[] {
  return INBOX_TAB_DEFS.map((t) => ({
    id: t.id,
    label: t.label,
    href: `${basePath}/inbox/${t.id}`,
  }));
}

export type PortalInboxTableRow = {
  id: string;
  name: string;
  email: string;
  subject: string;
  whenLabel: string;
  read: boolean;
  /** When false, row cannot be bulk-selected (e.g. already sent/cancelled). */
  selectable?: boolean;
};

export type PortalInboxTableLayout = "default" | "schedule";

export type PortalInboxSelectionProps = {
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  selectableCount: number;
};

export function PortalInboxMessageTable({
  rows,
  onMarkRead,
  getDetailBody,
  getThreadMessages,
  onReply,
  expandedId,
  onToggleExpand,
  renderExtraActions,
  primaryPartyHeader = "From",
  layout = "default",
  selection,
}: {
  rows: PortalInboxTableRow[];
  onMarkRead?: (id: string) => void;
  /** Full message body shown in an expandable row (Details). */
  getDetailBody?: (row: PortalInboxTableRow) => string | undefined;
  getThreadMessages?: (row: PortalInboxTableRow) => InboxThreadMessage[];
  onReply?: (row: PortalInboxTableRow, text: string) => void | Promise<void>;
  expandedId?: string | null;
  onToggleExpand?: (id: string) => void;
  /** Trash / restore / delete — shown in the expanded row only (with Mark read, Reply, Hide). */
  renderExtraActions?: (row: PortalInboxTableRow) => ReactNode;
  primaryPartyHeader?: "From" | "To" | "Recipient" | "From / To";
  /** Schedule tab uses Recipient + Send date & time + Subject (no trailing When). */
  layout?: PortalInboxTableLayout;
  selection?: PortalInboxSelectionProps;
}) {
  const { showToast } = useAppUi();
  const [replyDraftById, setReplyDraftById] = useState<Record<string, string>>({});
  const [replyBusyId, setReplyBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!isDemoModeActive()) return;
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent<{ rowId?: string; text?: string }>).detail;
      const rowId = detail?.rowId?.trim();
      const text = detail?.text?.trim();
      if (!rowId || !text) return;
      setReplyDraftById((prev) => ({ ...prev, [rowId]: text }));
    };
    window.addEventListener(DEMO_INBOX_REPLY_PREFILL_EVENT, onPrefill as EventListener);
    return () => window.removeEventListener(DEMO_INBOX_REPLY_PREFILL_EVENT, onPrefill as EventListener);
  }, []);

  const renderExpandedContent = (row: PortalInboxTableRow, detailText: string | undefined, extra: ReactNode) => {
    const hasMarkRead = Boolean(!row.read && onMarkRead);
    return (
      <>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Conversation</p>
        <div className="mt-2 space-y-3">
          {(getThreadMessages?.(row) ?? [
            {
              id: `${row.id}-root`,
              from: row.name,
              body: (detailText ?? "").trim() || "—",
              at: row.whenLabel,
            },
          ]).map((msg) => (
            <div key={msg.id} className="rounded-xl border border-border bg-accent/20 px-3 py-2.5">
              <p className="text-[11px] font-semibold text-foreground">{msg.from}</p>
              <p className="text-[10px] text-muted">{msg.at}</p>
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-muted">{msg.body}</p>
            </div>
          ))}
        </div>
        {onReply ? (
          <div className="mt-4">
            <Textarea
              rows={3}
              placeholder="Write a reply…"
              value={replyDraftById[row.id] ?? ""}
              onChange={(e) => setReplyDraftById((prev) => ({ ...prev, [row.id]: e.target.value }))}
              className="text-sm"
            />
          </div>
        ) : null}
        <PortalTableDetailActions>
          {hasMarkRead ? (
            <Button type="button" variant="outline" className={PORTAL_DETAIL_BTN} data-attr="inbox-mark-read" onClick={() => onMarkRead?.(row.id)}>
              Mark read
            </Button>
          ) : null}
          {extra}
          {onReply ? (
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr="inbox-reply-send"
              disabled={replyBusyId === row.id || !(replyDraftById[row.id] ?? "").trim()}
              onClick={() => {
                const text = (replyDraftById[row.id] ?? "").trim();
                if (!text) return;
                setReplyBusyId(row.id);
                void Promise.resolve(onReply(row, text))
                  .then(() => {
                    setReplyDraftById((prev) => ({ ...prev, [row.id]: "" }));
                    showToast("Reply sent.");
                  })
                  .catch(() => showToast("Could not send reply."))
                  .finally(() => setReplyBusyId(null));
              }}
            >
              {replyBusyId === row.id ? "Sending…" : "Send reply"}
            </Button>
          ) : null}
        </PortalTableDetailActions>
      </>
    );
  };

  const showSelection = Boolean(selection && selection.selectableCount > 0);
  const dataColCount = 3;
  const detailColSpan = dataColCount + (showSelection ? 1 : 0);
  const isScheduleLayout = layout === "schedule";
  const partyHeader =
    primaryPartyHeader === "Recipient" || isScheduleLayout ? "Recipient" : primaryPartyHeader;
  const middleHeader = isScheduleLayout ? "Send date & time" : "Subject";
  const trailingHeader = isScheduleLayout ? "Subject" : "When";

  const renderRowCheckbox = (row: PortalInboxTableRow, className = "") => {
    if (!selection || row.selectable === false) return null;
    return (
      <input
        type="checkbox"
        className={`h-4 w-4 shrink-0 rounded border-border accent-primary ${className}`}
        checked={selection.selectedIds.has(row.id)}
        onChange={() => selection.onToggleSelected(row.id)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select message ${row.subject}`}
      />
    );
  };

  const mobileCards = (
    <>
      {rows.map((row) => {
        const detailText = getDetailBody?.(row);
        const rowExpandable = Boolean(onToggleExpand);
        const isExpanded = expandedId === row.id && rowExpandable;
        const hasMarkRead = Boolean(!row.read && onMarkRead);
        const extra = renderExtraActions?.(row);

        return (
          <div key={row.id} id={`portal-inbox-thread-${row.id}`} className={PORTAL_MOBILE_CARD_CLASS}>
            <div className="flex items-start gap-3">
              {renderRowCheckbox(row, "mt-1")}
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => (rowExpandable ? onToggleExpand?.(row.id) : undefined)}
                disabled={!rowExpandable}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {rowExpandable ? (
                      <PortalTableInlineExpand
                        expanded={isExpanded}
                        className={`truncate font-semibold text-foreground ${!row.read ? "" : "text-foreground/90"}`}
                      >
                        {!row.read ? "● " : ""}
                        {row.name}
                      </PortalTableInlineExpand>
                    ) : (
                      <p className={`truncate font-semibold text-foreground ${!row.read ? "" : "text-foreground/90"}`}>
                        {!row.read ? "● " : ""}
                        {row.name}
                      </p>
                    )}
                    {row.email ? <p className="mt-0.5 truncate text-xs text-muted">{row.email}</p> : null}
                    {isScheduleLayout ? (
                      <p className="mt-1 truncate text-xs text-muted">{row.whenLabel}</p>
                    ) : null}
                    <p className={`truncate text-xs font-medium text-foreground ${isScheduleLayout ? "mt-1" : "mt-0.5"}`}>
                      {row.subject}
                    </p>
                  </div>
                  {!isScheduleLayout ? (
                    <p className="shrink-0 text-[11px] text-muted">{row.whenLabel}</p>
                  ) : null}
                </div>
              </button>
            </div>
            {!rowExpandable && (hasMarkRead || extra) ? (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                {hasMarkRead ? (
                  <Button type="button" variant="outline" className={PORTAL_DETAIL_BTN} onClick={() => onMarkRead?.(row.id)}>
                    Mark read
                  </Button>
                ) : null}
                {extra}
              </div>
            ) : null}
            {isExpanded ? (
              <div className="mt-3 border-t border-border pt-3">{renderExpandedContent(row, detailText, extra)}</div>
            ) : null}
          </div>
        );
      })}
    </>
  );

  const desktopTable = (
    <div className={PORTAL_INBOX_TABLE_WRAP}>
      <div className={PORTAL_DATA_TABLE_SCROLL}>
        <table className={PORTAL_DATA_TABLE}>
          <PortalDataTableColGroup
            percents={[
              ...(showSelection
                ? portalTableColumnPercents(dataColCount, [3, ...PORTAL_TABLE_INBOX_COLUMN_WEIGHTS])
                : portalTableColumnPercents(dataColCount, PORTAL_TABLE_INBOX_COLUMN_WEIGHTS)),
            ]}
          />
          <thead>
            <tr className={PORTAL_TABLE_HEAD_ROW}>
              {showSelection ? (
                <th className={`${MANAGER_TABLE_TH} w-10 text-left`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border accent-primary"
                    checked={selection!.allSelected}
                    onChange={() => selection!.onToggleSelectAll()}
                    aria-label="Select all messages"
                  />
                </th>
              ) : null}
              <th className={`${MANAGER_TABLE_TH} text-left`}>{partyHeader}</th>
              <th className={`${MANAGER_TABLE_TH} text-left`}>{middleHeader}</th>
              <th className={`${MANAGER_TABLE_TH} text-left`}>{trailingHeader}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const detailText = getDetailBody?.(row);
              const rowExpandable = Boolean(onToggleExpand);
              const isExpanded = expandedId === row.id && rowExpandable;
              const extra = renderExtraActions?.(row);

              return (
                <Fragment key={row.id}>
                  <tr
                    id={`portal-inbox-thread-${row.id}`}
                    className={rowExpandable ? PORTAL_TABLE_TR_EXPANDABLE : PORTAL_TABLE_TR}
                    onClick={
                      rowExpandable
                        ? createPortalRowExpandClick(() => onToggleExpand?.(row.id))
                        : undefined
                    }
                    aria-expanded={rowExpandable ? isExpanded : undefined}
                  >
                    {showSelection ? (
                      <td className={`${PORTAL_TABLE_TD} w-10 align-middle`}>{renderRowCheckbox(row)}</td>
                    ) : null}
                    <td className={`${PORTAL_TABLE_TD} align-middle`}>
                      {rowExpandable ? (
                        <PortalTableInlineExpand expanded={isExpanded} className="font-medium text-foreground">
                          {row.name}
                        </PortalTableInlineExpand>
                      ) : (
                        <p className="font-medium text-foreground">{row.name}</p>
                      )}
                      {row.email ? <p className="mt-0.5 text-xs text-muted">{row.email}</p> : null}
                    </td>
                    <td className={`${PORTAL_TABLE_TD} align-middle text-muted`}>
                      {isScheduleLayout ? row.whenLabel : row.subject}
                    </td>
                    <td className={`${PORTAL_TABLE_TD} align-middle ${isScheduleLayout ? "font-medium text-foreground" : "text-muted"}`}>
                      {isScheduleLayout ? row.subject : row.whenLabel}
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr className={PORTAL_TABLE_DETAIL_ROW}>
                      <td colSpan={detailColSpan} className={`${PORTAL_TABLE_DETAIL_CELL} text-left`}>
                        {renderExpandedContent(row, detailText, extra)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  return <PortalResponsiveDataView mobile={mobileCards} desktop={desktopTable} />;
}

/* ------------------------------------------------------------------ *
 * Inline two-pane inbox primitives (Airbnb / Intercom / Front style). *
 *                                                                     *
 * A conversation list on the left; the open thread rendered as chat   *
 * bubbles with a persistent composer on the right — no modal to send  *
 * a reply. Everything below is theme-tokened (no hardcoded colours),  *
 * so it matches the rest of the site in light and dark and is         *
 * native-safe. The manager email inbox consumes these today; the      *
 * resident / vendor / admin conversions build on the same primitives. *
 * These are ADDITIVE — the table primitives above stay for the        *
 * surfaces not yet migrated.                                          *
 * ------------------------------------------------------------------ */

export type InboxMessageDirection = "inbound" | "outbound";

/**
 * Channel a thread message arrived / sent on. Email is the only live channel
 * today; the union carries the post-A2P channels so a per-person conversation
 * can AGGREGATE email + SMS + WhatsApp + Gmail in one thread — adding a channel
 * is additive (tag the message), never a new parallel thread.
 */
export type InboxChannel = "email" | "sms" | "whatsapp" | "gmail";

export const INBOX_CHANNEL_LABEL: Record<InboxChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  gmail: "Gmail",
};

export type InboxBubbleMessage = {
  id: string;
  /** Display name of the author (shown above inbound bubbles when grouped). */
  author: string;
  body: string;
  /** Human timestamp label — already formatted by the caller. */
  at: string;
  direction: InboxMessageDirection;
  /** Optional delivery/status caption under the bubble (e.g. "Scheduled"). */
  status?: string;
  /** Optimistic send lifecycle for outbound bubbles. */
  delivery?: "sending" | "sent" | "failed";
  /** Channel this message belongs to. Defaults to "email" when omitted. */
  channel?: InboxChannel;
  attachments?: { url: string; name?: string }[];
};

/**
 * Label for an attachment chip, in strict precedence order:
 *
 *  1. the last segment of the storage key carried in `?path=` — the uploader's
 *     own file name, so it can never drift from the bytes it names;
 *  2. the copy persisted in `row_data`, for a URL that carries no key;
 *  3. the URL's own last path segment.
 *
 * (2) has to beat (3): the serve URL percent-encodes the whole key, so a serve
 * URL that lost its `?path=` has the literal route name `inbox-attachments` as
 * its last segment — the exact wrong label this ordering exists to avoid.
 */
export function inboxAttachmentChipName(att: { url: string; name?: string }): string | undefined {
  const fromKey = inboxAttachmentPathFromServeUrl(att.url).split("/").pop()?.trim();
  if (fromKey) return fromKey;
  const stored = att.name?.trim();
  if (stored) return stored;
  return inboxAttachmentDisplayName(att.url);
}

/**
 * Suffix, never substring: an image named `floorplan.pdf.png` is a PNG, and a
 * substring test rendered it as a document link instead of a preview. Matches
 * how `InboxComposer` decides below (`/\.pdf$/i` on the file name), and reads
 * the same label the chip shows so the icon can never contradict the name.
 */
export function inboxAttachmentLooksLikePdf(att: { url: string; name?: string }): boolean {
  const name = inboxAttachmentChipName(att);
  if (name) return /\.pdf$/i.test(name);
  return /\.pdf$/i.test(inboxAttachmentPathFromServeUrl(att.url) || att.url.split("?")[0] || "");
}

const INBOX_ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function inboxAttachmentMimeFromName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return INBOX_ATTACHMENT_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * One attachment on a message bubble.
 *
 * On the web this is a plain same-origin `<a download>`: the serve route answers
 * `Content-Disposition: attachment` for every type, so the file is saved rather
 * than rendered on the app's own origin. WKWebView ignores both that disposition
 * (the shell implements no `WKDownloadDelegate`) and a synthetic `<a download>`,
 * so inside the Capacitor shell the tap is intercepted and the bytes are handed
 * to the OS share sheet instead — which still never renders them on-origin.
 *
 * On that native path the ONLY non-failure outcomes are `"shared"` (the OS took
 * the file) and `"share-cancelled"` (the user dismissed the sheet — silent, not
 * an error). `"downloaded"` means the sheet did NOT take it and
 * `downloadOrShareFile` fell back to the anchor download that WKWebView ignores,
 * so it is a dead tap and must surface like a fetch failure. That reading is the
 * call site's, not the helper's: the anchor fallback is a genuine download on
 * every other caller.
 */
function InboxAttachmentChip({
  att,
  outbound,
}: {
  att: { url: string; name?: string };
  outbound: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const label = inboxAttachmentChipName(att);
  const isPdf = inboxAttachmentLooksLikePdf(att);
  const fileName = label ?? (isPdf ? "attachment.pdf" : "attachment");

  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isNativeRuntimeSync()) return;
    event.preventDefault();
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(att.url, { credentials: "include" });
        if (!res.ok) throw new Error(`Attachment fetch failed (${res.status})`);
        const blob = await res.blob();
        const result = await downloadOrShareFile({
          fileName,
          mimeType: blob.type || inboxAttachmentMimeFromName(fileName),
          content: blob,
        });
        if (result === "downloaded") setFailed(true);
      } catch {
        setFailed(true);
      }
    })();
  };

  return (
    <span className="flex max-w-full flex-col gap-1">
      {isPdf ? (
        <a
          href={att.url}
          download={label ?? ""}
          onClick={handleClick}
          className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
            outbound
              ? "border-white/30 bg-white/10 text-white hover:bg-white/15"
              : "border-border/60 bg-background text-foreground hover:bg-accent/40"
          }`}
        >
          <FileText className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{label ?? "PDF document"}</span>
        </a>
      ) : (
        <a
          href={att.url}
          download={label ?? ""}
          onClick={handleClick}
          className="block overflow-hidden rounded-lg border border-border/60"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={att.url} alt={label ?? "Attachment"} className="max-h-40 max-w-full object-cover" />
        </a>
      )}
      {failed ? (
        <span className={`text-[11px] font-medium ${outbound ? "text-white/80" : "text-rose-600"}`}>
          Couldn&apos;t open this attachment.
        </span>
      ) : null}
    </span>
  );
}

/** Small omnichannel channel tag rendered on a bubble / scheduled card. */
export function InboxChannelTag({ channel }: { channel: InboxChannel }) {
  return (
    <span className="rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
      {INBOX_CHANNEL_LABEL[channel]}
    </span>
  );
}

function scheduledDeliveryChannels(
  channel: InboxChannel,
  deliverViaEmail?: boolean,
  deliverViaSms?: boolean,
): InboxChannel[] {
  if (deliverViaEmail !== undefined || deliverViaSms !== undefined) {
    const tags: InboxChannel[] = [];
    if (deliverViaEmail !== false) tags.push("email");
    if (deliverViaSms) tags.push("sms");
    return tags.length > 0 ? tags : ["email"];
  }
  return [channel];
}

export function InboxScheduledChannelTags({
  channel = "email",
  deliverViaEmail,
  deliverViaSms,
}: {
  channel?: InboxChannel;
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
}) {
  const tags = scheduledDeliveryChannels(channel, deliverViaEmail, deliverViaSms);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <InboxChannelTag key={tag} channel={tag} />
      ))}
    </div>
  );
}

/** Shared list-toolbar chrome (segment tabs + search) for inbox panes. */
export const PORTAL_INBOX_LIST_TOOLBAR_CLASS =
  "portal-inbox-list-toolbar shrink-0 space-y-2 border-b border-border p-2 max-md:space-y-1.5 max-md:p-1.5 sm:p-2.5 sm:space-y-2.5";

/** Scrollable body for a conversation list pane (inbox split view). */
export const INBOX_LIST_SCROLL =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]";

/** Full-page record lists — let #portal-main-content scroll (no nested panel). */
export const PORTAL_LIST_PAGE_BODY =
  "portal-list-page-body w-full min-w-0 pb-4 max-lg:pb-[calc(5.5rem+var(--portal-mobile-scroll-bottom-inset,0px))] lg:pb-5";

export function inboxInitials(name: string): string {
  const parts = name
    .trim()
    .replace(/^(to|from):\s*/i, "")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

/** Circular initials avatar in the site accent (cobalt in light, indigo in dark). */
export function InboxAvatar({ name, className = "" }: { name: string; className?: string }) {
  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold tracking-[0.02em] text-white shadow-[0_2px_10px_color-mix(in_srgb,var(--primary)_40%,transparent)] ring-2 ring-[color-mix(in_srgb,var(--primary)_28%,transparent)] ${className}`}
      style={{ background: "linear-gradient(160deg, var(--primary) 0%, var(--primary-alt) 100%)" }}
      aria-hidden
    >
      {inboxInitials(name)}
    </div>
  );
}

/** One row in the left conversation list. */
export function InboxConversationRow({
  name,
  subtitle,
  preview,
  time,
  unread = false,
  selected = false,
  onOpen,
  leading,
  previewPrefix,
  channelBadge,
  trailing,
}: {
  name: string;
  subtitle?: string;
  preview: string;
  time: string;
  /** Unread threads show an Instagram-style dot on the right. */
  unread?: boolean;
  selected?: boolean;
  onOpen: () => void;
  /** Optional slot before the avatar (e.g. a bulk-select checkbox). */
  leading?: ReactNode;
  /** e.g. "You: " when the last message was outbound. */
  previewPrefix?: string;
  /**
   * @deprecated No conversation list passes this any more (PRP-150).
   *
   * The badge repeated on every row what the reply box already offers, and on a
   * merged conversation it said "Email · SMS" about a thread the reader was
   * about to answer on whichever channel they chose anyway. The prop is kept so
   * a surface that genuinely needs to distinguish channels can opt back in
   * without rebuilding the row.
   */
  channelBadge?: "Email" | "SMS" | "Email · SMS";
  /** Optional slot after the row body (e.g. a quick action button). */
  trailing?: ReactNode;
}) {
  return (
    <div
      className={`portal-inbox-row flex items-center gap-2 border-b border-border/50 px-2.5 py-2 transition-colors max-md:gap-1.5 max-md:px-2 max-md:py-1.5 ${
        selected
          ? "portal-inbox-row--selected border-l-[3px] border-l-primary bg-primary/[0.06]"
          : "border-l-[3px] border-l-transparent hover:bg-foreground/[0.03]"
      }`}
    >
      {leading}
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <InboxAvatar name={name} className="h-8 w-8 text-[11px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p
              className={`truncate text-[13px] leading-tight ${
                unread ? "font-semibold text-foreground" : "font-medium text-foreground/90"
              }`}
            >
              {name}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {unread ? (
                <span className="h-2 w-2 rounded-full bg-primary" aria-label="Unread" />
              ) : null}
              <span className="text-[11px] tabular-nums text-muted">{time}</span>
            </div>
          </div>
          {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
          <div className="mt-0.5 flex items-center gap-2">
            {channelBadge ? (
              <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                {channelBadge}
              </span>
            ) : null}
            <p
              className={`min-w-0 flex-1 truncate text-xs ${
                unread ? "font-medium text-foreground/75" : "text-muted"
              }`}
            >
              {previewPrefix ?? ""}
              {preview || " "}
            </p>
          </div>
        </div>
      </button>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

export type InboxListSegment = "active" | "unread" | "archived";

/** Segment tabs above the conversation list (Active / Unread / Archived). */
export function InboxListSegmentTabs({
  value,
  onChange,
}: {
  value: InboxListSegment;
  onChange: (segment: InboxListSegment) => void;
}) {
  const tabs: { id: InboxListSegment; label: string }[] = [
    { id: "active", label: "Active" },
    { id: "unread", label: "Unread" },
    { id: "archived", label: "Archived" },
  ];
  return (
    <div
      className="flex gap-0.5 rounded-xl bg-foreground/[0.04] p-0.5 max-md:gap-0.5"
      role="tablist"
      aria-label="Conversation folders"
      data-attr="inbox-list-segments"
    >
      {tabs.map((tab) => {
        const selected = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              if (tab.id !== value) onChange(tab.id);
            }}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors max-md:px-1.5 max-md:py-1 max-md:text-[11px] ${
              selected
                ? "bg-card text-foreground shadow-sm"
                : "text-muted hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** A single chat bubble — outbound right (accent), inbound left (neutral). */
export function InboxBubble({
  message,
  showAuthor = false,
  cluster = "single",
  showMeta = true,
  showChannel = false,
}: {
  message: InboxBubbleMessage;
  showAuthor?: boolean;
  cluster?: InboxBubbleClusterPosition;
  showMeta?: boolean;
  showChannel?: boolean;
}) {
  const outbound = message.direction === "outbound";
  const channel = message.channel ?? "email";
  const sending = message.delivery === "sending";
  const failed = message.delivery === "failed";
  const radius = outbound
    ? inboxBubbleClusterRadius(true, cluster)
    : inboxBubbleClusterRadius(false, cluster);

  const metaCaption = (() => {
    if (failed) return "Couldn't send";
    if (sending) return "Sending…";
    if (message.status) return message.status;
    return message.at;
  })();

  // `min-w-0` + `ml-auto`/`mr-auto` so long URLs cannot expand the row and
  // leave outbound (blue) bubbles sitting on the left.
  return (
    <div className="flex w-full min-w-0">
      <div
        className={`portal-inbox-bubble-wrap flex min-w-0 flex-col ${
          outbound ? "ml-auto items-end" : "mr-auto items-start"
        }`}
        data-inbox-bubble-align={outbound ? "end" : "start"}
      >
        {showAuthor && !outbound && cluster === "single" ? (
          <span className="mb-1 px-1 text-[11px] font-medium text-muted">{message.author}</span>
        ) : null}
        <div
          className={`portal-inbox-inbound-bubble w-full px-4 py-2.5 text-[15px] leading-relaxed sm:text-base ${radius} ${
            outbound
              ? "portal-inbox-outbound-bubble text-white"
              : cluster === "single"
                ? "border border-border bg-secondary text-foreground"
                : "border border-border bg-secondary text-foreground"
          } ${sending ? "opacity-80" : ""} ${failed ? "ring-2 ring-rose-400/50" : ""}`}
        >
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body || " "}</p>
          {message.attachments?.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.attachments.map((att) => (
                <InboxAttachmentChip key={att.url} att={att} outbound={outbound} />
              ))}
            </div>
          ) : null}
        </div>
        {showMeta && metaCaption ? (
          <span
            className={`mt-1 flex max-w-full items-center gap-1.5 px-1 text-[11px] text-muted ${
              outbound ? "flex-row-reverse" : ""
            }`}
          >
            {showChannel ? <InboxChannelTag channel={channel} /> : null}
            <span className={sending ? "italic" : failed ? "font-medium text-rose-600" : ""}>{metaCaption}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Clustered message list for an open thread. */
export function InboxMessageTimeline({
  messages,
  showAuthors = false,
}: {
  messages: InboxBubbleMessage[];
  showAuthors?: boolean;
}) {
  const items = buildInboxMessageTimeline(messages);
  return (
    <>
      {items.map((item) => (
        <div
          key={item.key}
          className={`w-full min-w-0 ${item.clusterStart ? "mt-3 first:mt-0" : "mt-0.5"}`}
          data-inbox-cluster-start={item.clusterStart ? "true" : "false"}
        >
          <InboxBubble
            message={item.message}
            showAuthor={showAuthors}
            cluster={item.cluster}
            showMeta={item.showMeta}
            showChannel={item.showChannel}
          />
        </div>
      ))}
    </>
  );
}

/** Thread-reply send channel — maps to the email/SMS boolean pair used by send handlers. */
export type InboxReplyChannelMode = "email" | "sms" | "both";

export function inboxReplyChannelsToMode(viaEmail: boolean, viaSms: boolean): InboxReplyChannelMode {
  if (viaEmail && viaSms) return "both";
  if (viaSms) return "sms";
  return "email";
}

export function inboxReplyModeToChannels(mode: InboxReplyChannelMode): { viaEmail: boolean; viaSms: boolean } {
  switch (mode) {
    case "both":
      return { viaEmail: true, viaSms: true };
    case "sms":
      return { viaEmail: false, viaSms: true };
    default:
      return { viaEmail: true, viaSms: false };
  }
}

const INBOX_REPLY_CHANNEL_COMPACT_TRIGGER_CLASS =
  "min-h-9 w-[min(7.5rem,28vw)] rounded-xl px-2 py-1 text-[11px] font-medium sm:text-xs";

/** Email / SMS channel multi-select for thread replies — compact control beside the reply field. */
export function InboxReplyChannelPicker({
  viaEmail,
  viaSms,
  onViaEmailChange,
  onViaSmsChange,
  emailAvailable = true,
  smsAvailable = true,
  onAddEmail,
  onAddPhone,
}: {
  viaEmail: boolean;
  viaSms: boolean;
  onViaEmailChange: (next: boolean) => void;
  onViaSmsChange: (next: boolean) => void;
  emailAvailable?: boolean;
  smsAvailable?: boolean;
  /** Offered when the thread has no address — opens the contact editor. */
  onAddEmail?: () => void;
  /** Offered when the thread has no number — opens the contact editor. */
  onAddPhone?: () => void;
}) {
  /**
   * Both channels are always listed. Hiding the one a thread cannot reach made
   * the menu look like the conversation only ever had one option, with nothing
   * saying what was missing or how to supply it.
   */
  const options = [
    {
      value: "email",
      label: emailAvailable ? "Email" : "Email (no address)",
      disabled: !emailAvailable,
    },
    {
      value: "sms",
      label: smsAvailable ? "SMS" : "SMS (not enabled)",
      disabled: !smsAvailable,
    },
  ];

  const selected = [
    ...(viaEmail && emailAvailable ? ["email"] : []),
    ...(viaSms && smsAvailable ? ["sms"] : []),
  ];
  const effectiveSelected =
    selected.length > 0 ? selected : emailAvailable ? ["email"] : smsAvailable ? ["sms"] : [];

  const selectionTriggerLabel =
    effectiveSelected.includes("email") && effectiveSelected.includes("sms")
      ? "Email & SMS"
      : effectiveSelected.includes("sms")
        ? "SMS"
        : effectiveSelected.includes("email")
          ? "Email"
          : undefined;

  const addAction = !emailAvailable && onAddEmail
    ? { label: "Add an email address", onClick: onAddEmail, dataAttr: "inbox-reply-add-email" }
    : !smsAvailable && onAddPhone
      ? { label: "Add a phone number", onClick: onAddPhone, dataAttr: "inbox-reply-add-phone" }
      : null;

  return (
    <div className="flex shrink-0 flex-col gap-0.5" data-attr="inbox-reply-channel-picker">
      <CheckboxMultiSelect
        label="Send via"
        labelClassName="px-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted"
        className={`w-auto shrink-0 ${INBOX_REPLY_CHANNEL_COMPACT_TRIGGER_CLASS}`}
        variant="pill"
        options={options}
        selected={effectiveSelected}
        selectionTriggerLabel={selectionTriggerLabel}
        emptyLabel="Choose channels…"
        onChange={(next) => {
          const enabled = next.filter(
            (value) => (value !== "sms" || smsAvailable) && (value !== "email" || emailAvailable),
          );
          if (enabled.length === 0) return;
          onViaEmailChange(enabled.includes("email"));
          onViaSmsChange(enabled.includes("sms"));
        }}
        menuFooter={
          addAction ? (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
              data-attr={addAction.dataAttr}
              onClick={addAction.onClick}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {addAction.label}
            </button>
          ) : undefined
        }
        dataAttr="inbox-reply-send-via"
      />
    </div>
  );
}

/** Shared thread-reply field + send affordance — keep identical across email/SMS/resident chat. */
export const PORTAL_INBOX_COMPOSER_INPUT_CLASS =
  "portal-inbox-composer-input max-h-28 min-h-9 flex-1 resize-none rounded-xl border border-border/80 bg-background px-3 py-2 text-sm leading-snug text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted/70 focus:border-primary/40 focus:ring-2 focus:ring-primary/15 disabled:opacity-60";

export const PORTAL_INBOX_COMPOSER_SEND_CLASS =
  "portal-inbox-composer-send mb-0.5 flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full bg-[var(--btn-primary)] text-primary-foreground shadow-[0_2px_8px_-4px_rgba(47,107,255,0.55)] transition-[filter,opacity] hover:brightness-110 disabled:opacity-40";

/** Persistent composer pinned to the bottom of an open thread. */
export function InboxComposer({
  value,
  onChange,
  onSubmit,
  sending = false,
  disabled = false,
  placeholder = "Write a message…",
  maxLength,
  hint,
  dataAttr,
  /** Inline channel picker rendered beside the reply field (preferred). */
  channelControl,
  /** @deprecated Prefer `channelControl` inline beside the reply field. */
  channelBar,
  attachments,
  onAttachmentsPick,
  onAttachmentRemove,
  maxAttachments = 4,
  autoSend = false,
  onAutoSendChange,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  sending?: boolean;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  hint?: ReactNode;
  dataAttr?: string;
  channelControl?: ReactNode;
  /** Channel picker or other controls above the reply field. */
  channelBar?: ReactNode;
  attachments?: { id: string; fileName: string; previewUrl: string; uploading?: boolean; error?: string; isImage?: boolean }[];
  onAttachmentsPick?: (files: FileList | null) => void;
  onAttachmentRemove?: (id: string) => void;
  maxAttachments?: number;
  autoSend?: boolean;
  onAutoSendChange?: (next: boolean) => void;
}) {
  const hasReadyAttachment = (attachments ?? []).some((a) => !a.uploading && !a.error);
  const canSend = !sending && !disabled && (value.trim().length > 0 || hasReadyAttachment);
  const resolvedChannel = channelControl ?? null;
  return (
    <div
      className="portal-inbox-composer shrink-0 border-t border-border/80 bg-card max-md:pb-[max(0.25rem,env(safe-area-inset-bottom,0px))] md:pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
    >
      {channelBar ?? null}
      <form
        className="px-2 py-1 max-md:py-0.5 md:px-2.5 md:py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSubmit();
        }}
      >
        {attachments?.length ? (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {attachments.map((att) => {
              const showImage = att.isImage !== false && Boolean(att.previewUrl) && !/\.pdf$/i.test(att.fileName);
              return (
                <div key={att.id} className="relative">
                  {showImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={att.previewUrl} alt={att.fileName} className="h-14 w-14 rounded-lg border border-border object-cover" />
                  ) : (
                    <div className="flex h-14 w-14 flex-col items-center justify-center rounded-lg border border-border bg-accent/30 px-1 text-center">
                      <FileText className="h-5 w-5 text-primary" aria-hidden />
                      <span className="mt-0.5 max-w-full truncate text-[8px] font-semibold uppercase text-muted">PDF</span>
                    </div>
                  )}
                  {att.uploading ? (
                    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 text-[10px] font-semibold text-white">…</span>
                  ) : null}
                  {att.error ? (
                    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-rose-600/80 px-1 text-center text-[9px] font-semibold text-white">Failed</span>
                  ) : null}
                  {onAttachmentRemove ? (
                    <button
                      type="button"
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background shadow"
                      aria-label={`Remove ${att.fileName}`}
                      onClick={() => onAttachmentRemove(att.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="portal-inbox-composer-row flex items-end gap-2">
          {onAttachmentsPick ? (
            <label className="mb-0.5 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/80 text-muted hover:bg-accent/40 hover:text-foreground">
              <Paperclip className="h-4 w-4" strokeWidth={2} />
              <input
                type="file"
                accept={INBOX_ATTACHMENT_ACCEPT}
                className="sr-only"
                multiple
                disabled={disabled || sending || (attachments?.length ?? 0) >= maxAttachments}
                onChange={(e) => {
                  onAttachmentsPick(e.target.files);
                  e.target.value = "";
                }}
                data-attr={dataAttr ? `${dataAttr}-attach` : undefined}
              />
            </label>
          ) : null}
          {resolvedChannel}
          <textarea
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={disabled}
            enterKeyHint="send"
            data-attr={dataAttr}
            className={PORTAL_INBOX_COMPOSER_INPUT_CLASS}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) onSubmit();
              }
            }}
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            data-attr={dataAttr ? `${dataAttr}-send` : undefined}
            className={PORTAL_INBOX_COMPOSER_SEND_CLASS}
          >
            {sending ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/40 border-t-current" />
            ) : (
              <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
            )}
          </button>
        </div>
        {hint || maxLength || onAutoSendChange ? (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              {onAutoSendChange ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-border text-primary"
                    checked={autoSend}
                    onChange={(e) => onAutoSendChange(e.target.checked)}
                    data-attr={dataAttr ? `${dataAttr}-auto-send` : undefined}
                  />
                  Auto-send
                </label>
              ) : null}
              <span className="text-[11px] text-muted">{hint}</span>
            </div>
            {maxLength ? (
              <span className="text-[11px] tabular-nums text-muted">
                {value.trim().length}/{maxLength}
              </span>
            ) : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}

/**
 * Gmail-style AI assist affordance above the reply composer. Wires to the existing
 * approval-first draft flow — the Draft button calls `onGenerate`; no new model path.
 */
export function InboxAiAssistBar({
  drafting = false,
  draft,
  error,
  approving = false,
  onApprove,
  onEdit,
  onDiscard,
  onGenerate,
}: {
  drafting?: boolean;
  draft?: string;
  error?: string;
  approving?: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onDiscard: () => void;
  onGenerate?: () => void;
}) {
  if (drafting) {
    return (
      <div className="portal-inbox-ai-assist-bar rounded-xl border border-primary/15 bg-primary/5 px-3 py-2.5" data-attr="inbox-ai-assist-drafting">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">AI reply assist</p>
        <div className="mt-2 flex items-center gap-2 text-[13px] font-medium text-muted">
          <Sparkles className="h-3.5 w-3.5 text-primary" strokeWidth={2.25} aria-hidden />
          <span className="animate-pulse">Drafting from this conversation…</span>
        </div>
      </div>
    );
  }

  if (draft) {
    return (
      <div className="overflow-hidden rounded-xl border border-primary/15 bg-primary/5">
        <AiDraftReplyCard
          draft={draft}
          approving={approving}
          onApprove={onApprove}
          onEdit={onEdit}
          onDiscard={onDiscard}
        />
      </div>
    );
  }

  if (!onGenerate) return null;

  return (
    <div className="portal-inbox-ai-assist-bar px-1 py-1" data-attr="inbox-ai-assist-bar">
      <Button
        type="button"
        variant="outline"
        className="h-8 min-h-0 w-full justify-start gap-2 rounded-lg border border-primary/15 bg-primary/[0.04] px-2.5 text-[12px] font-medium text-foreground/90 hover:bg-primary/[0.08]"
        onClick={onGenerate}
        data-attr="inbox-ai-draft-generate"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.25} aria-hidden />
        Ask PropLane Assistant
      </Button>
      {error ? <p className="mt-1.5 px-0.5 text-[11px] text-danger">Couldn’t draft a reply. Try again.</p> : null}
    </div>
  );
}

const INBOX_AI_DRAFT_ACTION_BTN =
  "h-7 min-h-0 gap-1 rounded-lg px-2.5 text-xs font-medium";

/**
 * Approval-first AI reply card, shown above the reply composer on an incoming
 * resident thread. PropLane AI drafts a reply; the manager stays in control and
 * must Approve & Send, Edit, or Discard. Nothing is sent to the resident until
 * the manager approves. Drafts live only on the manager's row, so residents
 * never see this card or the draft text.
 */
export function AiDraftReplyCard({
  drafting = false,
  draft,
  error,
  approving = false,
  onApprove,
  onEdit,
  onDiscard,
  onGenerate,
  channelControl,
  autoSend = false,
  onAutoSendChange,
  scheduledSection,
}: {
  /** True while a draft is being generated. */
  drafting?: boolean;
  /** The pending draft text (present once ready). */
  draft?: string;
  /** Optional error from the last generation attempt. */
  error?: string;
  /** True while Approve & Send is in flight. */
  approving?: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onDiscard: () => void;
  /** Manual (re)generate — shown when there is no draft yet (e.g. after Discard). */
  onGenerate?: () => void;
  /** Send-via picker shown on the draft card (Email / SMS). */
  channelControl?: ReactNode;
  /** When true, approving happens automatically once a draft is ready. */
  autoSend?: boolean;
  onAutoSendChange?: (next: boolean) => void;
  /** Scheduled messages for this thread — pinned above draft actions. */
  scheduledSection?: ReactNode;
}) {
  if (drafting) {
    return (
      <div
        className="portal-inbox-ai-draft shrink-0 border-t border-border bg-accent/30 px-3.5 py-3"
        data-attr="inbox-ai-draft-drafting"
      >
        <div className="flex items-center gap-2 text-[13px] font-medium text-muted">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10">
            <Sparkles className="h-3 w-3 text-primary" strokeWidth={2.25} />
          </span>
          <span className="animate-pulse">PropLane AI is drafting a reply…</span>
        </div>
        {onAutoSendChange ? (
          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border text-primary"
              checked={autoSend}
              onChange={(e) => onAutoSendChange(e.target.checked)}
              data-attr="inbox-ai-draft-auto-send"
            />
            Auto-send when draft is ready
          </label>
        ) : null}
      </div>
    );
  }

  if (!draft) {
    if (error) {
      return (
        <div className="portal-inbox-ai-draft shrink-0 border-t border-border bg-card px-3.5 py-2.5" data-attr="inbox-ai-draft-error">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-danger">Couldn’t draft a reply.</span>
            {onGenerate ? (
              <Button type="button" variant="outline" className={`${INBOX_AI_DRAFT_ACTION_BTN}`} onClick={onGenerate}>
                Try again
              </Button>
            ) : null}
          </div>
        </div>
      );
    }
    if (onGenerate) {
      return (
        <div className="portal-inbox-ai-draft shrink-0 border-t border-border bg-card px-3.5 py-2.5">
          <Button
            type="button"
            variant="outline"
            className={`${INBOX_AI_DRAFT_ACTION_BTN}`}
            onClick={onGenerate}
            data-attr="inbox-ai-draft-generate"
          >
            <Sparkles className="h-3 w-3 text-primary" strokeWidth={2.25} />
            Draft reply with PropLane AI
          </Button>
        </div>
      );
    }
    return null;
  }

  return (
    <div
      className="portal-inbox-ai-draft mx-2 shrink-0 border border-dashed border-primary/20 bg-primary/[0.04] px-3 py-2.5 md:mx-3"
      data-attr="inbox-ai-draft-card"
    >
      <div className="flex items-center gap-1.5">
        <span className="flex h-4 w-4 items-center justify-center rounded-md bg-primary/10">
          <Sparkles className="h-2.5 w-2.5 text-primary" strokeWidth={2.25} />
        </span>
        <span className="text-xs font-semibold text-foreground">PropLane AI</span>
        <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
          Draft
        </span>
      </div>
      <p className="portal-inbox-ai-draft-text mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-border/80 bg-card px-2.5 py-2 text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
        {draft}
      </p>
      {scheduledSection ? <div className="mt-2">{scheduledSection}</div> : null}
      <div className="mt-2 flex flex-wrap items-end gap-1.5">
        {channelControl}
        {onAutoSendChange ? (
          <label className="mb-0.5 flex cursor-pointer items-center gap-1.5 text-[11px] text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-border text-primary"
              checked={autoSend}
              onChange={(e) => onAutoSendChange(e.target.checked)}
              data-attr="inbox-ai-draft-auto-send"
            />
            Auto-send
          </label>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="primary"
          className={INBOX_AI_DRAFT_ACTION_BTN}
          onClick={onApprove}
          disabled={approving}
          data-attr="inbox-ai-draft-approve"
        >
          {approving ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <Check className="h-3 w-3" strokeWidth={2.5} />
          )}
          Approve &amp; Send
        </Button>
        <Button
          type="button"
          variant="outline"
          className={INBOX_AI_DRAFT_ACTION_BTN}
          onClick={onEdit}
          disabled={approving}
          data-attr="inbox-ai-draft-edit"
        >
          <Pencil className="h-3 w-3" strokeWidth={2.25} />
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={`${INBOX_AI_DRAFT_ACTION_BTN} text-muted hover:text-danger`}
          onClick={onDiscard}
          disabled={approving}
          data-attr="inbox-ai-draft-discard"
        >
          <X className="h-3 w-3" strokeWidth={2.25} />
          Discard
        </Button>
      </div>
    </div>
  );
}

export type InboxScheduledSaveEdit = {
  subject: string;
  body: string;
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
};

function ScheduledMessageActionFooter({
  showSendActions,
  editable,
  hasSaveEdit,
  busy,
  onCancelSend,
  onEdit,
  onSendNow,
}: {
  showSendActions: boolean;
  editable: boolean;
  hasSaveEdit: boolean;
  busy?: boolean;
  onCancelSend: () => void;
  onEdit: () => void;
  onSendNow: () => void;
}) {
  const hasFooter = (showSendActions && true) || (editable && hasSaveEdit);
  if (!hasFooter) return null;

  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      {showSendActions ? (
        <Button
          type="button"
          variant="ghost"
          className="h-8 min-h-0 px-3 text-[12px] text-muted hover:text-danger"
          onClick={onCancelSend}
          disabled={busy}
          data-attr="inbox-scheduled-cancel"
        >
          Cancel send
        </Button>
      ) : null}
      {editable && hasSaveEdit ? (
        <Button
          type="button"
          variant="ghost"
          className="h-8 min-h-0 gap-1.5 px-3 text-[12px]"
          onClick={onEdit}
          disabled={busy}
          data-attr="inbox-scheduled-edit"
        >
          <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
          Edit
        </Button>
      ) : null}
      {showSendActions ? (
        <Button
          type="button"
          variant="primary"
          className="h-8 min-h-0 rounded-full px-4 text-[12px]"
          onClick={onSendNow}
          disabled={busy}
          data-attr="inbox-scheduled-send-now"
        >
          Send now
        </Button>
      ) : null}
    </div>
  );
}

function enhanceInboxScheduledCardFooter(
  node: ReactNode,
  onFooter: (footer: ReactNode | null) => void,
): ReactNode {
  if (!isValidElement(node)) return node;
  if (node.type === InboxScheduledCard) {
    return cloneElement(node as React.ReactElement<InboxScheduledCardProps>, {
      pinActionsInModalFooter: true,
      onModalFooterChange: onFooter,
      presentation: "detail",
    });
  }
  const props = node.props as { children?: ReactNode };
  if (props.children == null) return node;
  const nextChildren = Children.map(props.children, (child) => enhanceInboxScheduledCardFooter(child, onFooter));
  return cloneElement(node, {}, nextChildren);
}

export type InboxScheduledCardProps = {
  sendLabel: string;
  subject: string;
  body: string;
  meta?: string;
  channel?: InboxChannel;
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
  source: "manual" | "automation";
  emailAvailable?: boolean;
  smsAvailable?: boolean;
  channelEditable?: boolean;
  editable: boolean;
  busy?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  presentation?: "compact" | "detail";
  onCancel: () => void;
  onSendNow: () => void;
  onSaveEdit?: (next: InboxScheduledSaveEdit) => void | Promise<void>;
  showSendActions?: boolean;
  pinActionsInModalFooter?: boolean;
  onModalFooterChange?: (footer: ReactNode | null) => void;
};

/** Full-screen scheduled-message popup — scrollable body, assistant, pinned footer actions. */
export function ScheduledMessageDetailModal({
  open,
  onClose,
  title = "Scheduled message",
  description,
  assistantContext = "Scheduled message",
  panelClassName,
  dataAttr,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: ReactNode;
  assistantContext?: string;
  panelClassName?: string;
  dataAttr?: string;
  children: ReactNode;
}) {
  const [footer, setFooter] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!open) setFooter(null);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      dense
      assistantContext={assistantContext}
      scrollableContent={false}
      panelClassName={cn("max-w-lg p-3 sm:p-4", MODAL_TALL_PANEL_CLASS, panelClassName)}
      dataAttr={dataAttr}
      footer={footer ? <ModalFooter className="w-full justify-end gap-2">{footer}</ModalFooter> : undefined}
    >
      <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
        {enhanceInboxScheduledCardFooter(children, setFooter)}
      </div>
    </Modal>
  );
}

/**
 * Inline scheduled message — compact chip in the thread (`compact`) or full body
 * when nested inside another modal (`detail`).
 */
export function InboxScheduledCard({
  sendLabel,
  subject,
  body,
  meta,
  channel = "email",
  deliverViaEmail,
  deliverViaSms,
  source: _source,
  emailAvailable = true,
  smsAvailable = false,
  channelEditable,
  editable,
  busy = false,
  expanded: _expanded = true,
  onToggleExpand: _onToggleExpand,
  presentation = "compact",
  onCancel,
  onSendNow,
  onSaveEdit,
  showSendActions = true,
  pinActionsInModalFooter = false,
  onModalFooterChange,
}: InboxScheduledCardProps) {
  const canEditChannels =
    channelEditable ??
    (editable && _source === "manual" && Boolean(onSaveEdit) && (emailAvailable || smsAvailable));

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);
  const [draftSendVia, setDraftSendVia] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const draftChannels = portalMessageChannelsFromSelection(draftSendVia);
  const draftChannelsOk =
    !canEditChannels || !editing || draftChannels.viaEmail || draftChannels.viaSms;

  const closeModal = () => {
    setModalOpen(false);
    setSaveError(null);
    setEditing(false);
  };

  const startEdit = () => {
    setDraftSubject(subject);
    setDraftBody(body);
    setDraftSendVia(
      defaultPortalMessageChannelSelection(
        emailAvailable,
        smsAvailable,
        deliverViaEmail !== false,
        deliverViaSms === true,
      ),
    );
    setSaveError(null);
    setEditing(true);
  };
  const cancelEdit = () => {
    setSaveError(null);
    setEditing(false);
  };
  const saveEdit = () => {
    if (!onSaveEdit || !draftBody.trim() || !draftChannelsOk) return;
    setSaving(true);
    setSaveError(null);
    const channels = portalMessageChannelsFromSelection(draftSendVia);
    void Promise.resolve(
      onSaveEdit({
        subject: draftSubject.trim(),
        body: draftBody.trim(),
        ...(canEditChannels
          ? { deliverViaEmail: channels.viaEmail, deliverViaSms: channels.viaSms }
          : {}),
      }),
    )
      .then(() => {
        setSaveError(null);
        setEditing(false);
        if (presentation === "compact") closeModal();
      })
      .catch((e: unknown) => {
        setSaveError(e instanceof Error && e.message ? e.message : "Could not save changes.");
      })
      .finally(() => setSaving(false));
  };

  const pinFooterActions = presentation === "compact" || pinActionsInModalFooter;

  const actionFooter = useMemo(() => {
    if (editing) return null;
    return (
      <ScheduledMessageActionFooter
        showSendActions={showSendActions}
        editable={editable}
        hasSaveEdit={Boolean(onSaveEdit)}
        busy={busy}
        onCancelSend={() => {
          onCancel();
          if (presentation === "compact") closeModal();
        }}
        onEdit={startEdit}
        onSendNow={() => {
          onSendNow();
          if (presentation === "compact") closeModal();
        }}
      />
    );
  }, [
    busy,
    editable,
    editing,
    onCancel,
    onSaveEdit,
    onSendNow,
    presentation,
    showSendActions,
  ]);

  useEffect(() => {
    if (!pinActionsInModalFooter || !onModalFooterChange) return;
    onModalFooterChange(actionFooter);
    return () => onModalFooterChange(null);
  }, [actionFooter, onModalFooterChange, pinActionsInModalFooter]);

  const detailBody = (
    <div
      className={
        presentation === "detail"
          ? "portal-inbox-scheduled-card text-left"
          : "portal-inbox-scheduled-card px-1 py-1 text-left"
      }
      data-attr="inbox-scheduled-card"
    >
      <div className="mb-2 flex flex-col items-start gap-1.5">
        <p
          className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted"
          data-attr="inbox-scheduled-meta"
        >
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={2.25} aria-hidden />
          <span>
            <span className="font-semibold text-foreground">Scheduled</span>
            <span> · sends {sendLabel}</span>
          </span>
        </p>
        <InboxScheduledChannelTags
          channel={channel}
          deliverViaEmail={deliverViaEmail}
          deliverViaSms={deliverViaSms}
        />
      </div>

      {editing ? (
        <div className="space-y-2 text-left">
          {canEditChannels ? (
            <PortalMessageSendViaField
              selected={draftSendVia}
              onChange={setDraftSendVia}
              emailAvailable={emailAvailable}
              smsAvailable={smsAvailable}
              dataAttr="inbox-scheduled-edit-send-via"
            />
          ) : null}
          <Input
            value={draftSubject}
            onChange={(e) => setDraftSubject(e.target.value)}
            placeholder="Subject"
            className="text-sm"
            data-attr="inbox-scheduled-edit-subject"
          />
          <Textarea
            rows={5}
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            placeholder="Message…"
            className="text-[15px] leading-relaxed sm:text-sm"
            data-attr="inbox-scheduled-edit-body"
          />
          {saveError ? (
            <p className="text-[12px] font-medium text-danger" role="alert" data-attr="inbox-scheduled-save-error">
              {saveError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-start gap-2">
            <Button
              type="button"
              variant="primary"
              className="h-8 min-h-0 px-3 text-[12px]"
              onClick={saveEdit}
              disabled={saving || !draftBody.trim() || !draftChannelsOk}
              data-attr="inbox-scheduled-save"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-8 min-h-0 px-3 text-[12px]"
              onClick={cancelEdit}
              disabled={saving}
              data-attr="inbox-scheduled-cancel-edit"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {subject ? <p className="text-sm font-semibold text-foreground">{subject}</p> : null}
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">
            {body || " "}
          </p>
          {meta ? <p className="mt-1 text-[11px] text-muted">{meta}</p> : null}
          {!pinFooterActions ? (
            <div className="mt-2.5 flex flex-wrap items-center justify-start gap-2">
              {showSendActions ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 min-h-0 px-3 text-[12px] text-muted hover:text-danger"
                    onClick={() => {
                      onCancel();
                    }}
                    disabled={busy}
                    data-attr="inbox-scheduled-cancel"
                  >
                    Cancel send
                  </Button>
                  {editable && onSaveEdit ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 min-h-0 gap-1.5 px-3 text-[12px]"
                      onClick={startEdit}
                      disabled={busy}
                      data-attr="inbox-scheduled-edit"
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                      Edit
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="primary"
                    className="h-8 min-h-0 rounded-full px-4 text-[12px]"
                    onClick={() => {
                      onSendNow();
                    }}
                    disabled={busy}
                    data-attr="inbox-scheduled-send-now"
                  >
                    Send now
                  </Button>
                </>
              ) : editable && onSaveEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-8 min-h-0 gap-1.5 px-3 text-[12px]"
                  onClick={startEdit}
                  disabled={busy}
                  data-attr="inbox-scheduled-edit"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                  Edit
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  if (presentation === "detail") {
    return detailBody;
  }

  const preview = subject.trim() || body.trim().replace(/\s+/g, " ").slice(0, 72) || "Scheduled message";

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="portal-inbox-scheduled-card flex w-full items-center justify-start gap-2 rounded-lg border border-dashed border-border/80 bg-accent/15 px-3 py-2 text-left transition hover:border-border hover:bg-accent/25"
        aria-haspopup="dialog"
        data-attr="inbox-scheduled-toggle"
      >
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={2.25} aria-hidden />
        <span className="min-w-0 truncate text-[12px] text-foreground">
          <span className="font-semibold">Scheduled</span>
          <span className="text-muted"> · sends {sendLabel}</span>
          <span className="text-muted"> · {preview}</span>
        </span>
      </button>
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title="Scheduled message"
        dense
        assistantContext="Scheduled message"
        scrollableContent={false}
        panelClassName={cn("max-w-lg p-3 sm:p-4", MODAL_TALL_PANEL_CLASS)}
        dataAttr="inbox-scheduled-detail-modal"
        footer={
          actionFooter ? (
            <ModalFooter className="w-full justify-end gap-2">{actionFooter}</ModalFooter>
          ) : undefined
        }
      >
        <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>{detailBody}</div>
      </Modal>
    </>
  );
}

/**
 * One scheduled-message preview row (compose modal + scheduled list popup).
 */
export function InboxScheduledSubjectRow({
  subject,
  sendLabel,
  onClick,
}: {
  subject: string;
  sendLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full flex-col items-start rounded-xl border border-border bg-accent/15 px-3 py-2.5 text-left transition hover:bg-accent/25"
      data-attr="inbox-scheduled-subject-row"
      onClick={onClick}
    >
      <span className="line-clamp-2 text-sm font-semibold text-foreground">
        {subject.trim() || "Scheduled message"}
      </span>
      <span className="mt-0.5 text-xs text-muted">Sends {sendLabel}</span>
    </button>
  );
}

/**
 * Stacks scheduled-message rows at the tail of a thread — summary chip above the
 * assistant opens a subject-row list; each row opens the full card in detail.
 */
export function InboxScheduledThreadList({
  count,
  nextSendLabel,
  children,
  footerAction,
}: {
  count: number;
  nextSendLabel?: string;
  /** @deprecated Collapse removed — summary chip always used when count >= 1. */
  defaultCollapsed?: boolean;
  children: ReactNode;
  /** Optional action below the subject list (e.g. Send message in compose). */
  footerAction?: ReactNode;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailIdx, setDetailIdx] = useState(0);

  const childArray = Children.toArray(children).filter(isValidElement);
  const detailChildren = childArray.map((child) =>
    cloneElement(child as React.ReactElement<{ presentation?: "compact" | "detail" }>, {
      presentation: "detail",
    }),
  );

  if (count <= 0) return null;

  const summary = count === 1 ? "1 scheduled message" : `${count} scheduled messages`;
  const when = nextSendLabel ? ` · next sends ${nextSendLabel}` : "";

  const openDetail = (index: number) => {
    setDetailIdx(index);
    setListOpen(false);
    setDetailOpen(true);
  };

  return (
    <>
      <div className="pt-1" data-attr="inbox-scheduled-thread-list">
        <button
          type="button"
          onClick={() => setListOpen(true)}
          className="portal-inbox-scheduled-card flex w-full items-center justify-start gap-2 rounded-lg border border-dashed border-border/80 bg-accent/15 px-3 py-2 text-left transition hover:border-border hover:bg-accent/25"
          aria-haspopup="dialog"
          data-attr="inbox-scheduled-list-toggle"
        >
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={2.25} aria-hidden />
          <span className="min-w-0 truncate text-[12px] text-foreground">
            <span className="font-semibold text-foreground">{summary}</span>
            <span className="text-muted">{when}</span>
          </span>
        </button>
      </div>
      <Modal
        open={listOpen}
        onClose={() => setListOpen(false)}
        title="Scheduled messages"
        dense
        assistantContext="Scheduled messages"
        scrollableContent={false}
        panelClassName={cn("max-w-lg p-3 sm:p-4", MODAL_TALL_PANEL_CLASS)}
        dataAttr="inbox-scheduled-list-modal"
        footer={
          footerAction ? (
            <ModalFooter>{footerAction}</ModalFooter>
          ) : undefined
        }
      >
        <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
          <p className="text-xs font-semibold text-muted">Scheduled messages</p>
          <ul className="mt-2 space-y-1.5">
            {childArray.map((child, index) => {
              const props = (child as React.ReactElement<{ subject?: string; sendLabel?: string }>).props;
              return (
                <li key={child.key ?? index}>
                  <InboxScheduledSubjectRow
                    subject={props.subject ?? ""}
                    sendLabel={props.sendLabel ?? ""}
                    onClick={() => openDetail(index)}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      </Modal>
      <ScheduledMessageDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        dataAttr="inbox-scheduled-detail-modal"
      >
        {detailChildren[detailIdx] ?? null}
      </ScheduledMessageDetailModal>
    </>
  );
}

/** Right-pane placeholder shown when no conversation is selected. */
export function InboxThreadEmpty({
  title = "Select a conversation",
  hint = "Choose a message on the left to read it and reply here.",
}: {
  title?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-accent/40 text-muted">
        <PortalEmptyIcon kind="inbox" className="h-6 w-6" />
      </div>
      <p className="mt-4 text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-muted">{hint}</p>
    </div>
  );
}

/** Right pane: thread header, scrolling bubble history, and a composer slot. */
export function InboxThreadView({
  title,
  subtitle,
  avatarName,
  messages,
  showAuthors = false,
  onBack,
  hideIdentityHeader = false,
  headerActions,
  composer,
  afterMessages,
  emptyLabel = "No messages yet.",
  threadKey,
  /** `pane` scrolls inside the thread body; `page` lets the portal main scroller handle it (embedded resident chat). */
  scrollMode = "pane",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Shows initials avatar beside the thread title (CRM-style header). */
  avatarName?: string;
  messages: InboxBubbleMessage[];
  /** Show the author name above inbound bubbles (multi-party threads). */
  showAuthors?: boolean;
  /** Mobile-only back affordance returning to the list. */
  onBack?: () => void;
  /** Hide avatar, title, and subtitle (e.g. resident profile Communication tab). */
  hideIdentityHeader?: boolean;
  headerActions?: ReactNode;
  /** Pass an <InboxComposer/>; omit for a read-only thread (e.g. Trash). */
  composer?: ReactNode;
  /**
   * Rendered inside the scroll body AFTER the message bubbles — used for inline
   * "Scheduled · sends <when>" cards so a person's future/pending communication
   * sits at the tail of their own conversation timeline.
   */
  afterMessages?: ReactNode;
  emptyLabel?: string;
  /**
   * Identity of the open conversation. When it changes we jump to the latest
   * message instantly (opening a thread should land at the bottom). A new
   * message WITHIN the same thread only auto-scrolls if the reader is already
   * near the bottom — so scrolling up through history is never yanked back.
   */
  threadKey?: string;
  scrollMode?: "pane" | "page";
}) {
  const pageScroll = scrollMode === "page";
  const showHeader = Boolean(onBack || !hideIdentityHeader || headerActions);
  const { scrollRef, endRef, handleScroll: handleThreadScroll } = useInboxThreadScroll(
    threadKey,
    messages.length,
  );

  return (
    <div className={pageScroll ? "flex flex-col" : "flex h-full min-h-0 flex-1 flex-col overflow-hidden"}>
      {showHeader ? (
      <header
        className="portal-inbox-thread-header sticky top-0 z-10 flex shrink-0 items-center gap-0.5 border-b border-border bg-card px-1.5 py-1 max-md:py-1 md:gap-1 md:px-2 md:py-2 md:[padding-top:max(0.375rem,env(safe-area-inset-top,0px))] max-md:[padding-top:max(0.5rem,env(safe-area-inset-top,0px))]"
      >
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="flex min-h-8 shrink-0 items-center gap-0.5 rounded-lg px-1 text-sm font-medium text-primary lg:hidden"
            aria-label="Back to conversations"
            data-attr="inbox-thread-back"
          >
            <ChevronLeft className="h-5 w-5" strokeWidth={2.25} />
            <span className="sr-only">Inbox</span>
          </button>
        ) : null}
        {!hideIdentityHeader ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-0.5 md:gap-2.5 md:px-1">
            {avatarName ? (
              <InboxAvatar name={avatarName} className="h-8 w-8 text-[10px] md:h-9 md:w-9 md:text-[11px]" />
            ) : null}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{title}</p>
              {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {headerActions ? <div className="flex shrink-0 items-center gap-1.5">{headerActions}</div> : null}
      </header>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={pageScroll ? undefined : handleThreadScroll}
        className={
          pageScroll
            ? "portal-inbox-thread-body flex flex-col bg-background/40 px-2 py-2 md:px-3 md:py-3"
            : "portal-inbox-thread-body flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-background/40 px-2 py-2 [-webkit-overflow-scrolling:touch] md:px-3 md:py-3"
        }
      >
        {messages.length === 0 && !afterMessages ? (
          <div className={`flex flex-col items-center justify-center py-4 ${pageScroll ? "" : "min-h-full flex-1"}`}>
            <PortalInboxEmptyState title={emptyLabel} />
          </div>
        ) : (
          <div
            className={`flex w-full min-h-min flex-col md:gap-0 ${pageScroll ? "" : "flex-grow justify-end"}`}
          >
            <InboxMessageTimeline messages={messages} showAuthors={showAuthors} />
            {afterMessages}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {composer}
    </div>
  );
}

/** Responsive two-pane shell: list + thread on desktop; list-then-thread on mobile.
 *
 * The shell fills the space between its top edge and the bottom of the viewport
 * (measured at mount / resize) so the composer stays pinned and visible without
 * a fixed height that would overflow one page header and under-fill another —
 * important because this is shared across portals whose header stacks differ. */
export function InboxTwoPane({
  list,
  thread,
  threadOpen,
  className = "",
  /** When true, hide the list pane and show only the thread (e.g. single-resident chat). */
  listHidden = false,
  /**
   * `section` caps height for embedded profile panels; `viewport` fills available
   * screen space (full inbox pages); `flow` grows with content (resident profile chat).
   */
  heightMode = "viewport",
  /** Tighter viewport fill on phones (Communication page with heavy filter chrome). */
  mobileCompact = false,
  /** Mobile thread reading: stretch to the bottom nav with no dead space below the composer. */
  fillViewport = false,
  /** Fill a flex parent (Communication page) instead of a capped pixel height. */
  fillParent = false,
}: {
  list: ReactNode;
  thread: ReactNode;
  /** On narrow widths, show the thread pane (and hide the list) when true. */
  threadOpen: boolean;
  className?: string;
  listHidden?: boolean;
  heightMode?: "viewport" | "section" | "flow";
  mobileCompact?: boolean;
  fillViewport?: boolean;
  fillParent?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  useEffect(() => {
    if (heightMode === "section" || heightMode === "flow") return;
    const measure = () => {
      const el = rootRef.current;
      if (!el || typeof window === "undefined") return;
      const top = el.getBoundingClientRect().top;
      // The mobile portal renders a fixed bottom nav that overlays the viewport;
      // reserve its height so the composer never hides behind it. It is
      // display:none on desktop, so this contributes 0 there.
      const bottomNav = document.querySelector(".portal-native-bottom-nav");
      const navHeight = bottomNav ? bottomNav.getBoundingClientRect().height : 0;
      const narrow = window.innerWidth < 768;
      const compact = mobileCompact && narrow;
      const flushThread = fillViewport && narrow;
      const edgePad = flushThread ? 0 : compact ? 8 : 16;
      const avail = window.innerHeight - top - navHeight - edgePad;
      if (flushThread) {
        setMeasuredHeight(Math.max(240, avail));
        return;
      }
      const minH = compact ? 280 : narrow ? 360 : 440;
      // Communication split view: use full remaining viewport (no cap) so both panes can scroll.
      const maxH = fillParent ? avail : compact ? 600 : narrow ? 680 : 760;
      setMeasuredHeight(Math.max(minH, Math.min(maxH, avail)));
    };
    measure();
    // Re-measure after layout settles — the fixed bottom nav (and final card
    // position) may not have their size on the first synchronous pass.
    const raf = requestAnimationFrame(measure);
    const timer = window.setTimeout(measure, 300);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, [fillParent, fillViewport, heightMode, mobileCompact]);

  const sectionHeight = "min(20rem, 38dvh)";
  const fallback = isNativeRuntimeSync() ? "min(78dvh, calc(100dvh - 12rem))" : "min(68vh, 640px)";
  const flexFillMobile = fillViewport && threadOpen;
  const flexFillLayout = fillParent && heightMode === "viewport";
  const flowLayout = heightMode === "flow";
  const height =
    flowLayout || flexFillMobile
      ? undefined
      : heightMode === "section"
        ? sectionHeight
        : measuredHeight
          ? `${measuredHeight}px`
          : fallback;

  return (
    <div
      ref={rootRef}
      className={`portal-inbox-two-pane rounded-2xl border border-border bg-card shadow-[var(--shadow-card)] max-md:rounded-xl max-md:border-x-0 max-md:shadow-none ${flowLayout ? "overflow-visible" : "overflow-hidden"} ${flexFillMobile || flexFillLayout ? "flex min-h-0 flex-1 flex-col" : ""} ${className}`}
      style={height ? { height } : undefined}
      data-attr="portal-inbox-two-pane"
      data-fill-viewport={flexFillMobile ? "true" : undefined}
      data-height-mode={flowLayout ? "flow" : undefined}
    >
      <div
        className={`grid min-h-0 flex-1 ${flowLayout ? "" : "h-full grid-rows-[minmax(0,1fr)]"} ${listHidden ? "grid-cols-1" : "lg:grid-cols-[minmax(240px,28%)_1fr]"}`}
      >
        <section
          className={`portal-inbox-list-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-border lg:border-r ${
            listHidden ? "hidden" : threadOpen ? "hidden lg:flex" : "flex"
          }`}
        >
          {list}
        </section>
        <section
          className={`portal-inbox-thread-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${listHidden || threadOpen ? "flex" : "hidden lg:flex"}`}
        >
          {thread}
        </section>
      </div>
    </div>
  );
}
