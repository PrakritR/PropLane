"use client";

/**
 * One manager-defined application question, rendered by its configured type —
 * shared by the applicant rental wizard AND (a manager-facing live preview
 * will render it too, so the builder's "Applicant sees" block and the real
 * wizard can never drift). Free of any wizard-only import: no wizard form
 * state here, just props in, markup out.
 */

import { Label, FieldError, YesNoPills } from "@/components/rental-application/form-field-controls";
import { Input, Select, Textarea } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { InlineCheckboxGroup } from "@/components/ui/inline-checkbox-group";
import { ApplicationPhotoField } from "@/components/marketing/application-photo-field";
import { imageOnlyAccept } from "@/lib/rental-application/application-photos";
import {
  customFieldErrorKey,
  encodeCustomFieldAttachment,
  encodeMultiSelectAnswer,
  isFileCustomFieldType,
  parseCustomFieldAttachment,
  parseMultiSelectAnswer,
} from "@/lib/rental-application/custom-fields";
import { maskPhoneInput } from "@/lib/rental-application/masks";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";

export type CustomQuestionFieldProps = {
  field: ManagerCustomApplicationField;
  value: string;
  error?: string;
  onChange: (next: string) => void;
  /**
   * Only required for `field.type === "file" | "photos"` — threaded straight
   * through to {@link ApplicationPhotoField}, which mints/reads the stable
   * application id and (for a guest) the resident-setup token the upload is
   * authorized by.
   */
  getApplicationId?: () => string;
  setupTokenRequired?: boolean;
  getSetupToken?: () => string | null;
  readOnly?: boolean;
};

/** Manager-authored help text under a question's label — never question text or answers, just this copy. */
function FieldDescription({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="text-xs text-muted">{text}</p>;
}

/**
 * Additive read-only wrapper: renders the exact same real control (so a
 * builder preview never drifts from the applicant wizard) but strips
 * interaction. `pointer-events-none` blocks clicks/taps; `inert` (React 19,
 * ignored by older engines) additionally drops it from tab order and the
 * accessibility tree, since a read-only preview has nothing to submit.
 * Existing (non-`readOnly`) callers are unaffected — this only wraps output
 * when the caller opts in.
 */
export function CustomQuestionField(props: CustomQuestionFieldProps) {
  const rendered = <CustomQuestionFieldControl {...props} />;
  if (!props.readOnly) return rendered;
  return (
    <div className="pointer-events-none" inert>
      {rendered}
    </div>
  );
}

function CustomQuestionFieldControl({
  field,
  value,
  error,
  onChange,
  getApplicationId,
  setupTokenRequired,
  getSetupToken,
  readOnly,
}: CustomQuestionFieldProps) {
  const inputId = `custom-${field.key}`;
  const errorClass = error ? "border-red-400 ring-2 ring-red-100" : "";

  if (isFileCustomFieldType(field.type)) {
    return (
      <div className="space-y-2" data-wizard-field={customFieldErrorKey(field.key)}>
        <ApplicationPhotoField
          slot="custom"
          fieldKey={field.key}
          label={`${field.label}${field.required ? " *" : " (optional)"}`}
          hint={field.description}
          // A `photos` question is images only; `file` keeps the `custom` slot's
          // own image+PDF allowance (acceptForSlot("custom")) as the picker default.
          accept={field.type === "photos" ? imageOnlyAccept() : undefined}
          attachment={parseCustomFieldAttachment(value)}
          onChange={(next) => onChange(encodeCustomFieldAttachment(next))}
          getApplicationId={getApplicationId ?? (() => "")}
          setupTokenRequired={setupTokenRequired}
          getSetupToken={getSetupToken}
          uploadOnly={field.type === "file"}
          readOnly={readOnly}
          dataAttr={`application-custom-file-${field.key}`}
        />
        <FieldError msg={error} />
      </div>
    );
  }

  if (field.type === "checkbox") {
    return (
      <div className="space-y-2" data-wizard-field={customFieldErrorKey(field.key)}>
        <label
          className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 ${
            error ? "border-red-300 bg-red-50/50 ring-2 ring-red-100" : "border-border"
          }`}
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border text-primary"
            checked={value === "yes"}
            onChange={(e) => onChange(e.target.checked ? "yes" : "")}
          />
          <span className="text-sm font-medium text-foreground">
            {field.label}
            {field.required ? <span className="text-primary"> *</span> : null}
          </span>
        </label>
        <FieldDescription text={field.description} />
        <FieldError msg={error} />
      </div>
    );
  }

  if (field.type === "yes_no") {
    return (
      <div className="space-y-2" data-wizard-field={customFieldErrorKey(field.key)}>
        <Label required={field.required} optional={!field.required}>
          {field.label}
        </Label>
        <FieldDescription text={field.description} />
        <YesNoPills
          value={value === "yes" ? "yes" : value === "no" ? "no" : null}
          onChange={onChange}
          name={field.label}
          suppressError
          dataAttr={`application-custom-yesno-${field.key}`}
        />
        <FieldError msg={error} />
      </div>
    );
  }

  if (field.type === "multi_select") {
    return (
      <div className="space-y-2" data-wizard-field={customFieldErrorKey(field.key)}>
        <Label required={field.required} optional={!field.required}>
          {field.label}
        </Label>
        <FieldDescription text={field.description} />
        <InlineCheckboxGroup
          label={field.label}
          hideLabel
          columns={1}
          options={field.options.map((opt) => ({ value: opt, label: opt }))}
          selected={parseMultiSelectAnswer(value)}
          onChange={(next) => onChange(encodeMultiSelectAnswer(next))}
          dataAttr={`application-custom-multiselect-${field.key}`}
        />
        <FieldError msg={error} />
      </div>
    );
  }

  return (
    <div className="space-y-2" data-wizard-field={customFieldErrorKey(field.key)}>
      <Label htmlFor={inputId} required={field.required} optional={!field.required}>
        {field.label}
      </Label>
      <FieldDescription text={field.description} />
      {field.type === "select" ? (
        <Select id={inputId} value={value} onChange={(e) => onChange(e.target.value)} className={errorClass}>
          <option value="">Select</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      ) : field.type === "date" ? (
        <DateField id={inputId} value={value} onChange={onChange} className={errorClass} />
      ) : field.type === "long_text" ? (
        <Textarea
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={errorClass}
          data-attr={`application-custom-longtext-${field.key}`}
        />
      ) : field.type === "currency" ? (
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">
            $
          </span>
          <Input
            id={inputId}
            inputMode="decimal"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`pl-8 ${errorClass}`.trim()}
            data-attr={`application-custom-currency-${field.key}`}
          />
        </div>
      ) : field.type === "phone" ? (
        <Input
          id={inputId}
          inputMode="tel"
          value={value}
          onChange={(e) => onChange(maskPhoneInput(value, e.target.value))}
          className={errorClass}
          data-attr={`application-custom-phone-${field.key}`}
        />
      ) : field.type === "email" ? (
        <Input
          id={inputId}
          type="email"
          inputMode="email"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={errorClass}
          data-attr={`application-custom-email-${field.key}`}
        />
      ) : (
        <Input
          id={inputId}
          inputMode={field.type === "number" ? "decimal" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={errorClass}
        />
      )}
      <FieldError msg={error} />
    </div>
  );
}
