"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter, MODAL_INSET_BOX_CLASS } from "@/components/ui/modal";
import {
  defaultPortalMessageChannelSelection,
  PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageRecipientLockedField,
  PortalMessageScheduleFields,
  PortalMessageSendViaDropdown,
  PortalMessageSubjectField,
  portalMessageChannelsFromSelection,
  portalMessageRecipientDisplay,
  portalMessageSendViaFooterNote,
  PORTAL_MESSAGE_DEFAULT_FOOTER_NOTE,
  PORTAL_MESSAGE_SEND_VIA_OPTIONS,
  portalMessageFieldLabel,
} from "@/components/portal/portal-message-compose-fields";
import type { NotificationDeliveryChannels } from "@/components/portal/portal-notification-preview-modal";
import { cn } from "@/lib/utils";

export type BulkMessageCarouselItem = {
  id: string;
  /** Context line above recipient (applicant name, tour time, charge label, …). */
  label: string;
  recipient: string;
  recipientPhone?: string;
  subject: string;
  body: string;
  emailAvailable?: boolean;
  smsAvailable?: boolean;
};

export type BulkMessageCarouselDraft = {
  subject: string;
  body: string;
};

function BulkCarouselArrow({
  direction,
  disabled,
  onClick,
  ariaLabel,
}: {
  direction: "left" | "right";
  disabled: boolean;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition hover:border-primary/35 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 [html[data-theme=dark]_&]:portal-outline-control"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
        {direction === "left" ? (
          <path
            d="M14 6l-6 6 6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M10 6l6 6-6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  );
}

export function PortalBulkMessageCarouselModal({
  open,
  title,
  intro,
  items,
  confirmLabel,
  confirmLabelAll,
  confirmLabelSingle,
  confirmLabelWithoutMessage,
  confirmBusy = false,
  confirmBusyLabel = "Working…",
  showSkipMessage = true,
  skipMessageLabel = "Don't send message",
  showChannelPicker = true,
  defaultViaEmail = true,
  defaultViaSms = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  intro?: string;
  items: BulkMessageCarouselItem[];
  confirmLabel: string;
  /** Override for multi-item primary CTA; defaults to `${confirmLabel} (${count})`. */
  confirmLabelAll?: string;
  /** Secondary CTA for the visible item only; hidden when count is 1. */
  confirmLabelSingle?: string;
  confirmLabelWithoutMessage?: string;
  confirmBusy?: boolean;
  confirmBusyLabel?: string;
  showSkipMessage?: boolean;
  skipMessageLabel?: string;
  showChannelPicker?: boolean;
  defaultViaEmail?: boolean;
  defaultViaSms?: boolean;
  onClose: () => void;
  onConfirm: (
    scope: "all" | "single",
    options: {
      skipMessage: boolean;
      channels: NotificationDeliveryChannels;
      drafts: Record<string, BulkMessageCarouselDraft>;
      singleId?: string;
    },
  ) => void;
}) {
  const count = items.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const [skipMessage, setSkipMessage] = useState(false);
  const [sendVia, setSendVia] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, BulkMessageCarouselDraft>>({});
  const [includedIds, setIncludedIds] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const activeItem = items[activeIndex] ?? items[0];
  const emailAvailable = activeItem?.emailAvailable ?? Boolean(activeItem?.recipient?.includes("@"));
  const smsAvailable = activeItem?.smsAvailable ?? Boolean(activeItem?.recipientPhone?.trim());

  const sendViaOptions = useMemo(
    () =>
      PORTAL_MESSAGE_SEND_VIA_OPTIONS.filter((option) => {
        if (option.value === "email") return emailAvailable;
        if (option.value === "sms") return smsAvailable;
        return true;
      }),
    [emailAvailable, smsAvailable],
  );

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setActiveIndex(0);
      setSkipMessage(false);
      setSendVia(
        defaultPortalMessageChannelSelection(emailAvailable, smsAvailable, defaultViaEmail, defaultViaSms),
      );
      const next: Record<string, BulkMessageCarouselDraft> = {};
      for (const item of items) {
        next[item.id] = { subject: item.subject, body: item.body };
      }
      setDrafts(next);
      setIncludedIds(new Set(items.map((item) => item.id)));
    });
  }, [open, items, defaultViaEmail, defaultViaSms, emailAvailable, smsAvailable]);

  const includedCount = includedIds.size;
  const allIncluded = count > 0 && includedCount === count;
  const someIncluded = includedCount > 0 && includedCount < count;

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    el.indeterminate = someIncluded;
  }, [someIncluded]);

  const activeDraft = activeItem ? drafts[activeItem.id] : undefined;

  const patchActiveDraft = useCallback(
    (patch: Partial<BulkMessageCarouselDraft>) => {
      if (!activeItem) return;
      setDrafts((prev) => ({
        ...prev,
        [activeItem.id]: {
          subject: prev[activeItem.id]?.subject ?? "",
          body: prev[activeItem.id]?.body ?? "",
          ...patch,
        },
      }));
    },
    [activeItem],
  );

  const scrollToIndex = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, count - 1));
    setActiveIndex(clamped);
    const el = scrollRef.current;
    if (!el) return;
    const child = el.children[clamped] as HTMLElement | undefined;
    child?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [count]);

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);
  const channelsOk =
    !showChannelPicker ||
    skipMessage ||
    sendVia.some((value) => sendViaOptions.some((option) => option.value === value));

  const messageReady =
    skipMessage ||
    (activeDraft?.subject.trim().length ?? 0) > 0 &&
      (activeDraft?.body.trim().length ?? 0) > 0;

  const includedItems = useMemo(
    () => items.filter((item) => includedIds.has(item.id)),
    [items, includedIds],
  );

  const allDraftsReady =
    skipMessage ||
    includedItems.every((item) => {
      const d = drafts[item.id];
      return Boolean(d?.subject.trim() && d?.body.trim());
    });

  const toRecipientDisplay = activeItem
    ? portalMessageRecipientDisplay({
        email: activeItem.recipient,
        phone: activeItem.recipientPhone,
        viaEmail: showChannelPicker && !skipMessage ? viaEmail : Boolean(activeItem.recipient.trim()),
        viaSms: showChannelPicker && !skipMessage ? viaSms : Boolean(activeItem.recipientPhone?.trim()),
      })
    : "—";

  const effectiveAllLabel = skipMessage
    ? (confirmLabelWithoutMessage ?? confirmLabel)
    : (confirmLabelAll ??
      (includedCount === count
        ? count === 1
          ? confirmLabel
          : `${confirmLabel} (${count})`
        : `${confirmLabel} (${includedCount})`));

  const effectiveSingleLabel = skipMessage
    ? (confirmLabelWithoutMessage ?? confirmLabel)
    : (confirmLabelSingle ?? confirmLabel);

  const includedDrafts = useMemo(() => {
    const next: Record<string, BulkMessageCarouselDraft> = {};
    for (const item of includedItems) {
      const draft = drafts[item.id];
      if (draft) next[item.id] = draft;
    }
    return next;
  }, [drafts, includedItems]);

  const footer = (
    <ModalFooter className="w-full justify-between gap-2">
      {count > 1 ? (
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          data-attr="portal-bulk-carousel-confirm-one"
          disabled={confirmBusy || !channelsOk || !messageReady || !activeItem}
          onClick={() =>
            onConfirm("single", {
              skipMessage,
              channels: portalMessageChannelsFromSelection(sendVia),
              drafts,
              singleId: activeItem?.id,
            })
          }
        >
          {confirmBusy ? confirmBusyLabel : effectiveSingleLabel}
        </Button>
      ) : (
        <span aria-hidden className="shrink-0" />
      )}
      <Button
        type="button"
        variant="primary"
        className="rounded-full"
        data-attr="portal-bulk-carousel-confirm-all"
        disabled={confirmBusy || !channelsOk || !allDraftsReady || includedCount === 0}
        onClick={() =>
          onConfirm("all", {
            skipMessage,
            channels: portalMessageChannelsFromSelection(sendVia),
            drafts: includedDrafts,
          })
        }
      >
        {confirmBusy ? confirmBusyLabel : effectiveAllLabel}
      </Button>
    </ModalFooter>
  );

  if (!open || count === 0) return null;

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      dense
      footer={footer}
      panelClassName={PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS}
    >
      <PortalMessageComposeModalBody>
        {intro ? <p className="text-sm leading-snug text-muted">{intro}</p> : null}

        {count > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allIncluded}
              onChange={(e) => {
                if (e.target.checked) {
                  setIncludedIds(new Set(items.map((item) => item.id)));
                } else {
                  setIncludedIds(new Set());
                }
              }}
              data-attr="portal-bulk-carousel-select-all"
              className="h-4 w-4 rounded border-border text-primary"
            />
            <span className="text-muted">Send to all ({count})</span>
          </label>
        ) : null}

        {count > 1 ? (
          <div className="flex items-center justify-between gap-2">
            <BulkCarouselArrow
              direction="left"
              ariaLabel="Previous message"
              disabled={activeIndex <= 0}
              onClick={() => scrollToIndex(activeIndex - 1)}
            />
            <p className="text-center text-xs font-medium tabular-nums text-muted">
              {activeIndex + 1} of {count}
            </p>
            <BulkCarouselArrow
              direction="right"
              ariaLabel="Next message"
              disabled={activeIndex >= count - 1}
              onClick={() => scrollToIndex(activeIndex + 1)}
            />
          </div>
        ) : null}

        {count > 1 ? (
          <div
            ref={scrollRef}
            className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain scroll-smooth pb-2 [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/80"
            onScroll={() => {
              const el = scrollRef.current;
              if (!el || el.children.length === 0) return;
              const mid = el.scrollLeft + el.clientWidth / 2;
              let best = 0;
              let bestDist = Infinity;
              for (let i = 0; i < el.children.length; i++) {
                const child = el.children[i] as HTMLElement;
                const center = child.offsetLeft + child.offsetWidth / 2;
                const dist = Math.abs(center - mid);
                if (dist < bestDist) {
                  bestDist = dist;
                  best = i;
                }
              }
              setActiveIndex(best);
            }}
          >
            {items.map((item, index) => (
              <div
                key={item.id}
                className={cn(
                  "flex min-w-[85%] shrink-0 snap-center items-start gap-2 rounded-xl border px-3 py-2 transition-colors sm:min-w-[70%]",
                  index === activeIndex
                    ? "border-primary/40 bg-primary/[0.06]"
                    : "border-border bg-accent/10",
                  !includedIds.has(item.id) && "opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  checked={includedIds.has(item.id)}
                  onChange={(e) => {
                    setIncludedIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    });
                  }}
                  data-attr={`portal-bulk-carousel-include-${item.id}`}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary"
                  aria-label={`Include ${item.label}`}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => scrollToIndex(index)}
                >
                  <p className="truncate text-xs font-semibold text-foreground">{item.label}</p>
                  <p className="mt-0.5 truncate text-[11px] text-muted">{item.recipient}</p>
                </button>
              </div>
            ))}
          </div>
        ) : activeItem ? (
          <p className="text-xs font-semibold text-foreground">{activeItem.label}</p>
        ) : null}

        <PortalMessageRecipientLockedField recipient={toRecipientDisplay || "—"} dataAttr="portal-bulk-carousel-recipient" />

        <div
          className={
            showChannelPicker && !skipMessage ? PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS : undefined
          }
        >
          <PortalMessageSubjectField
            value={activeDraft?.subject ?? ""}
            onChange={(value) => patchActiveDraft({ subject: value })}
            disabled={skipMessage}
            dataAttr="portal-bulk-carousel-subject"
          />
          {showChannelPicker && !skipMessage ? (
            <PortalMessageSendViaDropdown
              selected={sendVia}
              onChange={setSendVia}
              emailAvailable={emailAvailable}
              smsAvailable={smsAvailable}
              footerNote={portalMessageSendViaFooterNote(smsAvailable)}
              dataAttr="portal-bulk-carousel-send-via"
            />
          ) : null}
        </div>

        <PortalMessageBodyField
          value={activeDraft?.body ?? ""}
          onChange={(value) => patchActiveDraft({ body: value })}
          disabled={skipMessage}
          placeholder="Write your message…"
          minHeightClass="min-h-[7rem]"
          dataAttr="portal-bulk-carousel-body"
        />

        {showSkipMessage ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={skipMessage}
              onChange={(e) => setSkipMessage(e.target.checked)}
              data-attr="portal-bulk-carousel-skip-message"
              className="mt-0.5 h-4 w-4 rounded border-border text-primary"
            />
            <span className="text-muted">{skipMessageLabel}</span>
          </label>
        ) : null}

        {count > 1 && !skipMessage ? (
          <p className="text-xs text-muted">
            Scroll left or right to review each message. Uncheck any guest to exclude them from the bulk send.
          </p>
        ) : null}
      </PortalMessageComposeModalBody>
    </Modal>
  );
}

