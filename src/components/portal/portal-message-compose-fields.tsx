"use client";

import type { ReactNode } from "react";
import {
  CheckboxMultiSelect,
  type CheckboxMultiSelectGroup,
  type CheckboxMultiSelectOption,
} from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { MODAL_INSET_BOX_CLASS } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

/** New-message compose modals: full height on mobile; capped on desktop. Body scrolls inside the modal shell. */
export const PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS =
  "flex w-full max-w-lg min-h-0 flex-col max-lg:h-[min(92dvh,calc(100dvh-var(--portal-native-bottom-nav-inset,0px)))] max-lg:max-h-[min(92dvh,calc(100dvh-var(--portal-native-bottom-nav-inset,0px)))] lg:max-h-[min(92dvh,38rem)]";

export type PortalMessageSendViaMode = "email" | "sms" | "both";

export const PORTAL_MESSAGE_SEND_VIA_OPTIONS: CheckboxMultiSelectOption[] = [
  { value: "proplane", label: "PropLane" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
];

export const PORTAL_MESSAGE_DEFAULT_FOOTER_NOTE =
  "SMS uses your work number when enabled.";

/** Send-via helper copy — matches the Communication compose modal. */
export function portalMessageSendViaFooterNote(smsAvailable: boolean): string {
  return smsAvailable
    ? "SMS uses your work number; recipients need a phone on file or under Other."
    : "Add a work number under Communication → SMS to text recipients.";
}

/** Primary CTA label for compose-style modals (Send email / SMS / message / Schedule). */
export function portalMessageConfirmSendLabel(args: {
  busy: boolean;
  busyLabel?: string;
  skipMessage: boolean;
  staticLabel: string;
  scheduleLater: boolean;
  viaEmail: boolean;
  viaSms: boolean;
  dynamic?: boolean;
}): string {
  if (args.busy) return args.busyLabel ?? "Sending…";
  if (args.skipMessage || !args.dynamic) return args.staticLabel;
  if (args.scheduleLater) return "Schedule";
  if (args.viaEmail && args.viaSms) return "Send message";
  if (args.viaSms) return "Send SMS";
  // PropLane-only: nothing leaves the product, so "Send email" was a promise
  // the send does not keep.
  if (!args.viaEmail) return "Send message";
  return "Send email";
}

export function portalMessageFieldLabel(className?: string) {
  return cn("text-xs font-medium text-muted", className);
}

/** Match Subject/Message labels on To / Which people multi-selects. */
export const PORTAL_MESSAGE_COMPOSE_SELECT_LABEL_CLASS = portalMessageFieldLabel();

/** Two-column row for compose dropdowns (Subject / Send via). */
export const PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS = "grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2";

/** Prefixes keep the merged To options unambiguous — the "admin" section and the
 * synthetic "admin" person key are otherwise the same string. */
const RECIPIENT_SECTION_PREFIX = "section:";
const RECIPIENT_PERSON_PREFIX = "person:";

function sameSelection(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * To: sections and the people inside them in ONE dropdown (new message / SMS
 * compose). Picking a section reveals its people as a group in the same open
 * menu — two stacked selects read as two unrelated recipients fields.
 */
export function PortalMessageComposeRecipientSection({
  sectionOptions,
  selectedCategories,
  onCategoriesChange,
  sectionDataAttr,
  personGroups,
  selectedKeys,
  onPeopleChange,
  peopleDisabled = false,
  peopleSearchPlaceholder = "Search people…",
  peopleEmptyMenuText,
}: {
  sectionOptions: CheckboxMultiSelectOption[];
  selectedCategories: string[];
  onCategoriesChange: (next: string[]) => void;
  sectionDataAttr: string;
  personGroups: CheckboxMultiSelectGroup[];
  selectedKeys: string[];
  onPeopleChange: (next: string[]) => void;
  peopleDisabled?: boolean;
  peopleSearchPlaceholder?: string;
  peopleEmptyMenuText: string;
}) {
  const personGroupFor = (sectionLabel: string) =>
    personGroups.find((group) => group.label === sectionLabel) ?? null;
  const asPersonGroup = (group: CheckboxMultiSelectGroup): CheckboxMultiSelectGroup => ({
    label: group.label,
    options: group.options.map((o) => ({
      ...o,
      value: `${RECIPIENT_PERSON_PREFIX}${o.value}`,
      // A section whose people are fixed (PropLane admin) still SHOWS its
      // recipient, so the one field always says who is being written to.
      disabled: peopleDisabled || o.disabled,
    })),
  });

  /**
   * A section's people sit DIRECTLY under that section's own row, not after the
   * whole section list — with several sections open, a trailing block gives no
   * clue which people belong to which one.
   */
  const groups: CheckboxMultiSelectGroup[] = [];
  const matchedPersonGroups = new Set<CheckboxMultiSelectGroup>();
  let pendingSections: CheckboxMultiSelectOption[] = [];
  let sectionHeaderUsed = false;
  const flushSections = () => {
    if (pendingSections.length === 0) return;
    groups.push({ label: sectionHeaderUsed ? "" : "Sections", options: pendingSections });
    sectionHeaderUsed = true;
    pendingSections = [];
  };
  for (const option of sectionOptions) {
    pendingSections.push({ ...option, value: `${RECIPIENT_SECTION_PREFIX}${option.value}` });
    const people = personGroupFor(option.label);
    if (!people) continue;
    flushSections();
    matchedPersonGroups.add(people);
    groups.push(asPersonGroup(people));
  }
  flushSections();
  // A people group whose label does not match any section still has to render,
  // or its recipients silently disappear from the menu.
  for (const group of personGroups) {
    if (!matchedPersonGroups.has(group)) groups.push(asPersonGroup(group));
  }

  const listedPersonKeys = new Set(personGroups.flatMap((g) => g.options.map((o) => o.value)));
  const selected = [
    ...selectedCategories.map((v) => `${RECIPIENT_SECTION_PREFIX}${v}`),
    ...selectedKeys.filter((k) => listedPersonKeys.has(k)).map((v) => `${RECIPIENT_PERSON_PREFIX}${v}`),
  ];

  const personLabel = (key: string) =>
    personGroups.flatMap((g) => g.options).find((o) => o.value === key)?.label ?? key;
  const sectionLabel = (value: string) =>
    sectionOptions.find((o) => o.value === value)?.label ?? value;

  let triggerLabel: string | undefined;
  if (selectedKeys.length === 1) triggerLabel = personLabel(selectedKeys[0]!);
  else if (selectedKeys.length > 1) triggerLabel = `${selectedKeys.length} recipients`;
  else if (selectedCategories.length === 1) triggerLabel = sectionLabel(selectedCategories[0]!);
  else if (selectedCategories.length > 1) triggerLabel = `${selectedCategories.length} sections`;

  const handleChange = (next: string[]) => {
    const nextCategories = next
      .filter((v) => v.startsWith(RECIPIENT_SECTION_PREFIX))
      .map((v) => v.slice(RECIPIENT_SECTION_PREFIX.length));
    const nextListedPeople = next
      .filter((v) => v.startsWith(RECIPIENT_PERSON_PREFIX))
      .map((v) => v.slice(RECIPIENT_PERSON_PREFIX.length));
    // Keys the menu never showed (a section's fixed recipient) survive a toggle.
    const nextPeople = [
      ...selectedKeys.filter((k) => !listedPersonKeys.has(k)),
      ...nextListedPeople,
    ];

    if (!sameSelection(nextCategories, selectedCategories)) onCategoriesChange(nextCategories);
    if (!sameSelection(nextPeople, selectedKeys)) onPeopleChange(nextPeople);
  };

  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className={PORTAL_MESSAGE_COMPOSE_SELECT_LABEL_CLASS}>To</legend>
      <div className="mt-1">
        <CheckboxMultiSelect
          label="Recipients"
          hideLabel
          labelClassName={PORTAL_MESSAGE_COMPOSE_SELECT_LABEL_CLASS}
          groups={groups}
          selected={selected}
          onChange={handleChange}
          selectionTriggerLabel={triggerLabel}
          emptyLabel="Choose recipients"
          searchPlaceholder={peopleSearchPlaceholder}
          emptyMenuText={peopleEmptyMenuText}
          dataAttr={sectionDataAttr}
        />
      </div>
    </fieldset>
  );
}

export function portalMessageSendViaToMode(selected: string[]): PortalMessageSendViaMode {
  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(selected);
  if (viaEmail && viaSms) return "both";
  if (viaSms) return "sms";
  return "email";
}

export function portalMessageSendViaModeToSelection(mode: PortalMessageSendViaMode): string[] {
  if (mode === "both") return ["email", "sms"];
  if (mode === "sms") return ["sms"];
  return ["email"];
}

export function PortalMessageComposeModalBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
      <div className="space-y-3">{children}</div>
    </div>
  );
}

