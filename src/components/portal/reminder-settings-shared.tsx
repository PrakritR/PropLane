"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageRecipientLockedField,
  PortalMessageSubjectField,
} from "@/components/portal/portal-message-compose-fields";
import { normalizeTourReminderMinutesBeforeList } from "@/lib/payment-automation-settings";

export const REMINDER_FIELD_LABEL_CLASS = "text-xs font-semibold text-muted";

export function ReminderSendViaField({
  viaEmail,
  viaSms,
  viaInbox,
  onChange,
  showProplaneChannel = false,
  smsAvailable = true,
  smsLabel,
  footerNote,
  dataAttr = "reminder-send-via",
  disabled = false,
}: {
  viaEmail: boolean;
  viaSms: boolean;
  viaInbox?: boolean;
  onChange: (next: { viaEmail: boolean; viaSms: boolean; viaInbox?: boolean }) => void;
  showProplaneChannel?: boolean;
  smsAvailable?: boolean;
  smsLabel?: string;
  footerNote?: string;
  dataAttr?: string;
  disabled?: boolean;
}) {
  const options = [
    ...(showProplaneChannel ? [{ value: "proplane", label: "PropLane" }] : []),
    { value: "email", label: "Email" },
    {
      value: "sms",
      label: smsLabel ?? (smsAvailable ? "SMS" : "SMS (not enabled)"),
      disabled: !smsAvailable,
    },
  ];
  const selected = [
    ...(showProplaneChannel && viaInbox !== false ? ["proplane"] : []),
    ...(viaEmail ? ["email"] : []),
    ...(viaSms ? ["sms"] : []),
  ];
  const fallback = showProplaneChannel
    ? ["proplane", "email"]
    : viaEmail || !smsAvailable
      ? ["email"]
      : ["sms"];
  const effectiveSelected = selected.length > 0 ? selected : fallback;

  const labels: string[] = [];
  if (effectiveSelected.includes("proplane")) labels.push("PropLane");
  if (effectiveSelected.includes("email")) labels.push("Email");
  if (effectiveSelected.includes("sms")) labels.push("SMS");
  const selectionTriggerLabel =
    labels.length > 1 ? labels.join(" & ") : labels[0] ?? "Email";

  return (
    <div>
      <CheckboxMultiSelect
        label="Send via"
        labelClassName={REMINDER_FIELD_LABEL_CLASS}
        options={options}
        selected={effectiveSelected}
        selectionTriggerLabel={selectionTriggerLabel}
        onChange={(next) => {
          if (disabled) return;
          const enabled = next.filter((value) => value !== "sms" || smsAvailable);
          if (enabled.length === 0) return;
          onChange({
            viaInbox: showProplaneChannel ? enabled.includes("proplane") : viaInbox,
            viaEmail: enabled.includes("email"),
            viaSms: enabled.includes("sms"),
          });
        }}
        disabled={disabled}
        emptyLabel="Choose channels…"
        dataAttr={dataAttr}
      />
      {footerNote ? <p className="mt-1.5 text-xs text-muted">{footerNote}</p> : null}
    </div>
  );
}

export function ReminderMessagePreviewCard({
  subject,
  body,
  onUpdate,
  dataAttr = "reminder-update-message",
}: {
  subject: string;
  body: string;
  onUpdate: () => void;
  dataAttr?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <p className={REMINDER_FIELD_LABEL_CLASS}>Message</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">{subject || "Reminder"}</p>
      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{body}</p>
      <button
        type="button"
        className="mt-2 text-xs font-semibold text-primary hover:underline"
        onClick={onUpdate}
        data-attr={dataAttr}
      >
        Update message
      </button>
    </div>
  );
}

