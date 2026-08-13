"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter, MODAL_INSET_BOX_CLASS, MODAL_WARNING_BOX_CLASS } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  defaultPortalMessageChannelSelection,
  defaultPortalMessageScheduleAt,
  PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageRecipientReadonly,
  PortalMessageScheduleFields,
  PortalMessageSendViaDropdown,
  PortalMessageSubjectField,
  portalMessageChannelsFromSelection,
  portalMessageRecipientDisplay,
  PORTAL_MESSAGE_DEFAULT_FOOTER_NOTE,
  PORTAL_MESSAGE_SEND_VIA_OPTIONS,
  portalMessageFieldLabel,
} from "@/components/portal/portal-message-compose-fields";

export type NotificationDeliveryChannels = {
  viaEmail: boolean;
  viaSms: boolean;
};

export type NotificationConfirmDraft = {
  subject: string;
  body: string;
  scheduleAt?: string;
};

export const NOTIFICATION_SEND_VIA_OPTIONS = PORTAL_MESSAGE_SEND_VIA_OPTIONS;

/**
 * Shared resident-message popup (payment reminders, service approve, etc.).
 */
export function PortalNotificationPreviewModal({
  open,
  title,
  onClose,
  recipient,
  subject,
  body,
  intro,
  warning,
  footerNote,
  showSkipMessage = true,
  skipMessageLabel = "Don't message resident",
  showChannelPicker = true,
  emailAvailable = true,
  smsAvailable = true,
  defaultViaEmail = true,
  defaultViaSms = true,
  editableBody = true,
  editableSubject = true,
  recipientPhone,
  showSchedule = true,
  initialScheduleLater = false,
  confirmLabel,
  confirmLabelWithoutMessage,
  confirmBusy = false,
  confirmBusyLabel = "Working…",
  cancelLabel = "Cancel",
  onConfirm,
  panelClassName,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  recipient: string;
  subject: string;
  body: string;
  intro?: string;
  warning?: string;
  footerNote?: string;
  showSkipMessage?: boolean;
  skipMessageLabel?: string;
  showChannelPicker?: boolean;
  emailAvailable?: boolean;
  smsAvailable?: boolean;
  defaultViaEmail?: boolean;
  defaultViaSms?: boolean;
  editableBody?: boolean;
  editableSubject?: boolean;
  recipientPhone?: string;
  showSchedule?: boolean;
  /** When true, opens with Schedule for later checked (resident detail thread flow). */
  initialScheduleLater?: boolean;
  confirmLabel: string;
  confirmLabelWithoutMessage?: string;
  confirmBusy?: boolean;
  confirmBusyLabel?: string;
  cancelLabel?: string;
  onConfirm: (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    draft?: NotificationConfirmDraft,
  ) => void;
  panelClassName?: string;
}) {
  const [skipMessage, setSkipMessage] = useState(false);
  const [sendVia, setSendVia] = useState<string[]>([]);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [sendAt, setSendAt] = useState(defaultPortalMessageScheduleAt);
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);

  const sendViaOptions = useMemo(() => {
    return NOTIFICATION_SEND_VIA_OPTIONS.filter((option) => {
      if (option.value === "email") return emailAvailable;
      if (option.value === "sms") return smsAvailable;
      return true;
    });
  }, [emailAvailable, smsAvailable]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setSkipMessage(false);
      setSendVia(defaultPortalMessageChannelSelection(emailAvailable, smsAvailable, defaultViaEmail, defaultViaSms));
      setScheduleLater(initialScheduleLater);
      setSendAt(defaultPortalMessageScheduleAt());
      setDraftSubject(subject);
      setDraftBody(body);
    });
  }, [open, recipient, subject, body, emailAvailable, smsAvailable, defaultViaEmail, defaultViaSms, initialScheduleLater]);

  const effectiveConfirmLabel = skipMessage
    ? (confirmLabelWithoutMessage ?? confirmLabel)
    : confirmLabel;

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);

  const channelsOk =
    !showChannelPicker ||
    skipMessage ||
    sendVia.some((value) => sendViaOptions.some((option) => option.value === value));

  const messageReady = skipMessage || (draftSubject.trim().length > 0 && draftBody.trim().length > 0);

  const toRecipientDisplay = portalMessageRecipientDisplay({
    email: recipient,
    phone: recipientPhone,
    viaEmail:
      showChannelPicker && !skipMessage ? viaEmail : Boolean(recipient.trim()),
    viaSms:
      showChannelPicker && !skipMessage ? viaSms : Boolean(recipientPhone?.trim()),
  });

  const footer = (
    <ModalFooter>
      <Button
        type="button"
        variant="primary"
        className="rounded-full"
        data-attr="portal-notification-confirm"
        disabled={confirmBusy || !channelsOk || !messageReady}
        onClick={() =>
          onConfirm(
            skipMessage,
            portalMessageChannelsFromSelection(sendVia),
            {
              subject: draftSubject.trim(),
              body: draftBody.trim(),
              scheduleAt:
                showSchedule && scheduleLater && !skipMessage
                  ? new Date(sendAt).toISOString()
                  : undefined,
            },
          )
        }
      >
        {confirmBusy ? confirmBusyLabel : effectiveConfirmLabel}
      </Button>
    </ModalFooter>
  );

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      dense
      footer={footer}
      panelClassName={cn(PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS, panelClassName)}
    >
      <PortalMessageComposeModalBody>
        {warning ? (
          <p className={`${MODAL_WARNING_BOX_CLASS} py-1.5 text-xs`}>
            <strong>AI-generated draft.</strong> {warning}
          </p>
        ) : null}
        {intro ? <p className="text-sm leading-snug text-muted">{intro}</p> : null}

        <PortalMessageRecipientReadonly recipient={toRecipientDisplay || "—"} />

        <div
          className={
            showChannelPicker && !skipMessage ? PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS : undefined
          }
        >
          <PortalMessageSubjectField
            value={draftSubject}
            onChange={setDraftSubject}
            disabled={skipMessage}
            readOnly={!editableSubject}
            dataAttr="portal-notification-subject"
          />

          {showChannelPicker && !skipMessage ? (
            <PortalMessageSendViaDropdown
              selected={sendVia}
              onChange={setSendVia}
              emailAvailable={emailAvailable}
              smsAvailable={smsAvailable}
              footerNote={footerNote?.trim() || PORTAL_MESSAGE_DEFAULT_FOOTER_NOTE}
              dataAttr="portal-notification-send-via"
            />
          ) : null}
        </div>

        {showChannelPicker && !skipMessage && !channelsOk ? (
          <p className="text-xs font-medium text-red-600">Choose at least one channel.</p>
        ) : null}

        <PortalMessageBodyField
          value={draftBody}
          onChange={setDraftBody}
          disabled={skipMessage}
          readOnly={!editableBody}
          placeholder="Write your message…"
          minHeightClass="min-h-[7rem]"
          dataAttr="portal-notification-body"
        />

        {showSkipMessage ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={skipMessage}
              onChange={(e) => setSkipMessage(e.target.checked)}
              data-attr="portal-notification-skip-message"
              className="mt-0.5 h-4 w-4 rounded border-border text-primary"
            />
            <span className="text-muted">{skipMessageLabel}</span>
          </label>
        ) : null}

        {showSchedule ? (
          <PortalMessageScheduleFields
            scheduleLater={scheduleLater}
            onScheduleLaterChange={setScheduleLater}
            sendAt={sendAt}
            onSendAtChange={setSendAt}
            disabled={skipMessage}
            scheduleDataAttr="portal-notification-schedule-later"
            sendAtDataAttr="portal-notification-schedule-at"
          />
        ) : null}

        {!showChannelPicker && footerNote && !skipMessage ? (
          <p className="text-xs text-muted">{footerNote}</p>
        ) : null}
        {skipMessage ? (
          <p className="text-xs text-muted">The action will complete without sending this message.</p>
        ) : null}
      </PortalMessageComposeModalBody>
    </Modal>
  );
}

