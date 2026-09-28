/**
 * F004: groups a resolved application field list into the same "sections"
 * the Sections/Form steps already use (`RENTAL_APPLICATION_SECTIONS`), as
 * `ImportSection`s the shared diff can compare. Used for BOTH the template's
 * current field list and a freshly parsed (not-yet-applied) import's field
 * list, so "N sections found · N changed" and the compare view read the
 * exact same grouping the editor itself renders.
 */

import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import type { ImportSection } from "@/lib/import-staging/section-diff";

type FieldForDiff = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options?: readonly string[];
  section?: string;
};

function fieldSignature(field: FieldForDiff): string {
  return [field.id, field.label.trim(), field.type, field.required ? "required" : "optional", (field.options ?? []).join("|")].join("::");
}

export function applicationFieldsToImportSections(fields: readonly FieldForDiff[]): ImportSection[] {
  const bySection = new Map<string, FieldForDiff[]>();
  for (const field of fields) {
    const sectionId = field.section ?? "additional";
    const list = bySection.get(sectionId);
    if (list) list.push(field);
    else bySection.set(sectionId, [field]);
  }
  const sections: ImportSection[] = [];
  for (const section of RENTAL_APPLICATION_SECTIONS) {
    const fieldsInSection = bySection.get(section.id);
    if (!fieldsInSection || fieldsInSection.length === 0) continue;
    const body = fieldsInSection.map(fieldSignature).sort().join("\n");
    sections.push({ key: section.id, title: section.title, body });
  }
  // A field whose `.section` names something outside the known catalog
  // (should not happen, but a parsed import is untrusted input) still gets
  // its own bucket rather than being silently dropped from the diff.
  for (const [sectionId, fieldsInSection] of bySection) {
    if (RENTAL_APPLICATION_SECTIONS.some((s) => s.id === sectionId)) continue;
    const body = fieldsInSection.map(fieldSignature).sort().join("\n");
    sections.push({ key: sectionId, title: sectionId, body });
  }
  return sections;
}
