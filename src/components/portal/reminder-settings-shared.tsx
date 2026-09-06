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
import {
  normalizeTimings,
  summarizeTimings,
  timingOptions,
  type TimingDirection,
} from "@/lib/reminders/timings";

export const REMINDER_FIELD_LABEL_CLASS = "text-xs font-semibold text-muted";

export function ReminderSendViaField({
  viaEmail,
  viaSms,
  viaInbox,
  onChange,
  showProplaneChannel = false,
  smsAvailable = true,
  smsLabel,
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
  /**
   * Channels come back with the message because the modal edits both. A caller
   * that only stores the template can ignore them, but every current caller has
   * per-rule channel state and persists them.
   */
  onSave: (next: {
    subject: string;
    body: string;
    viaInbox: boolean;
    viaEmail: boolean;
    viaSms: boolean;
  }) => void;
}) {
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);
  const [draftInbox, setDraftInbox] = useState(viaInbox !== false);
  const [draftEmail, setDraftEmail] = useState(viaEmail !== false);
  const [draftSms, setDraftSms] = useState(viaSms === true);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setDraftSubject(subject);
      setDraftBody(body);
      setDraftInbox(viaInbox !== false);
      setDraftEmail(viaEmail !== false);
      setDraftSms(viaSms === true);
    });
  }, [open, subject, body, viaInbox, viaEmail, viaSms]);

  // A message with every channel switched off would save cleanly and then never
  // reach anybody, so it is refused here rather than failing silently at send.
  const anyChannel = draftInbox || draftEmail || (draftSms && smsAvailable);
  const canSave = draftSubject.trim().length > 0 && draftBody.trim().length > 0 && anyChannel;

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
              onSave({
                subject: draftSubject.trim(),
                body: draftBody.trim(),
                viaInbox: draftInbox,
                viaEmail: draftEmail,
                viaSms: draftSms && smsAvailable,
              });
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
            viaInbox={draftInbox}
            viaEmail={draftEmail}
            viaSms={draftSms}
            smsAvailable={smsAvailable}
            smsLabel={smsLabel}
            onChange={({ viaInbox: nextInbox, viaEmail: nextEmail, viaSms: nextSms }) => {
              setDraftInbox(nextInbox !== false);
              setDraftEmail(nextEmail);
              setDraftSms(nextSms);
            }}
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

export function ReminderTimingMultiSelect({
  timings,
  directions,
  label = "Reminders",
  disabled,
  onChangeTimings,
  dataAttr = "reminder-timing",
}: {
  timings: string[];
  directions: readonly TimingDirection[];
  label?: string;
  disabled?: boolean;
  onChangeTimings: (timings: string[]) => void;
  dataAttr?: string;
}) {
  const normalized = useMemo(() => normalizeTimings(timings, []), [timings]);
  const options = useMemo(() => timingOptions(directions), [directions]);
  const selectionTriggerLabel = normalized.length ? summarizeTimings(normalized) : undefined;

  return (
    <CheckboxMultiSelect
      label={label}
      labelClassName={REMINDER_FIELD_LABEL_CLASS}
      options={options}
      selected={normalized}
      selectionTriggerLabel={selectionTriggerLabel}
      onChange={(next) => onChangeTimings(normalizeTimings(next, normalized))}
      disabled={disabled}
      emptyLabel="Choose reminders…"
      dataAttr={dataAttr}
    />
  );
}
