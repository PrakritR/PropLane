"use client";

import { FilterCollapsibleSection, FilterSingleSelectList } from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";
import { useScheduledSendCount } from "@/hooks/use-scheduled-send-count";

/**
 * `active` (the default) is every conversation that is not archived. `all` is
 * genuinely all of them, archived included — the option used to be labelled
 * "All conversations" while carrying the `active` value, so archived threads
 * could never be shown alongside the rest.
 *
 * Manager Communication drops Archived from this list: Active | Archived tabs
 * own the folder. Resident and vendor still pick Archived here.
 */
export type CommunicationStatus = "active" | "all" | "read" | "unread" | "archived" | "scheduled";

const COMMUNICATION_STATUS_OPTIONS: { value: CommunicationStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "all", label: "All conversations" },
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
  { value: "archived", label: "Archived" },
];

const MANAGER_COMMUNICATION_STATUS_OPTIONS: { value: CommunicationStatus; label: string }[] = [
  { value: "active", label: "All conversations" },
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
];

/**
 * The phone-only "Scheduled N" entry. Scheduled sends sit inline in their person's thread on every
 * width; this is the one list of them, reached from the Filter because a phone has no Schedule tab
 * (and the Active | Archived tabs never grow one).
 */
export function communicationScheduledOption(count: number): { value: CommunicationStatus; label: string } {
  return { value: "scheduled", label: count > 0 ? `Scheduled ${count}` : "Scheduled" };
}

export function communicationStatusLabel(
  value: CommunicationStatus,
  options: { value: CommunicationStatus; label: string }[] = COMMUNICATION_STATUS_OPTIONS,
): string {
  return options.find((option) => option.value === value)?.label ?? "Active";
}

export function CommunicationStatusFilter({
  value,
  onChange,
  hideArchived = false,
  showScheduled = false,
}: {
  value: CommunicationStatus;
  onChange: (value: CommunicationStatus) => void;
  hideArchived?: boolean;
  /** Phone-only: offer the Scheduled list view (manager Communication). */
  showScheduled?: boolean;
}) {
  const scheduledCount = useScheduledSendCount(showScheduled);
  const baseOptions = hideArchived ? MANAGER_COMMUNICATION_STATUS_OPTIONS : COMMUNICATION_STATUS_OPTIONS;
  const options = showScheduled ? [...baseOptions, communicationScheduledOption(scheduledCount)] : baseOptions;
  return (
    <FilterCollapsibleSection
      sectionId="status"
      label="Status"
      summary={communicationStatusLabel(value, options)}
      empty={value === "active"}
      menuOptionCount={options.length}
    >
      <FilterSingleSelectList
        options={options}
        value={value}
        onChange={(next) => onChange(next as CommunicationStatus)}
        dataAttr="communication-filter-status"
      />
    </FilterCollapsibleSection>
  );
}

export function CommunicationStatusFilterDraft({
  value,
  onChange,
  hideArchived = false,
}: {
  value: CommunicationStatus;
  onChange: (value: CommunicationStatus) => void;
  hideArchived?: boolean;
}) {
  const [draft, setDraft] = usePortalFilterDraft(value, onChange, "active");
  return <CommunicationStatusFilter value={draft} onChange={setDraft} hideArchived={hideArchived} />;
}