/** Read-only stacked preview with horizontal card picker — uses compose field chrome. */
export function PortalBulkMessageReadonlyCarouselModal({
  open,
  title,
  intro,
  items,
  confirmLabel,
  confirmBusy = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  intro?: string;
  items: BulkMessageCarouselItem[];
  confirmLabel: string;
  confirmBusy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const count = items.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => setActiveIndex(0));
  }, [open, items]);

  const scrollToIndex = (index: number) => {
    const clamped = Math.max(0, Math.min(index, count - 1));
    setActiveIndex(clamped);
    const el = scrollRef.current;
    if (!el) return;
    const child = el.children[clamped] as HTMLElement | undefined;
    child?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };

  const activeItem = items[activeIndex] ?? items[0];

  const footer = (
    <ModalFooter>
      <Button
        type="button"
        variant="primary"
        className="rounded-full"
        data-attr="portal-bulk-readonly-carousel-confirm"
        disabled={confirmBusy || count === 0}
        onClick={onConfirm}
      >
        {confirmBusy ? "Sending…" : confirmLabel}
      </Button>
    </ModalFooter>
  );

  if (!open || count === 0) return null;

  return (
    <Modal open title={title} onClose={onClose} dense footer={footer} panelClassName={PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS}>
      <PortalMessageComposeModalBody>
        {intro ? <p className="text-sm leading-snug text-muted">{intro}</p> : null}
        {count > 1 ? (
          <div className="flex items-center justify-between gap-2">
            <BulkCarouselArrow
              direction="left"
              ariaLabel="Previous reminder"
              disabled={activeIndex <= 0}
              onClick={() => scrollToIndex(activeIndex - 1)}
            />
            <p className="text-center text-xs font-medium tabular-nums text-muted">
              {activeIndex + 1} of {count}
            </p>
            <BulkCarouselArrow
              direction="right"
              ariaLabel="Next reminder"
              disabled={activeIndex >= count - 1}
              onClick={() => scrollToIndex(activeIndex + 1)}
            />
          </div>
        ) : null}
        {count > 1 ? (
          <div
            ref={scrollRef}
            className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 [scrollbar-width:thin]"
            onScroll={() => {
              const el = scrollRef.current;
              if (!el) return;
              const mid = el.scrollLeft + el.clientWidth / 2;
              let best = 0;
              let bestDist = Infinity;
              for (let i = 0; i < el.children.length; i++) {
                const child = el.children[i] as HTMLElement;
                const center = child.offsetLeft + child.offsetWidth / 2;
                const dist = Math.abs(center - mid);
                if (dist < bestDist) {
                  bestDist = dist;
                  best = i;
                }
              }
              setActiveIndex(best);
            }}
          >
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "min-w-[85%] shrink-0 snap-center rounded-xl border px-3 py-2 text-left sm:min-w-[70%]",
                  index === activeIndex ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-accent/10",
                )}
                onClick={() => scrollToIndex(index)}
              >
                <p className="truncate text-xs font-semibold text-foreground">{item.label}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted">{item.recipient}</p>
              </button>
            ))}
          </div>
        ) : activeItem ? (
          <p className="text-xs font-semibold text-foreground">{activeItem.label}</p>
        ) : null}
        {activeItem ? (
          <>
            <PortalMessageRecipientLockedField recipient={activeItem.recipient} dataAttr="portal-bulk-readonly-recipient" />
            <PortalMessageSubjectField value={activeItem.subject} readOnly dataAttr="portal-bulk-readonly-subject" />
            <PortalMessageBodyField
              value={activeItem.body}
              readOnly
              minHeightClass="min-h-[7rem]"
              dataAttr="portal-bulk-readonly-body"
            />
          </>
        ) : null}
      </PortalMessageComposeModalBody>
    </Modal>
  );
}