export type BulkPaymentReminderPreviewItem = {
  id: string;
  recipient: string;
  chargeLabel: string;
  subject: string;
  body: string;
};

/** Scrollable preview before sending payment reminders to multiple charges. */
export function PortalBulkPaymentReminderPreviewModal({
  open,
  onClose,
  items,
  confirmBusy = false,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  items: BulkPaymentReminderPreviewItem[];
  confirmBusy?: boolean;
  onConfirm: () => void;
}) {
  const count = items.length;
  const title = count === 1 ? "Send payment reminder" : `Send ${count} payment reminders`;
  const confirmLabel = count === 1 ? "Send reminder" : `Send ${count} reminders`;

  const footer = (
    <ModalFooter>
      <Button
        type="button"
        variant="primary"
        className="rounded-full"
        data-attr="portal-bulk-notification-confirm"
        disabled={confirmBusy || count === 0}
        onClick={onConfirm}
      >
        {confirmBusy ? "Sending…" : confirmLabel}
      </Button>
    </ModalFooter>
  );

  return (
    <Modal open={open} title={title} onClose={onClose} dense footer={footer} panelClassName={PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS}>
      <p className="mb-4 text-sm leading-snug text-muted">
        Review each message below. Reminders are saved to PropLane inbox and sent by email when an address is on file.
      </p>
      <div className="max-h-[min(52vh,26rem)] space-y-3 overflow-y-auto pr-0.5 [scrollbar-width:thin]">
        {items.map((item, index) => (
          <div key={item.id} className="space-y-2 rounded-xl border border-border bg-accent/10 p-3">
            {count > 1 ? (
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Reminder {index + 1}</p>
            ) : null}
            <p className="text-xs font-semibold text-foreground">{item.chargeLabel}</p>
            <div>
              <p className={portalMessageFieldLabel()}>To</p>
              <p className={cn("mt-0.5 truncate text-sm text-foreground", MODAL_INSET_BOX_CLASS, "py-1.5")}>{item.recipient}</p>
            </div>
            <div>
              <p className={portalMessageFieldLabel()}>Subject</p>
              <p className={cn("mt-0.5 truncate text-sm text-foreground", MODAL_INSET_BOX_CLASS, "py-1.5")}>{item.subject}</p>
            </div>
            <div>
              <p className={portalMessageFieldLabel()}>Message</p>
              <pre
                className={cn(
                  MODAL_INSET_BOX_CLASS,
                  "mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap py-2 text-sm leading-relaxed",
                )}
              >
                {item.body}
              </pre>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

