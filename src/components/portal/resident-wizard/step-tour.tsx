"use client";

import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import type { WorkAssignee } from "@/lib/work-assignment";
import { WizardChip, WizardField, WizardLine, WizardRow, WizardSection } from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import type { AddPersonForm } from "./state";

const DURATIONS = [
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "45", label: "45 min" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1½ hours" },
];

export function TourStep({
  form,
  patch,
  derived,
  managerUserId,
  assignee,
  onAssignee,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  derived: ResidentWizardDerived;
  managerUserId: string;
  assignee: WorkAssignee | null;
  onAssignee: (next: WorkAssignee | null) => void;
}) {
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId });
  const noTour = form.tourFormat === "none";
  return (
    <StepColumn>
      <StepHeading title="Tour" />
      <WizardSection title="Showing" dataAttr="residents-wizard-tour">
        <FieldSingleSelect
          label="Format"
          value={form.tourFormat}
          onChange={(next) => patch({ tourFormat: next === "virtual" ? "virtual" : next === "none" ? "none" : "in_person" })}
          options={[
            { value: "in_person", label: "In person", hint: "at the property" },
            { value: "virtual", label: "Virtual", hint: "video link sent with the confirmation" },
            { value: "none", label: "No tour yet", hint: "just keep them in Potential" },
          ]}
          dataAttr="residents-wizard-tour-format"
        />
        {!noTour ? (
          <div className="mt-3">
            <WizardRow cols={3}>
              <WizardField label="Date" required>
                <Input type="date" className="portal-modal-date-input" value={form.tourDate} onChange={(e) => patch({ tourDate: e.target.value })} data-attr="residents-wizard-tour-date" />
              </WizardField>
              <WizardField label="Start time" required>
                <Input type="time" value={form.tourStart} onChange={(e) => patch({ tourStart: e.target.value })} data-attr="residents-wizard-tour-start" />
              </WizardField>
              <FieldSingleSelect label="Duration" value={form.tourDurationMinutes} onChange={(next) => patch({ tourDurationMinutes: next })} options={DURATIONS} dataAttr="residents-wizard-tour-duration" />
            </WizardRow>
            <div className="mt-3">
              <WorkAssignmentPicker kind="tour" value={assignee} teamMembers={teamMembers} vendors={vendors} label="Shown by" dataAttr="residents-wizard-tour-assignee" onChange={onAssignee} />
            </div>
          </div>
        ) : null}
      </WizardSection>
      {!noTour ? (
        <WizardSection title="Room to show" chip={<WizardChip>from Home</WizardChip>}>
          <WizardLine label={derived.listingSays ?? (form.propertyId ? "The whole place" : "Pick a property on Home")} />
        </WizardSection>
      ) : null}
      {!noTour ? (
        <WizardSection title="Notes for the tour">
          <Textarea className="min-h-[72px]" value={form.tourNotes} onChange={(e) => patch({ tourNotes: e.target.value })} placeholder="Parking, which key, who to meet…" data-attr="residents-wizard-tour-notes" />
        </WizardSection>
      ) : null}
    </StepColumn>
  );
}