export function defaultPortalMessageScheduleAt(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function portalMessageChannelsFromSelection(selected: string[]): {
  viaInbox: boolean;
  viaEmail: boolean;
  viaSms: boolean;
} {
  return {
    viaInbox: selected.includes("proplane"),
    viaEmail: selected.includes("email"),
    viaSms: selected.includes("sms"),
  };
}

export function portalMessageChannelsSelectionValid(
  selected: string[],
  emailAvailable: boolean,
  smsAvailable: boolean,
): boolean {
  return selected.some(
    (value) =>
      value === "proplane" ||
      (value === "email" && emailAvailable) ||
      (value === "sms" && smsAvailable),
  );
}

/** Read-only To line: only destinations for the selected delivery channels. */
export function portalMessageRecipientDisplay(input: {
  email?: string;
  phone?: string;
  viaEmail: boolean;
  viaSms: boolean;
}): string {
  const parts: string[] = [];
  const email = input.email?.trim();
  const phone = input.phone?.trim();
  if (input.viaEmail && email) parts.push(email);
  if (input.viaSms && phone) parts.push(phone);
  // A PropLane-only send still has a destination; an empty To line read as a
  // missing recipient rather than an in-product delivery.
  if (parts.length === 0) return "PropLane inbox";
  return parts.join(" · ");
}

export function defaultPortalMessageChannelSelection(
  emailAvailable: boolean,
  smsAvailable: boolean,
  defaultViaEmail: boolean,
  defaultViaSms: boolean,
  defaultViaInbox: boolean = true,
): string[] {
  const selected: string[] = [];
  if (defaultViaInbox) selected.push("proplane");
  if (emailAvailable && defaultViaEmail) selected.push("email");
  if (smsAvailable && defaultViaSms) selected.push("sms");
  if (selected.length > 0) return selected;
  return ["proplane", ...(emailAvailable ? ["email"] : [])];
}

export function PortalMessageRecipientReadonly({
  recipient,
  wrap = false,
}: {
  recipient: string;
  /** Allow multiple comma-separated recipients to wrap instead of truncating. */
  wrap?: boolean;
}) {
  return (
    <div>
      <p className={portalMessageFieldLabel()}>To</p>
      <p
        className={cn(
          "mt-1 text-sm text-foreground",
          MODAL_INSET_BOX_CLASS,
          "py-2",
          wrap ? "whitespace-pre-wrap break-words" : "truncate",
        )}
      >
        {recipient}
      </p>
    </div>
  );
}

/** Locked recipient — same dropdown chrome as New message, read-only for reminders. */
export function PortalMessageRecipientLockedField({
  recipient,
  dataAttr = "portal-message-recipient-locked",
}: {
  recipient: string;
  dataAttr?: string;
}) {
  const label = recipient.trim() || "—";
  const lockedValue = "locked-recipient";
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className={PORTAL_MESSAGE_COMPOSE_SELECT_LABEL_CLASS}>To</legend>
      <div className="mt-1">
        <CheckboxMultiSelect
          label="Recipients"
          hideLabel
          labelClassName={PORTAL_MESSAGE_COMPOSE_SELECT_LABEL_CLASS}
          options={[{ value: lockedValue, label }]}
          selected={[lockedValue]}
          onChange={() => {}}
          readOnly
          selectionTriggerLabel={label}
          emptyLabel="Choose recipients"
          dataAttr={dataAttr}
        />
      </div>
    </fieldset>
  );
}

