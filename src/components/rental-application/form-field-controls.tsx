"use client";

/**
 * Wizard-free presentational form primitives shared by the applicant rental
 * wizard AND any other surface that renders an applicant-facing control (the
 * manager custom-question builder's live preview, for one) — no wizard form
 * state, just props in, markup out. Pulled out of `rental-wizard-steps.tsx`
 * (which used to define these locally) so a non-wizard surface can import
 * them without dragging that file's wizard-only imports along.
 */

import type { ReactNode } from "react";
import { wizardSectionErrorClass } from "@/lib/wizard-field-errors";

export function Label({
  children,
  required,
  optional,
  htmlFor,
}: {
  children: ReactNode;
  required?: boolean;
  optional?: boolean;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-semibold text-foreground">
      {children}
      {required ? <span className="text-primary"> *</span> : null}
      {optional ? <span className="pl-1 font-normal text-muted/70">(optional)</span> : null}
    </label>
  );
}

export function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1.5 text-sm text-red-600">{msg}</p>;
}

const pillWrap =
  "flex flex-wrap gap-2 rounded-full border border-border bg-accent/30 p-1 [html[data-theme=dark]_&]:border-white/12 [html[data-theme=dark]_&]:bg-white/6";
const pillActive =
  "rounded-full px-4 py-2.5 text-sm font-semibold bg-primary text-primary-foreground shadow-sm transition min-h-[44px] sm:min-h-0";
const pillIdle =
  "rounded-full px-4 py-2.5 text-sm font-semibold text-muted transition hover:bg-card hover:text-foreground min-h-[44px] sm:min-h-0 [html[data-theme=dark]_&]:text-white/72 [html[data-theme=dark]_&]:hover:bg-white/10 [html[data-theme=dark]_&]:hover:text-white";

export type YesNoValue = "yes" | "no" | null;

export function YesNoPills({
  value,
  onChange,
  error,
  name,
  fieldKey,
  suppressError = false,
  dataAttr,
}: {
  value: YesNoValue;
  onChange: (v: "yes" | "no") => void;
  error?: string;
  name: string;
  fieldKey?: string;
  /** When a parent row (e.g. ApplyFieldRow) renders the error message. */
  suppressError?: boolean;
  dataAttr?: string;
}) {
  return (
    <div data-wizard-field={fieldKey} className={wizardSectionErrorClass(Boolean(error))}>
      {/* aria-pressed is what tells a screen reader which pill is chosen — the
          active styling alone is invisible to assistive tech. */}
      <div className={pillWrap} role="group" aria-label={name}>
        <button
          type="button"
          aria-pressed={value === "yes"}
          className={value === "yes" ? pillActive : pillIdle}
          onClick={() => onChange("yes")}
          data-attr={dataAttr ? `${dataAttr}-yes` : undefined}
        >
          Yes
        </button>
        <button
          type="button"
          aria-pressed={value === "no"}
          className={value === "no" ? pillActive : pillIdle}
          onClick={() => onChange("no")}
          data-attr={dataAttr ? `${dataAttr}-no` : undefined}
        >
          No
        </button>
      </div>
      {suppressError ? null : <FieldError msg={error} />}
    </div>
  );
}
