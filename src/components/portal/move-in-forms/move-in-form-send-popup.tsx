"use client";

/**
 * Send a move-in form by hand: pick a current resident, pick one of that property's forms, set a due date, send. The same popup frame as the viewer; the right-hand panel shows
 * what the resident gets. Forms are read from the resident's property (`listingSubmission`
 * through `readMoveInFormTemplates`), so what is offered is exactly what the property has.
 */
import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelSection, StepHeading, StepRail } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { WizardField, WizardSelect } from "@/components/portal/add-workspace/parts";
import { MoveInFormFrame, MoveInFormResidentCard } from "@/components/portal/move-in-forms/move-in-form-frame";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { track } from "@/lib/analytics/track-client";
import { loadInspectionList } from "@/lib/inspections/client";
import { inspectionRoomLabel, type InspectionResidency } from "@/lib/inspections/model";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { sendMoveInForm } from "@/lib/move-in-forms/client";
import { formatMoveInDate, formatWallDate, pacificDay } from "@/lib/move-in-forms/manager-rows";
import { moveInFormDueAt, moveInFormDueFor, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

const STEPS = [{ id: "send", label: "Send a form" }] as const;

const roomSuffix = (room: string) => (room.trim() ? ` · ${room.trim()}` : "");
const residencyPlace = (r: InspectionResidency) => `${r.property}${roomSuffix(inspectionRoomLabel(r.room))}`;

/** The named forms a resident's property has, by name. Any of them can be sent by hand. */
export function sendableMoveInForms(userId: string, propertyId: string): MoveInFormTemplate[] {
  if (!propertyId) return [];
  const hit = resolveManagerListingSubmissionForPropertyId(userId, propertyId);
  if (!hit) return [];
  return readMoveInFormTemplates(hit.sub)
    .filter((template) => template.name.trim())
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function SendMoveInFormPopup({
  userId,
  presetApplicationId,
  onClose,
  onOpenProperty,
}: {
  userId: string;
  /** From a resident record: that resident is already chosen. */
  presetApplicationId?: string;
  onClose: () => void;
  /** Where "add a form" goes when the property has none. */
  onOpenProperty?: (propertyId: string) => void;
}) {
  const { showToast } = useAppUi();
  const [residencies, setResidencies] = useState<InspectionResidency[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [pickedResident, setPickedResident] = useState(presetApplicationId ?? "");
  const [pickedForm, setPickedForm] = useState("");
  const [dueOverride, setDueOverride] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadInspectionList(userId, "manager", undefined, attempt > 0)
      .then((value) => {
        if (cancelled) return;
        setLoadError("");
        setResidencies(
          value.residencies
            .filter((r) => (r.occupancy === "current" || r.occupancy === "upcoming") && workspaceContainsProperty(r.propertyId))
            // From a resident record, only that resident is offered: never fall through to someone else.
            .filter((r) => !presetApplicationId || r.id === presetApplicationId)
            .sort((a, b) => a.name.localeCompare(b.name) || residencyPlace(a).localeCompare(residencyPlace(b))),
        );
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load residents");
      });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt, presetApplicationId]);

  const residency = residencies?.find((r) => r.id === pickedResident) ?? residencies?.[0] ?? null;
  const forms = useMemo(() => (residency ? sendableMoveInForms(userId, residency.propertyId) : []), [userId, residency]);
  const template = forms.find((f) => f.id === pickedForm) ?? forms[0] ?? null;

  // The due day the property's own rule gives for this residency, unless the manager picks another. A
  // move-out rule counts from the lease end, so both of the residency's dates are offered as anchors.
  const ruleDue = template && residency
    ? pacificDay(moveInFormDueFor(template.due, { moveInDate: residency.moveInDate, leaseEnd: residency.moveOutDate }))
    : "";
  const due = dueOverride ?? ruleDue;
  const dueAt = due ? moveInFormDueAt("move-in-day", due) : null;

  const first = residency?.name.trim().split(/\s+/)[0] ?? "";
  const canSend = Boolean(residency && template && !sending);

  const send = async () => {
    if (!residency || !template) return;
    setSending(true);
    try {
      await sendMoveInForm({ applicationId: residency.id, formId: template.id, ...(dueAt ? { dueAt } : {}) });
      track("move_in_form_sent", { source: presetApplicationId ? "resident_record" : "move_in_page" });
      showToast("Sent. It shows under Waiting.");
      onClose();
    } catch (error) {
      showToast(error instanceof Error && error.message ? error.message : "Could not send this form.");
      setSending(false);
    }
  };

  let body;
  if (loadError) {
    body = (
      <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center" data-attr="move-in-form-send-error">
        <p className="mb-3 text-sm font-semibold text-foreground">Couldn&apos;t load residents</p>
        <Button variant="outline" onClick={() => setAttempt((n) => n + 1)} data-attr="move-in-form-send-retry">
          Try again
        </Button>
      </div>
    );
  } else if (!residencies) {
    body = (
      <div role="status" aria-label="Loading residents" className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-accent/50 motion-reduce:animate-none" />
        ))}
      </div>
    );
  } else if (residencies.length === 0) {
    body = (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 px-6 py-8 text-center" data-attr="move-in-form-send-no-residents">
        <p className="text-base font-semibold text-foreground">No current residents</p>
      </div>
    );
  } else {
    body = (
      <div className="max-w-[560px] space-y-4">
        <WizardSelect
          label="Resident"
          value={residency?.id ?? ""}
          onChange={(next) => {
            setPickedResident(next);
            setPickedForm("");
            setDueOverride(null);
          }}
          options={residencies.map((r) => ({ value: r.id, label: `${r.name} · ${residencyPlace(r)}` }))}
          dataAttr="move-in-form-send-resident"
        />
        {forms.length > 0 ? (
          <WizardSelect
            label="Form"
            value={template?.id ?? ""}
            onChange={(next) => {
              setPickedForm(next);
              setDueOverride(null);
            }}
            options={forms.map((f) => ({ value: f.id, label: f.name }))}
            dataAttr="move-in-form-send-form"
          />
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-card/40 px-5 py-6 text-center" data-attr="move-in-form-send-no-forms">
            <p className="text-sm font-semibold text-foreground">No move-in forms for {residency?.property || "this property"}</p>
            {onOpenProperty && residency ? (
              <Button variant="outline" className="mt-3" onClick={() => onOpenProperty(residency.propertyId)} data-attr="move-in-form-send-open-property">
                Open Move-in forms
              </Button>
            ) : null}
          </div>
        )}
        {template ? (
          <WizardField label="Due">
            <Input
              type="date"
              className="portal-modal-date-input"
              value={due}
              onChange={(e) => setDueOverride(e.target.value)}
              data-attr="move-in-form-send-due"
            />
          </WizardField>
        ) : null}
      </div>
    );
  }

  return (
    <MoveInFormFrame
      title="Send a move-in form"
      onClose={onClose}
      assistantContext="Send a move-in form"
      assistantScopeKey="Send a move-in form"
      dataAttr="move-in-form-send-popup"
      railHeader={residency ? <MoveInFormResidentCard name={residency.name} place={residencyPlace(residency)} /> : null}
      rail={<StepRail steps={STEPS} current={0} onJump={() => {}} />}
      sidePanel={
        template && residency ? (
          <PanelSection title={`What ${first || "the resident"} gets`}>
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-primary/[0.08] text-primary" aria-hidden>
                <FileText className="size-5" strokeWidth={1.6} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-foreground">{template.name}</span>
                <span className="block text-[12.5px] text-muted">
                  {due ? `Due ${formatMoveInDate(dueAt) || formatWallDate(due)}` : "No due date"}
                </span>
              </span>
            </div>
          </PanelSection>
        ) : null
      }
      footer={
        <>
          <Button type="button" variant="ghost" className="min-h-[44px] rounded-full px-6" onClick={onClose} data-attr="move-in-form-send-cancel">
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            className="min-h-[44px] rounded-full px-7 text-[14px] font-bold"
            disabled={!canSend}
            loading={sending}
            onClick={() => void send()}
            data-attr="move-in-form-send"
          >
            Send
          </Button>
        </>
      }
    >
      <StepHeading title="Send a form" />
      {body}
    </MoveInFormFrame>
  );
}