export function PortalMessagePhoneReadonly({ phone }: { phone?: string }) {
  if (!phone?.trim()) return null;
  return (
    <div>
      <p className={portalMessageFieldLabel()}>Phone</p>
      <p className={cn("mt-1 truncate text-sm text-foreground", MODAL_INSET_BOX_CLASS, "py-2")}>
        {phone.trim()}
      </p>
    </div>
  );
}

export function PortalMessageSubjectField({
  id = "portal-message-subject",
  value,
  onChange,
  disabled = false,
  readOnly = false,
  placeholder = "Subject",
  dataAttr,
}: {
  id?: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  dataAttr?: string;
}) {
  return (
    <div>
      <label className={portalMessageFieldLabel()} htmlFor={readOnly ? undefined : id}>
        Subject
      </label>
      {readOnly || disabled ? (
        <p
          className={cn(
            "mt-1 truncate text-sm",
            MODAL_INSET_BOX_CLASS,
            "py-2",
            disabled ? "opacity-50" : "",
          )}
        >
          {value}
        </p>
      ) : (
        <Input
          id={id}
          className="mt-1"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          data-attr={dataAttr}
        />
      )}
    </div>
  );
}

export function PortalMessageSendViaField({
  selected,
  onChange,
  emailAvailable = true,
  smsAvailable = true,
  disabled = false,
  footerNote = PORTAL_MESSAGE_DEFAULT_FOOTER_NOTE,
  dataAttr = "portal-message-send-via",
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  emailAvailable?: boolean;
  smsAvailable?: boolean;
  disabled?: boolean;
  footerNote?: string;
  dataAttr?: string;
}) {
  const options = PORTAL_MESSAGE_SEND_VIA_OPTIONS.filter((option) => {
    if (option.value === "email") return emailAvailable;
    if (option.value === "sms") return smsAvailable;
    return true;
  });
  const channelsOk = disabled || selected.some((value) => options.some((option) => option.value === value));

  return (
    <div>
      <CheckboxMultiSelect
        label="Send via"
        labelClassName={portalMessageFieldLabel()}
        options={options}
        selected={selected}
        onChange={onChange}
        disabled={disabled}
        emptyLabel="Choose channels…"
        dataAttr={dataAttr}
      />
      {!channelsOk ? (
        <p className="mt-1.5 text-xs font-medium text-red-600">Choose at least one channel.</p>
      ) : footerNote?.trim() ? (
        <p className="mt-1.5 text-xs text-muted">{footerNote}</p>
      ) : null}
    </div>
  );
}

