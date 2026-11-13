"use client";

import { useContext, useId, useState } from "react";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { WizardInvalidFields } from "@/components/portal/add-workspace/validation";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  FieldMark,
  FileStartStrip,
  WizardField,
  WizardRow,
  WizardSection,
  type FileStripState,
  WizardMultiSelect,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import {
  ALSO_CREATE_OPTIONS,
  defaultAlsoCreate,
  normalizeAlsoCreate,
  phoneIsAnswered,
  PHONE_REQUIRED_MESSAGE,
  type AddPersonForm,
} from "./state";
import { REACH_CHANNELS, REACH_CHANNEL_LABELS, normalizeReachBy, type ReachChannel } from "@/lib/recipient-channels";

export const RESIDENT_FILE_ACCEPT = "application/pdf,image/*";

export function ContactStep({
  form,
  patch,
  strip,
  onPickFile,
  onUndoFill,
  busy,
  lockKind = false,
  mode = "person",
  editing = false,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  strip: FileStripState;
  onPickFile: (file: File) => void;
  onUndoFill: () => void;
  busy: boolean;
  /** Tours door: the kind is fixed to prospect and the picker is not shown. */
  lockKind?: boolean;
  mode?: "person" | "tour" | "application";
  /** The Edit resident pop-up: a resident who already has no phone on file is not blocked by the new requirement. */
  editing?: boolean;
}) {
  const prospect = form.kind === "prospect";
  const phoneId = useId();
  const invalidFields = useContext(WizardInvalidFields);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const needsPhone = !prospect && mode === "person" && !editing;
  const phoneMissing = needsPhone && !phoneIsAnswered(form);
  const showPhoneError = phoneMissing && (phoneTouched || invalidFields.has(phoneId));
  const hasPhone = Boolean(form.phone.trim());
  const reachSelected = (normalizeReachBy(form.reachBy) ?? REACH_CHANNELS).filter((channel) => hasPhone || channel !== "sms");
  const touched = (key: string) => {
    if (!form.marks[key]) return;
    const marks = { ...form.marks };
    delete marks[key];
    patch({ marks });
  };
  return (
    <StepColumn>
      <StepHeading title={mode === "application" ? "The applicant" : lockKind ? "The guest" : prospect ? "The prospect" : "The resident"} />
      {lockKind ? null : (
      <WizardSection title="Who are you adding?" dataAttr="residents-wizard-kind">
        <WizardSelect
          label="Adding"
          value={form.kind}
          onChange={(next) => {
            const kind = next === "prospect" ? "prospect" : "resident";
            patch({ kind, alsoCreate: defaultAlsoCreate(kind) });
          }}
          options={[
            { value: "resident", label: "A current resident" },
            { value: "prospect", label: "A prospect" },
          ]}
          dataAttr="residents-wizard-kind-select"
        />
        {!prospect && mode !== "application" ? (
          <div className="mt-3">
            <WizardMultiSelect
              label="Also create"
              options={[...ALSO_CREATE_OPTIONS]}
              selected={form.alsoCreate}
              onChange={(next) => patch({ alsoCreate: normalizeAlsoCreate(next, "resident") })}
              dataAttr="residents-wizard-also-create"
              emptyLabel="Lease"
            />
          </div>
        ) : null}
      </WizardSection>
      )}
      {!prospect || mode === "application" ? (
        <FileStartStrip
          state={strip}
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
              required
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
              required={!prospect}
              value={form.email}
              onChange={(e) => {
                patch({ email: e.target.value });
                touched("email");
              }}
              placeholder="jane@example.com"
              data-attr="residents-wizard-email"
            />
          </WizardField>
          <div data-wizard-field={phoneId} data-wizard-label="Phone" data-wizard-required={phoneMissing} data-wizard-empty={phoneMissing}>
            <span className="mb-[5px] flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
              Phone{needsPhone ? <span className="sr-only"> (required)</span> : null}
              <span className="ml-1 inline-flex font-normal"><FieldMark kind={form.marks.phone} /></span>
            </span>
            <PhoneNumberField
              value={form.phone}
              onChange={(next) => {
                patch({ phone: next, ...(next.trim() ? { noPhone: false } : {}) });
                touched("phone");
              }}
              onBlur={() => setPhoneTouched(true)}
              dataAttr="residents-wizard-phone"
            />
            {!prospect ? (
              <label className="mt-2 flex items-center gap-2 text-[13px] text-foreground">
                <input
                  type="checkbox"
                  checked={form.noPhone && !hasPhone}
                  disabled={hasPhone}
                  onChange={(e) => patch({ noPhone: e.target.checked })}
                  className="size-4 accent-primary"
                  data-attr="residents-wizard-no-phone"
                />
                No phone
              </label>
            ) : null}
            {showPhoneError ? <span role="alert" className="mt-1 block text-xs font-semibold text-destructive" data-attr="residents-wizard-phone-error">{PHONE_REQUIRED_MESSAGE}</span> : null}
          </div>
          <WizardSelect
            label="Preferred contact"
            value={form.preferredContact}
            onChange={(next) => patch({ preferredContact: next === "sms" ? "sms" : "email" })}
            options={[
              { value: "email", label: "Email" },
              { value: "sms", label: "Text" },
            ]}
            dataAttr="residents-wizard-preferred-contact"
          />
          <WizardMultiSelect
            label="Reach by"
            options={REACH_CHANNELS.map((channel) => ({ value: channel, label: REACH_CHANNEL_LABELS[channel], disabled: channel === "app" || (channel === "sms" && !hasPhone) }))}
            selected={["app", ...reachSelected.filter((channel) => channel !== "app")]}
            onChange={(next) => patch({ reachBy: ["app", ...next.filter((value): value is ReachChannel => value === "email" || value === "sms")] })}
            dataAttr="residents-wizard-reach-by"
            emptyLabel="App"
          />
        </WizardRow>
      </WizardSection>
    </StepColumn>
  );
}
