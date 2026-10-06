"use client";

import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { WorkspaceFileCard } from "@/components/portal/add-workspace/upload-action";
import { DocumentRow, WizardChip, WizardLine, WizardSection } from "@/components/portal/add-workspace/parts";
import type { AddPersonForm } from "./state";
import { RESIDENT_FILE_ACCEPT, RESIDENT_STEP_FILE_CHIPS } from "./step-contact";

export const RESIDENT_DOCUMENT_KINDS = [
  { value: "application", label: "Application" },
  { value: "lease_signed", label: "Lease · signed" },
  { value: "lease_draft", label: "Lease · draft" },
  { value: "id_front", label: "ID · front" },
  { value: "id_back", label: "ID · back" },
  { value: "income_proof", label: "Proof of income" },
  { value: "other", label: "Other documents" },
];

export function DocumentsStep({
  form,
  patch,
  onPickFile,
  busy,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  onPickFile: (file: File) => void;
  busy: boolean;
}) {
  return (
    <StepColumn>
      <StepHeading title="Documents" />
      <WorkspaceFileCard accept={RESIDENT_FILE_ACCEPT} chips={RESIDENT_STEP_FILE_CHIPS} onPick={onPickFile} disabled={busy} dataAttr="residents-wizard-documents-upload" inputDataAttr="residents-wizard-documents-input" />
      <WizardSection title="Attached" chip={<WizardChip>private · you and this resident only</WizardChip>} dataAttr="residents-wizard-documents">
        {form.documents.length === 0 ? (
          <WizardLine label="Nothing attached yet — an application, lease, ID photo or proof of income. PDFs are read to fill the sections; images are kept as evidence." />
        ) : (
          form.documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              kinds={RESIDENT_DOCUMENT_KINDS}
              onKind={(kind) => patch({ documents: form.documents.map((d) => (d.id === doc.id ? { ...d, kind } : d)) })}
              onRemove={() => patch({ documents: form.documents.filter((d) => d.id !== doc.id) })}
              badge={doc.note ? <WizardChip tone="ok">read</WizardChip> : undefined}
            />
          ))
        )}
      </WizardSection>
      <WizardSection title="Where each one goes">
        <WizardLine label={<><b>Application PDF</b> — read, then kept on the application</>} chip={<WizardChip>application documents</WizardChip>} />
        <WizardLine label={<><b>Lease PDF</b> — read, then filed as the signed or draft lease</>} chip={<WizardChip>lease pipeline</WizardChip>} />
        <WizardLine label={<><b>ID front / back</b> — the same slots the applicant&apos;s own form fills</>} chip={<WizardChip>verification photos</WizardChip>} />
        <WizardLine label={<><b>Proof of income</b> — up to 5, the applicant&apos;s own slot</>} chip={<WizardChip>verification photos</WizardChip>} />
      </WizardSection>
    </StepColumn>
  );
}
