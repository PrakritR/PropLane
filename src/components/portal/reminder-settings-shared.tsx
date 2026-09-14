"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { TOGGLE_CHIP_CLASS, ToggleChips, ToggleChipsGroupLabel } from "@/components/ui/toggle-chips";
import { Modal } from "@/components/ui/modal";
import {
  PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageRecipientLockedField,
  PortalMessageSubjectField,
} from "@/components/portal/portal-message-compose-fields";
import { normalizeTourReminderMinutesBeforeList } from "@/lib/payment-automation-settings";
import { cn } from "@/lib/utils";
import {
  normalizeTimings,
  summarizeTimings,
  timingOptions,
  type TimingDirection,
} from "@/lib/reminders/timings";

export const REMINDER_FIELD_LABEL_CLASS = "text-xs font-semibold text-muted";

/**
 * Which channels a reminder goes out on — three fixed options as chips.
 *
 * This was a checkbox dropdown that read "PropLane & Email" until opened. The
 * rule inside is unchanged: at least one channel stays on, a tap that would
 * turn the last one off is refused (and says so), and an SMS chip a workspace
 * cannot use is shown disabled rather than hidden so the manager knows why.
 */
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
  const [lastChannelRefused, setLastChannelRefused] = useState(false);
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

  return (
    <div>
      <p className={REMINDER_FIELD_LABEL_CLASS}>Send via</p>
      <ToggleChips
        label="Send via"
        className="mt-1.5"
        options={options}
        selected={effectiveSelected}
        onChange={(next) => {
          if (disabled) return;
          const enabled = next.filter((value) => value !== "sms" || smsAvailable);
          if (enabled.length === 0) {
            setLastChannelRefused(true);
            return;
          }
          setLastChannelRefused(false);
          onChange({
            viaInbox: showProplaneChannel ? enabled.includes("proplane") : viaInbox,
            viaEmail: enabled.includes("email"),
            viaSms: enabled.includes("sms"),
          });
        }}
        disabled={disabled}
        dataAttr={dataAttr}
      />
      {lastChannelRefused ? (
        <p className="mt-1.5 text-xs text-destructive" role="alert">
          Keep at least one channel on.
        </p>
      ) : null}
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

  // No Save button: closing the dialog is the save, the same rule every settings
  // popup follows. A draft that cannot be sent (blank subject or body, every
  // channel off) is left where it was rather than half-applied, and the line
  // under the fields says so while it is in that state.
  // The header × and the dialog's own dismiss both call this for one click
  // (the settings modal carries the same note), so apply at most once per open.
  const appliedRef = useRef(false);
  useEffect(() => {
    if (open) appliedRef.current = false;
  }, [open]);
  const applyAndClose = () => {
    if (canSave && !appliedRef.current) {
      appliedRef.current = true;
      onSave({
        subject: draftSubject.trim(),
        body: draftBody.trim(),
        viaInbox: draftInbox,
        viaEmail: draftEmail,
        viaSms: draftSms && smsAvailable,
      });
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={applyAndClose}
      title="Update message"
      dense
      assistantContext="Automated reminder message template"
      panelClassName={PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS}
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
        {!canSave ? (
          <p className="text-xs text-amber-700" role="status" data-attr="reminder-update-message-incomplete">
            {anyChannel
              ? "Add a subject and a message — closing without them keeps the current message."
              : "Keep at least one channel on — closing with none keeps the current message."}
          </p>
        ) : (
          <p className="text-xs text-muted">Saved when you close this.</p>
        )}
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

/**
 * A small inline "N before …" box that lives at the end of a chip row — the
 * custom-value affordance the chip pickers share. Opens on "+ Custom", commits
 * on Enter or the check, closes on Escape or the cross, and refuses an
 * out-of-range number with a sentence rather than silently doing nothing.
 */
export function CustomChipInput({
  open,
  onOpen,
  onClose,
  onCommit,
  unit,
  min,
  max,
  disabled,
  dataAttr,
  placeholder,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Returns false when the value is rejected. */
  onCommit: (value: number) => boolean;
  unit: string;
  min: number;
  max: number;
  disabled?: boolean;
  dataAttr: string;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setValue("");
    setError(false);
    onClose();
  };

  const commit = () => {
    const n = Math.round(Number(value.trim()));
    if (!value.trim() || !Number.isFinite(n) || n < min || n > max || !onCommit(n)) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    close();
  };

  if (!open) {
    return (
      <button
        type="button"
        className={cn(TOGGLE_CHIP_CLASS, "border-dashed border-border bg-card text-primary hover:border-primary hover:bg-accent/40")}
        disabled={disabled}
        data-attr={dataAttr}
        onClick={onOpen}
      >
        + Custom
      </button>
    );
  }

  return (
    <>
      <span
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-full border bg-card pl-3 pr-1.5 text-xs text-muted",
          error ? "border-destructive" : "border-primary",
        )}
        data-attr={dataAttr}
      >
        <input
          ref={inputRef}
          type="number"
          min={min}
          max={max}
          inputMode="numeric"
          aria-label={placeholder}
          aria-invalid={error || undefined}
          placeholder={unit}
          className="h-7 w-14 border-0 border-b border-border bg-transparent text-center text-sm font-semibold text-foreground outline-none focus:border-primary"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <span>{placeholder.replace(/^custom /i, "")}</span>
        <button
          type="button"
          aria-label="Add"
          className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
          disabled={disabled}
          onClick={commit}
        >
          <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Cancel"
          className="inline-flex size-7 items-center justify-center rounded-full text-muted hover:text-foreground"
          onClick={close}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </span>
      {error ? (
        <p className="basis-full text-xs text-destructive" role="alert">
          Pick a number from {min} to {max}.
        </p>
      ) : null}
    </>
  );
}

/**
 * Tour reminder lead times as chips (15 · 30 · 60 · 120 minutes, plus any
 * custom minutes already stored). Same shape as the payment schedule: every
 * option visible, one tap each, custom inline instead of in a menu footer.
 */
export function TourReminderTimingSelect({
  minutesBeforeList,
  disabled,
  onChangeMinutesList,
}: {
  minutesBeforeList: number[];
  disabled?: boolean;
  onChangeMinutesList: (minutes: number[]) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const sorted = useMemo(() => sortTourReminderMinutes(minutesBeforeList), [minutesBeforeList]);
  const selectedTokens = sorted.map(String);

  const presets = new Set<number>(TOUR_REMINDER_TIMING_PRESETS);
  const allMinutes = [...new Set([...sorted, ...TOUR_REMINDER_TIMING_PRESETS])].sort((a, b) => a - b);
  const options = allMinutes.map((minutes) => ({
    value: String(minutes),
    label: formatTourReminderTimingTriggerLabel(minutes),
    title: presets.has(minutes) ? undefined : "Custom time — turn off to remove",
  }));

  const commitSelection = (tokens: string[]) => {
    const next = sortTourReminderMinutes(tokens.map((token) => Number(token)).filter((n) => Number.isFinite(n)));
    onChangeMinutesList(next);
  };

  return (
    <div>
      <p className={REMINDER_FIELD_LABEL_CLASS}>Reminders</p>
      <ToggleChipsGroupLabel>Before the tour</ToggleChipsGroupLabel>
      <ToggleChips
        label="Reminders before the tour"
        options={options}
        selected={selectedTokens}
        onChange={commitSelection}
        disabled={disabled}
        dataAttr="tour-reminder-timing"
        trailing={
          <CustomChipInput
            open={customOpen}
            onOpen={() => setCustomOpen(true)}
            onClose={() => setCustomOpen(false)}
            onCommit={(minutes) => {
              commitSelection([...selectedTokens, String(minutes)]);
              return true;
            }}
            unit="min"
            min={5}
            max={1440}
            disabled={disabled}
            dataAttr="tour-reminder-custom-minutes"
            placeholder="Custom minutes before tour"
          />
        }
      />
      <p className="mt-1.5 text-xs text-muted">
        {sorted.length
          ? `Sends ${sorted.map(formatTourReminderTimingTriggerLabel).join(", ")} before the tour.`
          : "No tour reminders."}
      </p>
    </div>
  );
}

/**
 * Generic reminder timings as chips, one row per direction the subject
 * allows ("Before" runs a week down to fifteen minutes; "After" runs the
 * other way — the same ordering `timingOptions` has always used).
 */
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
  const rows = directions.map((direction) => ({
    direction,
    options: options
      .filter((option) => option.value.startsWith(`${direction}:`))
      .map((option) => ({ value: option.value, label: option.label.replace(new RegExp(` ${direction}$`), "") })),
  }));
  const selectedFor = (direction: TimingDirection) => normalized.filter((key) => key.startsWith(`${direction}:`));

  return (
    <div>
      <p className={REMINDER_FIELD_LABEL_CLASS}>{label}</p>
      {rows.map((row) => (
        <div key={row.direction} className="pt-1.5">
          {directions.length > 1 ? (
            <ToggleChipsGroupLabel>{row.direction === "before" ? "Before" : "After"}</ToggleChipsGroupLabel>
          ) : null}
          <ToggleChips
            label={`${label} ${row.direction}`}
            options={row.options}
            selected={selectedFor(row.direction)}
            onChange={(nextForRow) => {
              const others = normalized.filter((key) => !key.startsWith(`${row.direction}:`));
              onChangeTimings(normalizeTimings([...others, ...nextForRow], normalized));
            }}
            disabled={disabled}
            dataAttr={directions.length > 1 ? `${dataAttr}-${row.direction}` : dataAttr}
          />
        </div>
      ))}
      <p className="mt-1.5 text-xs text-muted">
        {normalized.length ? `Sends ${summarizeTimings(normalized)}.` : "No reminders."}
      </p>
    </div>
  );
}
