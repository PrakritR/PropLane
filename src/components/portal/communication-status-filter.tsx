"use client";

import { FilterCollapsibleSection, FilterSingleSelectList } from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

/**
 * `active` (the default) is every conversation that is not archived. `all` is
 * genuinely all of them, archived included — the option used to be labelled
 * "All conversations" while carrying the `active` value, so archived threads
 * could never be shown alongside the rest.
 *
 * Manager Communication drops Archived from this list: Active | Archived tabs
 * own the folder. Resident and vendor still pick Archived here.
 */
export type CommunicationStatus = "active" | "all" | "read" | "unread" | "archived";

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
}: {
  value: CommunicationStatus;
  onChange: (value: CommunicationStatus) => void;
  hideArchived?: boolean;
}) {
  const options = hideArchived ? MANAGER_COMMUNICATION_STATUS_OPTIONS : COMMUNICATION_STATUS_OPTIONS;
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