/** Multi-select Send via — same field width and label style as Subject / Message. */
export function PortalMessageSendViaDropdown({
  selected,
  onChange,
  emailAvailable = true,
  smsAvailable = true,
  disabled = false,
  footerNote = PORTAL_MESSAGE_DEFAULT_FOOTER_NOTE,
  dataAttr = "portal-message-send-via",
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  emailAvailable?: boolean;
  smsAvailable?: boolean;
  disabled?: boolean;
  footerNote?: string;
  dataAttr?: string;
}) {
  const options = [
    { value: "proplane", label: "PropLane" },
    {
      value: "email",
      label: emailAvailable ? "Email" : "Email (unavailable)",
      disabled: !emailAvailable,
    },
    {
      value: "sms",
      label: smsAvailable ? "SMS" : "SMS (not enabled)",
      disabled: !smsAvailable,
    },
  ];

  const effectiveSelected = selected.filter(
    (value) =>
      value === "proplane" ||
      (value === "email" && emailAvailable) ||
      (value === "sms" && smsAvailable),
  );
  const displaySelected =
    effectiveSelected.length > 0
      ? effectiveSelected
      : ["proplane", ...(emailAvailable ? ["email"] : [])];

  const labels: string[] = [];
  if (displaySelected.includes("proplane")) labels.push("PropLane");
  if (displaySelected.includes("email")) labels.push("Email");
  if (displaySelected.includes("sms")) labels.push("SMS");
  const selectionTriggerLabel =
    labels.length > 1 ? labels.join(" & ") : labels[0] ?? "PropLane";

  return (
    <div>
      <CheckboxMultiSelect
        label="Send via"
        labelClassName={portalMessageFieldLabel()}
        options={options}
        selected={displaySelected}
        selectionTriggerLabel={selectionTriggerLabel}
        onChange={(next) => {
          const enabled = next.filter(
            (value) =>
              value === "proplane" ||
              (value === "email" && emailAvailable) ||
              (value === "sms" && smsAvailable),
          );
          if (enabled.length === 0) return;
          onChange(enabled);
        }}
        disabled={disabled}
        emptyLabel="Choose channels…"
        dataAttr={dataAttr}
      />
      {footerNote?.trim() ? (
        <p className="mt-1.5 text-xs text-muted">{footerNote}</p>
      ) : null}
    </div>
  );
}

