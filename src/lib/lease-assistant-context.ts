import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { PropertyLeaseSource } from "@/lib/property-lease-source";
import { propertyLeaseSourceLabel } from "@/lib/property-lease-source";
import { readLeaseSectionsForEdit } from "@/lib/lease-section-edit.client";
import type { PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";

/** Rich context for the property Lease editor modal assistant strip. */
export function buildLeaseModalAssistantContext(opts: {
  propertyId?: string | null;
  propertyIds?: string[];
  propertyLabel?: string | null;
  currentSource: PropertyLeaseSource;
  templateKind?: PropertyLeaseTemplateKind;
}): string {
  const ids =
    opts.propertyIds?.filter((id) => id.trim()).length
      ? opts.propertyIds!.filter((id) => id.trim())
      : opts.propertyId?.trim()
        ? [opts.propertyId.trim()]
        : [];
  const parts = ["Lease modal"];
  if (ids.length === 1) {
    parts.push(`propertyId=${ids[0]}`);
  } else if (ids.length > 1) {
    parts.push(`propertyIds=${ids.join(",")}`);
    parts.push("(bulk edit — section edits apply to one property at a time)");
  } else {
    parts.push("propertyId=(unknown — ask the manager which property)");
  }
  if (opts.propertyLabel?.trim()) parts.push(`property=${opts.propertyLabel.trim()}`);
  if (opts.templateKind) parts.push(`templateKind=${opts.templateKind}`);
  parts.push(`currentLeaseSource=${propertyLeaseSourceLabel(opts.currentSource)}`);
  parts.push(
    "When the manager asks to change lease wording, call list_property_lease_template_sections with propertyId and templateKind (short-term or long-term), then propose_property_lease_template_section_edit with plain-text section body — never HTML. Edits apply to the open Lease format editor after they confirm.",
  );
  parts.push(
    "For document source changes only (PropLane default vs upload), propose update_property_lease_config with propertyId.",
  );
  return parts.join(" · ");
}

/** Rich context for the Leases-page packet edit assistant (manager review). */
export function buildLeasePacketEditAssistantContext(row: LeasePipelineRow): string {
  const app = row.application ?? {};
  const parts = [
    `Lease packet edit`,
    `leaseId=${row.id}`,
    `resident=${row.residentName?.trim() || "Resident"}`,
  ];
  if (row.unit?.trim()) parts.push(`unit=${row.unit.trim()}`);
  if (app.managerRentOverride?.trim()) parts.push(`rent=${app.managerRentOverride.trim()}`);
  if (app.managerUtilitiesOverride?.trim()) parts.push(`utilities=${app.managerUtilitiesOverride.trim()}`);
  if (app.leaseTerm?.trim()) parts.push(`term=${app.leaseTerm.trim()}`);
  if (app.leaseStart?.trim()) parts.push(`start=${app.leaseStart.trim()}`);
  if (app.leaseEnd?.trim()) parts.push(`end=${app.leaseEnd.trim()}`);
  else if (app.leaseTerm?.toLowerCase().includes("month")) parts.push("end=month-to-month");
  if (app.rentalType === "short_term") parts.push("stay=short-term");
  const sections = readLeaseSectionsForEdit(row);
  if (sections.length) {
    parts.push(
      `documentSections=${sections.map((section) => `${section.id}:${section.title}`).join(";")}`,
    );
    parts.push(
      "UI: choose a section in the React-side section list to edit it as text or limited rich text.",
    );
    parts.push(
      "Use list_lease_sections, then propose_lease_section_edit with text or rich text for one editable section. Propose update_lease_packet for rent, fees, dates, term, room, stay type, unit label, or notes.",
    );
  } else {
    parts.push(
      "Propose update_lease_packet with this leaseId when the manager asks to change rent, fees, dates, term, room, stay type, unit label, or notes. The lease document regenerates and stays in manager review.",
    );
  }
  return parts.join(" · ");
}
