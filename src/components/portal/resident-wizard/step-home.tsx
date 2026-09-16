"use client";

import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { Input, Textarea } from "@/components/ui/input";
import {
  FieldMark,
  WizardChip,
  WizardField,
  WizardLine,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import type { AddPersonForm } from "./state";

export type PropertyOption = { id: string; label: string };

export function HomeStep({
  form,
  patch,
  derived,
  propertyOptions,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  derived: ResidentWizardDerived;
  propertyOptions: PropertyOption[];
}) {
  const prospect = form.kind === "prospect";
  const roomSuffix = (r: { monthlyRent?: number; shortTermRent?: string | number }) =>
    derived.isShortTerm ? (r.shortTermRent ? ` · $${r.shortTermRent}/night` : "") : r.monthlyRent ? ` · $${r.monthlyRent}/mo` : "";
  const rentModel = form.bundleId ? "bundle" : derived.rentedByRoom ? "room" : "whole";
  return (
    <StepColumn>
      <StepHeading title={prospect ? "What they're interested in" : "Where they live"} />
      <WizardSection title="Property" dataAttr="residents-wizard-home">
        <WizardRow cols={2}>
          <WizardSelect
            label={`Property${prospect ? "" : " *"}`}
            value={form.propertyId}
            onChange={(next) => patch({ propertyId: next, roomId: "", bundleId: "", marks: withoutMark(form.marks, "propertyId") })}
            options={propertyOptions.map((p) => ({ value: p.id, label: p.label }))}
            placeholder="Select property…"
            dataAttr="residents-wizard-property"
          />
          {derived.showRoomSelect ? (
            <WizardSelect
              label="Room"
              value={form.roomId}
              onChange={(next) => patch({ roomId: next, bundleId: "", marks: withoutMark(form.marks, "roomId") })}
              options={derived.roomOptions.map((r) => ({ value: r.id, label: `${r.name}${roomSuffix(r)}` }))}
              placeholder="Select room…"
              dataAttr="residents-wizard-room"
            />
          ) : derived.showBundleSelect ? (
            <WizardSelect
              label="Lease bundle"
              value={form.bundleId}
              onChange={(next) => patch({ bundleId: next, roomId: next ? "" : form.roomId })}
              options={[
                { value: "", label: derived.isShortTerm ? "None: standard short-term stay" : derived.rentedByRoom ? "None: assign a room" : "None: standard lease" },
                ...derived.bundleOptions,
              ]}
              dataAttr="residents-wizard-bundle"
            />
          ) : (
            <WizardSelect
              label="Placement"
              value="whole"
              onChange={() => undefined}
              options={[{ value: "whole", label: form.propertyId ? (derived.entireHome ? "The whole home" : derived.rentedByRoom ? "Add rooms on the listing first" : "The whole unit") : "Pick a property first" }]}
              disabled
              dataAttr="residents-wizard-placement"
            />
          )}
        </WizardRow>
        {form.marks.propertyId || form.marks.roomId ? (
          <div className="mt-2 flex gap-2">
            <FieldMark kind={form.marks.propertyId ?? form.marks.roomId} />
          </div>
        ) : null}
      </WizardSection>

      {!prospect ? (
        <WizardSection title="How they rent it" dataAttr="residents-wizard-rent-model">
          <WizardSelect
            label="Renting"
            value={rentModel}
            onChange={(next) => {
              if (next === "bundle") patch({ roomId: "", bundleId: derived.bundleOptions[0]?.value ?? "" });
              else if (next === "room") patch({ bundleId: "" });
              else patch({ bundleId: "", roomId: "" });
            }}
            options={[
              ...(derived.rentedByRoom ? [{ value: "room", label: "A room", hint: "rent, deposit and fees follow the room's listing" }] : []),
              ...(derived.showBundleSelect ? [{ value: "bundle", label: "A bundle", hint: "rooms this property offers together" }] : []),
              ...(!derived.rentedByRoom || !form.propertyId ? [{ value: "whole", label: "The whole place", hint: "one household, one rent" }] : []),
            ]}
            dataAttr="residents-wizard-rent-model-select"
          />
        </WizardSection>
      ) : (
        <WizardSection title="Looking for" dataAttr="residents-wizard-prospect-wants">
          <WizardRow cols={2}>
            <WizardField label="Move-in they want">
              <Input type="date" className="portal-modal-date-input" value={form.wantedMoveIn} onChange={(e) => patch({ wantedMoveIn: e.target.value })} data-attr="residents-wizard-wanted-move-in" />
            </WizardField>
            <WizardField label="Budget per month">
              <Input inputMode="decimal" value={form.budget} onChange={(e) => patch({ budget: e.target.value })} placeholder="900" data-attr="residents-wizard-budget" />
            </WizardField>
          </WizardRow>
          <div className="mt-3">
            <WizardField label="Notes for your team">
              <Textarea className="min-h-[72px]" value={form.prospectNotes} onChange={(e) => patch({ prospectNotes: e.target.value })} data-attr="residents-wizard-prospect-notes" />
            </WizardField>
          </div>
        </WizardSection>
      )}

      {!prospect && derived.listingSays ? (
        <WizardSection title="Listing says" chip={<WizardChip>defaults on Lease</WizardChip>}>
          <WizardLine label={derived.listingSays} />
        </WizardSection>
      ) : null}
    </StepColumn>
  );
}

function withoutMark(marks: AddPersonForm["marks"], key: string): AddPersonForm["marks"] {
  if (!marks[key]) return marks;
  const next = { ...marks };
  delete next[key];
  return next;
}
