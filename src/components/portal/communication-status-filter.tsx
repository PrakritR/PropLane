"use client";

import { FilterCollapsibleSection, FilterSingleSelectList } from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

export type CommunicationStatus = "active" | "read" | "unread" | "archived";

export function CommunicationStatusFilter({ value, onChange }: {
  value: CommunicationStatus;
  onChange: (value: CommunicationStatus) => void;
}) {
  return <FilterCollapsibleSection sectionId="status" label="Status"
    summary={value === "read" ? "Read" : value === "unread" ? "Unread" : value === "archived" ? "Archived" : "All conversations"}
    empty={value === "active"} menuOptionCount={4}>
    <FilterSingleSelectList options={[{ value: "active", label: "All conversations" }, { value: "read", label: "Read" }, { value: "unread", label: "Unread" }, { value: "archived", label: "Archived" }]}
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
