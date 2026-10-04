"use client";

import { Upload } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { cn } from "@/lib/utils";

export type PropertyFormStartFrom = "proplane" | "upload" | "copy";

export const PROPERTY_FORM_START_FROM_OPTIONS: { value: PropertyFormStartFrom; label: string }[] = [
  { value: "proplane", label: "PropLane standard" },
  { value: "upload", label: "Upload a PDF" },
  { value: "copy", label: "Copy existing" },
];

/** Room-pricing-style row: label left, control right. */
export function PropertyFormWizardRow({
  label,
  children,
  className,
  dataAttr,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  dataAttr?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center justify-between gap-3 border-b border-border/80 py-2.5 last:border-b-0",
        className,
      )}
      data-attr={dataAttr}
    >
      <span className={cn(WIZARD_LABEL_CLASS, "shrink-0")}>{label}</span>
      <div className="min-w-0 flex-1 text-right">{children}</div>
    </div>
  );
}

export function PropertyFormWizardFact({
  children,
  dataAttr,
}: {
  children: React.ReactNode;
  dataAttr?: string;
}) {
  return (
    <span className="text-sm font-semibold text-foreground" data-attr={dataAttr}>
      {children}
    </span>
  );
}

export function PropertyFormStartFromFact({
  label,
  onReplace,
  replaceLabel = "Replace",
  replaceDataAttr,
  factDataAttr,
}: {
  label: string;
  onReplace?: () => void;
  replaceLabel?: string;
  replaceDataAttr?: string;
  factDataAttr?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <PropertyFormWizardFact dataAttr={factDataAttr}>{label}</PropertyFormWizardFact>
      {onReplace ? (
        <PortalIconAction
          ring
          icon={Upload}
          label={replaceLabel}
          data-attr={replaceDataAttr}
          onClick={onReplace}
        />
      ) : null}
    </div>
  );
}

export function PropertyFormStartFromSelect({
  value,
  onChange,
  disabled,
  dataAttr = "property-form-start-from",
}: {
  value: PropertyFormStartFrom;
  onChange: (next: PropertyFormStartFrom) => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <FieldSingleSelect
      hideLabel
      label="Start from"
      labelClassName={WIZARD_LABEL_CLASS}
      variant="cell"
      className="min-w-[200px] max-w-[280px]"
      value={value}
      options={PROPERTY_FORM_START_FROM_OPTIONS}
      onChange={(next) => onChange(next as PropertyFormStartFrom)}
      disabled={disabled}
      dataAttr={dataAttr}
    />
  );
}

export function PropertyFormWizardCard({ children, dataAttr }: { children: React.ReactNode; dataAttr?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-3.5 py-1" data-attr={dataAttr}>
      {children}
    </div>
  );
}
