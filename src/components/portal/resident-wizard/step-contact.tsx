"use client";

import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  FieldMark,
  FileStartStrip,
  WizardField,
  WizardRow,
  WizardSection,
  type FileStripState,
} from "@/components/portal/add-workspace/parts";
import type { AddPersonForm } from "./state";

export const RESIDENT_FILE_ACCEPT = "application/pdf,image/*";
export const RESIDENT_FILE_CHIPS = ["application .pdf", "lease .pdf", "ID photo", "pay stub", "up to 3.5 MB each"] as const;

export function ContactStep({
  form,
  patch,
  strip,
  onPickFile,
  onUndoFill,
  busy,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  strip: FileStripState;
  onPickFile: (file: File) => void;
  onUndoFill: () => void;
  busy: boolean;
}) {
  const prospect = form.kind === "prospect";
  const touched = (key: string) => {
    if (!form.marks[key]) return;
    const marks = { ...form.marks };
    delete marks[key];
    patch({ marks });
  };
  return (
    <StepColumn>
      <StepHeading title={prospect ? "The prospect" : "The resident"} />
      <WizardSection title="Who are you adding?" dataAttr="residents-wizard-kind">
        <FieldSingleSelect
          label="Adding"
          value={form.kind}
          onChange={(next) => patch({ kind: next === "prospect" ? "prospect" : "resident" })}
          options={[
            { value: "resident", label: "A current resident", hint: "application · lease · payments · documents" },
            { value: "prospect", label: "A prospect", hint: "contact · tour" },
          ]}
          dataAttr="residents-wizard-kind-select"
        />
      </WizardSection>
      {!prospect ? (
        <FileStartStrip
          state={strip}
          chips={RESIDENT_FILE_CHIPS}
          accept={RESIDENT_FILE_ACCEPT}
          onPick={onPickFile}
          onUndo={onUndoFill}
          disabled={busy}
          dataAttr="residents-wizard-file"
        />
      ) : null}
      <WizardSection title="Contact" dataAttr="residents-wizard-contact">
        <WizardRow cols={2}>
          <WizardField label="Full name" required mark={<FieldMark kind={form.marks.name} />}>
            <Input
              value={form.name}
              onChange={(e) => {
                patch({ name: e.target.value });
                touched("name");
              }}
              placeholder="Jane Smith"
              data-attr="residents-wizard-name"
            />
          </WizardField>
          <WizardField label="Email" required={!prospect} mark={<FieldMark kind={form.marks.email} />}>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => {
                patch({ email: e.target.value });
                touched("email");
              }}
              placeholder="jane@example.com"
              data-attr="residents-wizard-email"
            />
          </WizardField>
          <WizardField label="Phone" mark={<FieldMark kind={form.marks.phone} />}>
            <PhoneNumberField
              value={form.phone}
              onChange={(next) => {
                patch({ phone: next });
                touched("phone");
              }}
              dataAttr="residents-wizard-phone"
            />
          </WizardField>
          <FieldSingleSelect
            label="Preferred contact"
            value={form.preferredContact}
            onChange={(next) => patch({ preferredContact: next === "sms" ? "sms" : "email" })}
            options={[
              { value: "email", label: "Email" },
              { value: "sms", label: "Text" },
            ]}
            dataAttr="residents-wizard-preferred-contact"
          />
        </WizardRow>
      </WizardSection>
    </StepColumn>
  );
}
