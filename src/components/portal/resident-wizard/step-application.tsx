"use client";

/**
 * The property's own application, filled by the manager.
 *
 * Every question comes from the listing's application config — the standard
 * set minus what the manager disabled, plus their custom questions — so this
 * step asks exactly what an applicant would be asked. SSN, consents, signature
 * and the fee are never here: those stay the resident's.
 */

import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { Input, Textarea } from "@/components/ui/input";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import { isCustomFieldHiddenByCondition } from "@/lib/rental-application/custom-fields";
import {
  AddFoot,
  FieldMark,
  WizardChip,
  WizardField,
  WizardLine,
  WizardRow,
  WizardSection,
  WizardStepper,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import { customAnswersForRow, type AddPersonForm, type ApplicationAnswers, type ManagerApplicationTextKey } from "./state";

/**
 * Custom-question yes/no answers are stored lowercase ("yes"/"no") everywhere
 * else the same field type is rendered (the applicant wizard's
 * `CustomQuestionField`, `custom-fields.ts` validation/display) — that's also
 * what `field.showIf.equals` is authored against. Keep this wizard's checkbox
 * and yes_no custom questions on the same encoding so a gating answer here
 * actually satisfies a sibling's `showIf` and so a synced application record
 * displays the answer correctly.
 */
const CUSTOM_YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

const YES_NO = [
  { value: "No", label: "No" },
  { value: "Yes", label: "Yes" },
];
const RELATIONSHIPS = ["Parent", "Sibling", "Partner", "Friend", "Coworker", "Former landlord", "Other"].map((v) => ({ value: v, label: v }));
const PETS = [
  { value: "", label: "None" },
  { value: "1 cat", label: "1 cat" },
  { value: "2 cats", label: "2 cats" },
  { value: "1 dog", label: "1 dog" },
  { value: "2 dogs", label: "2 dogs" },
  { value: "Cat and dog", label: "Cat and dog" },
  { value: "Other", label: "Other" },
];
const EMPLOYMENT = [
  { value: "employed", label: "Employed" },
  { value: "self", label: "Self-employed" },
  { value: "not", label: "Not currently employed" },
  { value: "student", label: "Student" },
  { value: "retired", label: "Retired" },
];

export function ApplicationStep({
  form,
  patch,
  derived,
  propertyLabel,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  derived: ResidentWizardDerived;
  propertyLabel: string | null;
}) {
  const a = form.application;
  const on = derived.fieldEnabled;
  const set = (key: ManagerApplicationTextKey, value: string) => {
    const marks: AddPersonForm["marks"] = {};
    for (const [k, v] of Object.entries(form.marks)) if (k !== key) marks[k] = v;
    patch({ application: { ...a, [key]: value }, marks });
  };
  const text = (key: ManagerApplicationTextKey, label: string, placeholder?: string, type: "text" | "date" | "number" = "text") => (
    <WizardField label={label} mark={<FieldMark kind={form.marks[key]} />} key={key}>
      <Input
        type={type}
        inputMode={type === "number" ? "decimal" : undefined}
        className={type === "date" ? "portal-modal-date-input" : undefined}
        value={a[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
        data-attr={`residents-wizard-app-${key}`}
      />
    </WizardField>
  );
  const employmentStatus = a.notEmployed ? "not" : "employed";
  const showPrev = !a.noPreviousAddress && Boolean(a.prevStreet || a.prevCity || a.prevLandlordName || form.application.prevMoveIn) ;
  // Live conditional questions: a field with `showIf` (e.g. "if yes, explain")
  // hides until its controlling sibling matches, and re-evaluates on every
  // keystroke since `form.customAnswers` is part of the render dependency.
  const currentCustomAnswers = customAnswersForRow(form, derived.customQuestions);
  const custom = derived.customQuestions.filter((q) => !isCustomFieldHiddenByCondition(q, currentCustomAnswers));
  const bySection = (section: string) => custom.filter((q) => (q.section ?? "additional") === section);
  const filled = Object.values(a).some((v) => (typeof v === "string" ? v.trim() : Boolean(v)));

  return (
    <StepColumn>
      <StepHeading title="Application" />
      <WizardSection
        title={propertyLabel ? `${propertyLabel}'s application` : "This property's application"}
        chip={<WizardChip>{form.propertyId ? "edit questions on the listing" : "pick a property on Home"}</WizardChip>}
        dataAttr="residents-wizard-application-intro"
      >
        <WizardLine
          label={filled ? "The same sections an applicant answers, minus SSN, consent and signature." : "Optional — anything left blank stays blank on their Application tab."}
          chip={derived.isShortTerm || derived.isAirbnb ? <WizardChip>short-term form</WizardChip> : undefined}
        />
      </WizardSection>

      <WizardSection title="About them" dataAttr="residents-wizard-app-about">
        <WizardRow cols={2}>
          {on("dateOfBirth") ? text("dateOfBirth", "Date of birth", undefined, "date") : null}
          {on("driversLicense") ? text("driversLicense", "Driver's license / ID number", "WA · number") : null}
        </WizardRow>
        <div className="mt-2">
          {on("occupancyCount") ? (
            <WizardLine
              label="People living here"
              control={
                <WizardStepper
                  label="people"
                  min={1}
                  max={12}
                  value={Math.max(1, Number(a.occupancyCount) || 1)}
                  onChange={(n) => set("occupancyCount", String(n))}
                  dataAttr="residents-wizard-app-occupants"
                />
              }
            />
          ) : null}
          {on("pets") ? (
            <WizardLine
              label="Pets"
              chip={<FieldMark kind={form.marks.pets} />}
              control={
                <span className="w-[200px]">
                  <WizardSelect
                    label="Pets"
                    hideLabel
                    value={PETS.some((p) => p.value === (a.pets ?? "")) ? (a.pets ?? "") : "Other"}
                    onChange={(next) => set("pets", next)}
                    options={PETS}
                    variant="cell"
                    dataAttr="residents-wizard-app-pets"
                  />
                </span>
              }
            />
          ) : null}
          <WizardLine
            label="Vehicles"
            control={<WizardStepper label="vehicles" max={6} value={form.vehicles} onChange={(n) => patch({ vehicles: n })} dataAttr="residents-wizard-app-vehicles" />}
          />
        </div>
        {bySection("personal").length ? <CustomQuestions questions={bySection("personal")} form={form} patch={patch} /> : null}
      </WizardSection>

      {on("employer") || on("monthlyIncome") ? (
        <WizardSection title="Employment & income" dataAttr="residents-wizard-app-employment">
          <div className="mb-3">
            <WizardSelect
              label="Employment status"
              value={employmentStatus}
              onChange={(next) => patch({ application: { ...a, notEmployed: next === "not" } })}
              options={EMPLOYMENT}
              dataAttr="residents-wizard-app-employment-status"
            />
          </div>
          {!a.notEmployed ? (
            <WizardRow cols={2}>
              {on("employer") ? text("employer", "Employer", "Company") : null}
              {on("jobTitle") ? text("jobTitle", "Job title", "Title") : null}
              {on("monthlyIncome") ? text("monthlyIncome", "Monthly income", "5400", "number") : null}
              {on("employmentStart") ? text("employmentStart", "Employed since", "06/2022") : null}
              {on("employerAddress") ? text("employerAddress", "Employer address", "Street, city") : null}
              {on("supervisorName") ? text("supervisorName", "Supervisor", "Name") : null}
              {on("supervisorPhone") ? text("supervisorPhone", "Supervisor phone", "(206) 555-0123") : null}
              {on("otherIncome") ? text("otherIncome", "Other income per month", "0", "number") : null}
            </WizardRow>
          ) : (
            <WizardRow cols={2}>{on("otherIncome") ? text("otherIncome", "Income per month", "0", "number") : null}</WizardRow>
          )}
          {bySection("employment").length ? <CustomQuestions questions={bySection("employment")} form={form} patch={patch} /> : null}
        </WizardSection>
      ) : null}

      {on("currentStreet") || on("currentLandlordName") ? (
        <WizardSection title="Current address" dataAttr="residents-wizard-app-current-address">
          <WizardRow cols={2}>
            {on("currentStreet") ? text("currentStreet", "Street", "1180 Harrison St, Apt 4") : null}
            {on("currentCity") ? text("currentCity", "City", "Seattle") : null}
            {on("currentState") ? text("currentState", "State", "WA") : null}
            {on("currentZip") ? text("currentZip", "ZIP", "98109") : null}
            {on("currentLandlordName") ? text("currentLandlordName", "Landlord", "Name") : null}
            {on("currentLandlordPhone") ? text("currentLandlordPhone", "Landlord phone", "(206) 555-0110") : null}
            {on("currentMoveIn") ? text("currentMoveIn", "Lived here from", undefined, "date") : null}
            {on("currentMoveOut") ? text("currentMoveOut", "Lived here to", undefined, "date") : null}
          </WizardRow>
          {on("currentReasonLeaving") ? <div className="mt-3">{text("currentReasonLeaving", "Reason for leaving", "Optional")}</div> : null}
          {bySection("current_address").length ? <CustomQuestions questions={bySection("current_address")} form={form} patch={patch} /> : null}
          {on("prevStreet") && !showPrev ? (
            <AddFoot label="+ Add previous address" onClick={() => patch({ application: { ...a, noPreviousAddress: false, prevStreet: a.prevStreet || " " } })} dataAttr="residents-wizard-app-add-previous" />
          ) : null}
        </WizardSection>
      ) : null}

      {on("prevStreet") && showPrev ? (
        <WizardSection
          title="Previous address"
          chip={
            <button
              type="button"
              className="text-[12.5px] font-bold text-primary"
              onClick={() =>
                patch({
                  application: {
                    ...a,
                    prevStreet: "",
                    prevCity: "",
                    prevState: "",
                    prevZip: "",
                    prevLandlordName: "",
                    prevLandlordPhone: "",
                    prevMoveIn: "",
                    prevMoveOut: "",
                    prevReasonLeaving: "",
                    noPreviousAddress: true,
                  },
                })
              }
            >
              Remove
            </button>
          }
          dataAttr="residents-wizard-app-previous-address"
        >
          <WizardRow cols={2}>
            {text("prevStreet", "Street")}
            {text("prevCity", "City")}
            {text("prevState", "State")}
            {text("prevZip", "ZIP")}
            {on("prevLandlordName") ? text("prevLandlordName", "Landlord", "Name") : null}
            {on("prevLandlordPhone") ? text("prevLandlordPhone", "Landlord phone") : null}
            {on("prevMoveIn") ? text("prevMoveIn", "Lived there from", undefined, "date") : null}
            {on("prevMoveOut") ? text("prevMoveOut", "Lived there to", undefined, "date") : null}
          </WizardRow>
          {on("prevReasonLeaving") ? <div className="mt-3">{text("prevReasonLeaving", "Reason for leaving", "Optional")}</div> : null}
          {bySection("previous_address").length ? <CustomQuestions questions={bySection("previous_address")} form={form} patch={patch} /> : null}
        </WizardSection>
      ) : null}

      {on("ref1Name") || on("ref2Name") ? (
        <WizardSection title="References & emergency contact" dataAttr="residents-wizard-app-references">
          {on("ref1Name") ? (
            <WizardRow cols={3}>
              {text("ref1Name", "Name", "Reference 1")}
              <WizardSelect label="Relationship" value={a.ref1Relationship ?? ""} onChange={(next) => set("ref1Relationship", next)} options={RELATIONSHIPS} placeholder="Select…" dataAttr="residents-wizard-app-ref1Relationship" />
              {text("ref1Phone", "Phone", "(206) 555-0123")}
            </WizardRow>
          ) : null}
          {on("ref2Name") ? (
            <div className="mt-3">
              <WizardRow cols={3}>
                {text("ref2Name", "Name", "Reference 2")}
                <WizardSelect label="Relationship" value={a.ref2Relationship ?? ""} onChange={(next) => set("ref2Relationship", next)} options={RELATIONSHIPS} placeholder="Select…" dataAttr="residents-wizard-app-ref2Relationship" />
                {text("ref2Phone", "Phone", "(206) 555-0123")}
              </WizardRow>
            </div>
          ) : null}
          {bySection("references").length ? <CustomQuestions questions={bySection("references")} form={form} patch={patch} /> : null}
        </WizardSection>
      ) : null}

      {on("evictionHistory") || on("bankruptcyHistory") || on("criminalHistory") ? (
        <WizardSection title="Disclosures" dataAttr="residents-wizard-app-disclosures">
          {(
            [
              ["evictionHistory", "evictionDetails", "Prior eviction"],
              ["bankruptcyHistory", "bankruptcyDetails", "Bankruptcy"],
              ["criminalHistory", "criminalDetails", "Criminal history"],
            ] as const
          )
            .filter(([key]) => on(key))
            .map(([key, detailsKey, label]) => (
              <div key={key}>
                <WizardLine
                  label={label}
                  chip={<FieldMark kind={form.marks[key]} />}
                  control={
                    <span className="w-[140px]">
                      <WizardSelect label={label} hideLabel value={a[key] ?? "No"} onChange={(next) => set(key, next)} options={YES_NO} variant="cell" dataAttr={`residents-wizard-app-${key}`} />
                    </span>
                  }
                />
                {a[key] === "Yes" ? <div className="pb-3">{text(detailsKey, `${label} — details`, "What happened, when, and how it was resolved")}</div> : null}
              </div>
            ))}
        </WizardSection>
      ) : null}

      {bySection("additional").length || bySection("household").length || bySection("property").length ? (
        <WizardSection title={propertyLabel ? `${propertyLabel} asks` : "This listing asks"} chip={<WizardChip>{custom.length} custom {custom.length === 1 ? "question" : "questions"}</WizardChip>} dataAttr="residents-wizard-app-custom">
          <CustomQuestions questions={[...bySection("household"), ...bySection("property"), ...bySection("additional")]} form={form} patch={patch} />
        </WizardSection>
      ) : null}

      <WizardSection title="Notes for your team" chip={<WizardChip>never shown to the resident</WizardChip>} dataAttr="residents-wizard-notes">
        <Textarea className="min-h-[72px]" value={form.notes} onChange={(e) => patch({ notes: e.target.value })} data-attr="residents-wizard-notes-input" />
      </WizardSection>
    </StepColumn>
  );
}

function CustomQuestions({
  questions,
  form,
  patch,
}: {
  questions: ManagerCustomApplicationField[];
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
}) {
  const set = (key: string, value: string) => patch({ customAnswers: { ...form.customAnswers, [key]: value } });
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {questions.map((q) => {
        const value = form.customAnswers[q.key] ?? "";
        if (q.type === "select" || q.type === "multi_select") {
          return (
            <WizardSelect
              key={q.id}
              label={q.label}
              value={value}
              onChange={(next) => set(q.key, next)}
              options={q.options.map((o) => ({ value: o, label: o }))}
              placeholder="Select…"
              dataAttr={`residents-wizard-custom-${q.key}`}
            />
          );
        }
        if (q.type === "checkbox" || q.type === "yes_no") {
          return (
            <WizardSelect
              key={q.id}
              label={q.label}
              value={value}
              onChange={(next) => set(q.key, next)}
              options={CUSTOM_YES_NO}
              placeholder="Select…"
              dataAttr={`residents-wizard-custom-${q.key}`}
            />
          );
        }
        return (
          <WizardField key={q.id} label={q.label} className={q.type === "long_text" ? "sm:col-span-2" : undefined}>
            {q.type === "long_text" ? (
              <Textarea className="min-h-[72px]" value={value} onChange={(e) => set(q.key, e.target.value)} data-attr={`residents-wizard-custom-${q.key}`} />
            ) : (
              <Input type={q.type === "date" ? "date" : "text"} inputMode={q.type === "number" ? "decimal" : undefined} value={value} onChange={(e) => set(q.key, e.target.value)} data-attr={`residents-wizard-custom-${q.key}`} />
            )}
          </WizardField>
        );
      })}
    </div>
  );
}

export type { ApplicationAnswers };
