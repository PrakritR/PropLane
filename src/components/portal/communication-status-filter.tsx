"use client";

import { FilterCollapsibleSection, FilterSingleSelectList } from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

/**
 * `active` (the default) is every conversation that is not archived. `all` is
 * genuinely all of them, archived included — the option used to be labelled
 * "All conversations" while carrying the `active` value, so archived threads
 * could never be shown alongside the rest.
 */
export type CommunicationStatus = "active" | "all" | "read" | "unread" | "archived";

const COMMUNICATION_STATUS_OPTIONS: { value: CommunicationStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "all", label: "All conversations" },
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
  { value: "archived", label: "Archived" },
];

export function communicationStatusLabel(value: CommunicationStatus): string {
  return COMMUNICATION_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? "Active";
}

export function CommunicationStatusFilter({ value, onChange }: {
  value: CommunicationStatus;
  onChange: (value: CommunicationStatus) => void;
}) {
  return <FilterCollapsibleSection sectionId="status" label="Status"
    summary={communicationStatusLabel(value)}
    empty={value === "active"} menuOptionCount={COMMUNICATION_STATUS_OPTIONS.length}>
    <FilterSingleSelectList options={COMMUNICATION_STATUS_OPTIONS}
      value={value} onChange={(next) => onChange(next as CommunicationStatus)} dataAttr="communication-filter-status" />
  </FilterCollapsibleSection>;
}

export function CommunicationStatusFilterDraft({ value, onChange }: {
  value: CommunicationStatus;
  onChange: (value: CommunicationStatus) => void;
}) {
  const [draft, setDraft] = usePortalFilterDraft(value, onChange, "active");
  return <CommunicationStatusFilter value={draft} onChange={setDraft} />;
}