export function ReminderMessageUpdateModal({
  open,
  onClose,
  subject,
  body,
  placeholders,
  recipient,
  viaInbox = true,
  viaEmail = true,
  viaSms = false,
  showProplaneChannel = true,
  smsAvailable = true,
  smsLabel,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  body: string;
  placeholders: string;
  /** Sample recipient shown in the locked To field — matches New message compose. */
  recipient: string;
  viaInbox?: boolean;
  viaEmail?: boolean;
  viaSms?: boolean;
  showProplaneChannel?: boolean;
  smsAvailable?: boolean;
  smsLabel?: string;
  onSave: (next: { subject: string; body: string }) => void;
}) {
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setDraftSubject(subject);
      setDraftBody(body);
    });
  }, [open, subject, body]);

  const canSave = draftSubject.trim().length > 0 && draftBody.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Update message"
      dense
      assistantContext="Automated reminder message template"
      panelClassName={PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            data-attr="reminder-update-message-save"
            disabled={!canSave}
            onClick={() => {
              onSave({ subject: draftSubject.trim(), body: draftBody.trim() });
              onClose();
            }}
          >
            Save message
          </Button>
        </ModalFooter>
      }
    >
      <PortalMessageComposeModalBody>
        <PortalMessageRecipientLockedField
          recipient={recipient}
          dataAttr="reminder-update-message-recipient"
        />

        <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
          <PortalMessageSubjectField
            value={draftSubject}
            onChange={setDraftSubject}
            dataAttr="reminder-update-message-subject"
          />
          <ReminderSendViaField
            showProplaneChannel={showProplaneChannel}
            viaInbox={viaInbox !== false}
            viaEmail={viaEmail !== false}
            viaSms={viaSms === true}
            smsAvailable={smsAvailable}
            smsLabel={smsLabel}
            disabled
            footerNote="Change delivery channels in the settings above."
            onChange={() => {}}
            dataAttr="reminder-update-message-send-via"
          />
        </div>

        <PortalMessageBodyField
          value={draftBody}
          onChange={setDraftBody}
          placeholder="Write your message…"
          minHeightClass="min-h-[7rem]"
          dataAttr="reminder-update-message-body"
        />

        <p className="text-[11px] text-muted">{placeholders}</p>
      </PortalMessageComposeModalBody>
    </Modal>
  );
}

export const TOUR_REMINDER_TIMING_PRESETS = [15, 30, 60, 120] as const;

export function formatTourReminderTimingLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes before tour`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hour${hours === 1 ? "" : "s"} before tour`;
  return `${hours}h ${remainder}m before tour`;
}

function formatTourReminderTimingTriggerLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${remainder}m`;
}

function sortTourReminderMinutes(minutes: number[]): number[] {
  return normalizeTourReminderMinutesBeforeList(minutes);
}

export function TourReminderTimingSelect({
  minutesBeforeList,
  disabled,
  onChangeMinutesList,
}: {
  minutesBeforeList: number[];
  disabled?: boolean;
  onChangeMinutesList: (minutes: number[]) => void;
}) {
  const [customMinutesInput, setCustomMinutesInput] = useState("");
  const sorted = useMemo(() => sortTourReminderMinutes(minutesBeforeList), [minutesBeforeList]);
  const selectedTokens = sorted.map(String);
  const selectionTriggerLabel = sorted.length
    ? sorted.map((minutes) => formatTourReminderTimingTriggerLabel(minutes)).join(", ")
    : undefined;

  const presetOptions = TOUR_REMINDER_TIMING_PRESETS.map((minutes) => ({
    value: String(minutes),
    label: formatTourReminderTimingLabel(minutes),
  }));
  const customOptions = sorted
    .filter((minutes) => !TOUR_REMINDER_TIMING_PRESETS.includes(minutes as (typeof TOUR_REMINDER_TIMING_PRESETS)[number]))
    .map((minutes) => ({
      value: String(minutes),
      label: formatTourReminderTimingLabel(minutes),
    }));
  const options = [...customOptions, ...presetOptions];

  const commitSelection = (tokens: string[]) => {
    const next = sortTourReminderMinutes(tokens.map((token) => Number(token)).filter((n) => Number.isFinite(n)));
    onChangeMinutesList(next);
  };

  const addCustomMinutes = () => {
    const minutes = Math.round(Number(customMinutesInput.trim()));
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) return;
    commitSelection([...selectedTokens, String(minutes)]);
    setCustomMinutesInput("");
  };

  return (
    <div className="space-y-2">
      <CheckboxMultiSelect
        label="Reminders"
        labelClassName={REMINDER_FIELD_LABEL_CLASS}
        options={options}
        selected={selectedTokens}
        selectionTriggerLabel={selectionTriggerLabel}
        onChange={commitSelection}
        disabled={disabled}
        emptyLabel="Choose reminders…"
        dataAttr="tour-reminder-timing"
        menuFooter={
          <div className="px-3 py-2">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Custom minutes</p>
            <div className="flex gap-2">
              <Input
                type="number"
                min={5}
                max={1440}
                className="h-9 min-h-0 flex-1"
                placeholder="Minutes before tour"
                value={customMinutesInput}
                disabled={disabled}
                data-attr="tour-reminder-custom-minutes"
                onChange={(e) => setCustomMinutesInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomMinutes();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 rounded-full px-3 text-xs"
                disabled={disabled || !customMinutesInput.trim()}
                onClick={addCustomMinutes}
              >
                Add
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
