"use client";

import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PricingReceiptPanel } from "@/components/portal/listing-wizard-v2/listing-side-panel";
import {
  FactRow,
  MoneyInput,
  StepColumn,
  StepHeading,
  ToggleRow,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ArrangementPriceEditor } from "@/components/portal/listing-wizard-v2/listing-arrangement-editor";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { listingPricingTabToLeaseTerm } from "@/lib/listing-fee-scope";
import {
  pricingCopySourceRooms,
  setRoomPricingCopyFrom,
} from "@/lib/property-pricing-room-copy";
import { propertyPricingRoomSummary } from "@/lib/property-pricing-summary";
import {
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";

export type PropertyPricingSubject =
  | { kind: "room"; roomId: string }
  | { kind: "bundle"; bundleId: string }
  | { kind: "whole" };

type Props = {
  open: boolean;
  onClose: () => void;
  subject: PropertyPricingSubject;
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onSaved: () => void;
  showToast: (message: string) => void;
};

function subjectTitle(subject: PropertyPricingSubject, sub: ManagerListingSubmissionV1): string {
  if (subject.kind === "room") {
    const room = sub.rooms.find((r) => r.id === subject.roomId);
    return room?.name?.trim() || "Room pricing";
  }
  if (subject.kind === "bundle") {
    const bundle = sub.bundles.find((b) => b.id === subject.bundleId);
    return bundle?.label?.trim() || "Bundle pricing";
  }
  return "Whole house pricing";
}

export function PropertyRoomPricingWorkspace({
  open,
  onClose,
  subject,
  sub,
  saveTarget,
  managerUserId,
  propertyLabel,
  onSaved,
  showToast,
}: Props) {
  const [draft, setDraft] = useState(() => normalizeManagerListingSubmissionV1(sub));
  const [step, setStep] = useState(0);
  const [quoteRoomId, setQuoteRoomId] = useState<string | null>(
    subject.kind === "room" ? subject.roomId : null,
  );

  useEffect(() => {
    if (open) {
      setDraft(normalizeManagerListingSubmissionV1(sub));
      setStep(0);
      setQuoteRoomId(subject.kind === "room" ? subject.roomId : null);
    }
  }, [open, sub, subject]);

  const leaseTerms = useMemo(() => resolveAllowedLeaseTerms(draft), [draft]);
  const steps: AddWorkspaceStep[] = useMemo(() => {
    const out: AddWorkspaceStep[] = [{ id: LONG_TERM_LEASE_TERM, label: "Long-term", summary: "" }];
    if (leaseTerms.includes(SHORT_TERM_LEASE_TERM) || draft.shortTermRentalsAllowed) {
      out.push({ id: SHORT_TERM_LEASE_TERM, label: "Short term", summary: "" });
    }
    return out.map((s) => {
      if (subject.kind !== "room") return s;
      const room = draft.rooms.find((r) => r.id === subject.roomId);
      if (!room) return s;
      const summary =
        s.id === LONG_TERM_LEASE_TERM
          ? propertyPricingRoomSummary(room, draft, draft.roomPricingMeta?.[room.id])
          : room.shortTermRent
            ? `$${room.shortTermRent}/night`
            : "—";
      return { ...s, summary };
    });
  }, [draft, leaseTerms, subject]);

  const activeTerm = steps[step]?.id ?? LONG_TERM_LEASE_TERM;
  const quoteTerm = listingPricingTabToLeaseTerm(activeTerm) ?? LONG_TERM_LEASE_TERM;

  const patch: (next: Partial<ManagerListingSubmissionV1>) => void = (next) => {
    setDraft((prev) => normalizeManagerListingSubmissionV1({ ...prev, ...next }));
  };

  const updateRoom = (roomId: string, next: ManagerRoomSubmission) => {
    const meta = draft.roomPricingMeta?.[roomId];
    const roomPricingMeta = {
      ...(draft.roomPricingMeta ?? {}),
      [roomId]: { ...meta, priceSource: "own" as const },
    };
    patch({
      rooms: draft.rooms.map((r) => (r.id === roomId ? next : r)),
      roomPricingMeta,
    });
  };

  const save = () => {
    const normalized = normalizeManagerListingSubmissionV1(draft);
    if (!persistManagerListingSubmission(saveTarget, managerUserId, normalized)) {
      showToast("Could not save pricing.");
      return false;
    }
    onSaved();
    showToast("Pricing saved.");
    return true;
  };

  const roomBody =
    subject.kind === "room"
      ? (() => {
          const room = draft.rooms.find((r) => r.id === subject.roomId);
          if (!room) return null;
          const cap = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
          const copySources = pricingCopySourceRooms(draft, room.id, activeTerm);
          const copyValue = draft.roomPricingMeta?.[room.id]?.copyFromRoomIdByTerm?.[activeTerm] ?? "";
          const isStay = activeTerm === SHORT_TERM_LEASE_TERM;
          return (
            <StepColumn>
              <StepHeading title={activeTerm === LONG_TERM_LEASE_TERM ? "Long-term" : "Short term"} />
              {copySources.length > 0 ? (
                <FactRow label="Pricing">
                  <FieldSingleSelect
                    label="Pricing"
                    options={[
                      { value: "", label: "Set for this room" },
                      ...copySources.map((r) => ({
                        value: r.id,
                        label: `Same as ${r.name?.trim() || "Room"}`,
                      })),
                    ]}
                    value={copyValue}
                    onChange={(v) => {
                      const next = setRoomPricingCopyFrom(draft, room.id, activeTerm, v || null);
                      setDraft(normalizeManagerListingSubmissionV1(next));
                    }}
                    dataAttr="property-room-pricing-copy"
                  />
                </FactRow>
              ) : null}
              {!copyValue ? (
                isStay ? (
                  <>
                    <FactRow label="Nightly rate">
                      <MoneyInput
                        label="Nightly rate"
                        value={room.shortTermRent ?? ""}
                        onChange={(v) => updateRoom(room.id, { ...room, shortTermRent: v })}
                      />
                    </FactRow>
                    <FactRow label="Deposit">
                      <MoneyInput
                        label="Deposit"
                        value={room.shortTermDeposit ?? room.securityDeposit ?? ""}
                        onChange={(v) => updateRoom(room.id, { ...room, shortTermDeposit: v })}
                      />
                    </FactRow>
                  </>
                ) : (
                  <>
                    <FactRow label="Rent /mo">
                      <MoneyInput
                        label="Rent"
                        value={room.monthlyRent > 0 ? String(room.monthlyRent) : ""}
                        onChange={(v) =>
                          updateRoom(room.id, {
                            ...room,
                            monthlyRent: Number(v.replace(/[^0-9.]/g, "")) || 0,
                          })
                        }
                      />
                    </FactRow>
                    <FactRow label="Utilities /mo">
                      <MoneyInput
                        label="Utilities"
                        value={room.utilitiesEstimate ?? ""}
                        onChange={(v) => updateRoom(room.id, { ...room, utilitiesEstimate: v })}
                      />
                    </FactRow>
                    <FactRow label="Deposit">
                      <MoneyInput
                        label="Deposit"
                        value={room.securityDeposit ?? ""}
                        onChange={(v) => updateRoom(room.id, { ...room, securityDeposit: v })}
                      />
                    </FactRow>
                    {cap > 1 ? (
                      <ArrangementPriceEditor
                        room={room}
                        onRoom={(next) => updateRoom(room.id, next)}
                        sub={draft}
                        patch={patch}
                        term={quoteTerm}
                        prorate={activeTerm === LONG_TERM_LEASE_TERM}
                      />
                    ) : null}
                  </>
                )
              ) : (
                <p className="text-[13px] font-semibold text-muted">
                  Mirroring {copySources.find((r) => r.id === copyValue)?.name?.trim() || "another room"} — change
                  Pricing to edit this room on its own.
                </p>
              )}
            </StepColumn>
          );
        })()
      : null;

  const wholeBody =
    subject.kind === "whole"
      ? (
          <StepColumn>
            <StepHeading title="Whole house" />
            {!isEntireHomeListing(draft) ? (
              <ToggleRow
                label="Offer the whole house"
                checked={Boolean(draft.entireHomeOffered)}
                onChange={(on) => patch({ entireHomeOffered: on })}
                dataAttr="property-whole-house-offer"
              />
            ) : null}
            <FactRow label="Rent /mo">
              <MoneyInput
                label="Whole house rent"
                value={
                  draft.entireHomeMonthlyRent && draft.entireHomeMonthlyRent > 0
                    ? String(draft.entireHomeMonthlyRent)
                    : ""
                }
                onChange={(v) =>
                  patch({
                    entireHomeMonthlyRent: Number(v.replace(/[^0-9.]/g, "")) || 0,
                    roomPricingMeta: undefined,
                  })
                }
              />
            </FactRow>
          </StepColumn>
        )
      : null;

  const bundleBody =
    subject.kind === "bundle"
      ? (() => {
          const bundle = draft.bundles.find((b) => b.id === subject.bundleId);
          if (!bundle) return null;
          const patchBundle = (next: Partial<ManagerBundleRow>) => {
            patch({
              bundles: draft.bundles.map((b) => (b.id === bundle.id ? { ...b, ...next } : b)),
            });
          };
          return (
            <StepColumn>
              <StepHeading title={bundle.label || "Bundle"} />
              <FactRow label="Rent /mo">
                <MoneyInput
                  label="Bundle rent"
                  value={bundle.price ?? ""}
                  onChange={(v) => patchBundle({ price: v })}
                />
              </FactRow>
              <FactRow label="Deposit">
                <MoneyInput
                  label="Bundle deposit"
                  value={bundle.securityDeposit ?? ""}
                  onChange={(v) => patchBundle({ securityDeposit: v })}
                />
              </FactRow>
            </StepColumn>
          );
        })()
      : null;

  const center = roomBody ?? bundleBody ?? wholeBody;

  if (!open) return null;

  return (
    <AddWorkspace
      title={subjectTitle(subject, draft)}
      subtitle={propertyLabel}
      steps={steps}
      current={step}
      onJump={setStep}
      onClose={onClose}
      dirty
      lastLabel="Save"
      onFinish={() => {
        if (save()) onClose();
      }}
      dataAttrPrefix="property-room-pricing"
      finishDataAttr="property-room-pricing-save"
      assistantContext={`Property pricing for ${propertyLabel}`}
      assistantScopeKey={`property-pricing-${saveTarget.saveId}`}
      sidePanel={
        subject.kind === "room" ? (
          <PricingReceiptPanel
            sub={draft}
            patch={patch}
            roomId={quoteRoomId ?? subject.roomId}
            leaseTerm={quoteTerm}
            onRoomChange={setQuoteRoomId}
            onLeaseTermChange={() => {}}
            leaseTerms={leaseTerms}
            lockLeaseTerm
          />
        ) : undefined
      }
    >
      <div className="plp-wizard-root" data-rp-form>
        {center}
      </div>
    </AddWorkspace>
  );
}