export function PortalMessageBodyField({
  id = "portal-message-body",
  value,
  onChange,
  disabled = false,
  readOnly = false,
  placeholder = "Write your message…",
  minHeightClass = "min-h-[9rem]",
  maxLength,
  dataAttr,
  showCharCount = false,
}: {
  id?: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  minHeightClass?: string;
  maxLength?: number;
  dataAttr?: string;
  showCharCount?: boolean;
}) {
  return (
    <div>
      <label className={portalMessageFieldLabel()} htmlFor={readOnly ? undefined : id}>
        Message
      </label>
      {readOnly || disabled ? (
        <pre
          className={cn(
            MODAL_INSET_BOX_CLASS,
            "mt-1 overflow-y-auto whitespace-pre-wrap py-2 text-sm leading-relaxed",
            minHeightClass,
            disabled ? "opacity-50" : "",
          )}
        >
          {value}
        </pre>
      ) : (
        <>
          <Textarea
            id={id}
            className={cn("mt-1 resize-y", minHeightClass)}
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            data-attr={dataAttr}
          />
          {showCharCount && maxLength ? (
            <span className="mt-1 block text-xs text-muted">{value.trim().length}/{maxLength}</span>
          ) : null}
        </>
      )}
    </div>
  );
}

export function PortalMessageScheduleFields({
  scheduleLater,
  onScheduleLaterChange,
  sendAt,
  onSendAtChange,
  disabled = false,
  scheduleDataAttr = "portal-message-schedule-later",
  sendAtDataAttr = "portal-message-schedule-at",
}: {
  scheduleLater: boolean;
  onScheduleLaterChange: (next: boolean) => void;
  sendAt: string;
  onSendAtChange: (next: string) => void;
  disabled?: boolean;
  scheduleDataAttr?: string;
  sendAtDataAttr?: string;
}) {
  if (disabled) return null;
  return (
    <div className="flex flex-nowrap items-center gap-3">
      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded border-border accent-primary"
          checked={scheduleLater}
          onChange={(e) => onScheduleLaterChange(e.target.checked)}
          data-attr={scheduleDataAttr}
        />
        <span className="font-medium text-foreground">Schedule for later</span>
      </label>
      {scheduleLater ? (
        <Input
          type="datetime-local"
          className="min-w-0 flex-1"
          value={sendAt}
          onChange={(e) => onSendAtChange(e.target.value)}
          aria-label="Send date and time"
          data-attr={sendAtDataAttr}
        />
      ) : null}
    </div>
  );
}
