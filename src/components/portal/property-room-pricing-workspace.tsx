"use client";

import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  BundleWholePricingReceiptPanel,
  PricingReceiptPanel,
} from "@/components/portal/listing-wizard-v2/listing-side-panel";
import {
  FactRow,
  MoneyInput,
  StepColumn,
  StepHeading,
  ToggleRow,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ArrangementPriceEditor } from "@/components/portal/listing-wizard-v2/listing-arrangement-editor";
import { FeeRows } from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import {
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import { listingPricingTabToLeaseTerm } from "@/lib/listing-fee-scope";
import {
  pricingCopySourceBundles,
  setBundlePricingCopyFrom,
} from "@/lib/property-pricing-bundle-copy";
import {
  pricingCopySourceRooms,
  setRoomPricingCopyFrom,
} from "@/lib/property-pricing-room-copy";
import { roomPricingSourceLabel } from "@/lib/property-pricing-summary";
import type { WorkspacePricingDefaults } from "@/lib/workspace-pricing-defaults";
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
  workspacePricingDefaults?: WorkspacePricingDefaults;
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
  workspacePricingDefaults: _workspacePricingDefaults,
}: Props) {
  const [draft, setDraft] = useState(() => normalizeManagerListingSubmissionV1(sub));
  const [step, setStep] = useState(0);
  const [slideDir, setSlideDir] = useState(0);
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
  const extraLeaseTerms = useMemo(
    () =>
      leaseTerms.filter(
        (t) => t !== LONG_TERM_LEASE_TERM && t !== SHORT_TERM_LEASE_TERM && t !== "Airbnb",
      ),
    [leaseTerms],
  );
  const allowM2m = leaseTerms.includes("Month-to-Month");
  const allowCustomStart = leaseTerms.includes(CUSTOM_LEASE_TERM);
  const steps: AddWorkspaceStep[] = useMemo(() => {
    const out: AddWorkspaceStep[] = [];
    if (subject.kind === "bundle") {
      const bundle = draft.bundles.find((b) => b.id === subject.bundleId);
      out.push({
        id: "bundle",
        label: "Bundle",
        summary: bundle?.label?.trim() || "Name and rooms",
      });
    }
    out.push({ id: LONG_TERM_LEASE_TERM, label: "Long-term", summary: "" });
    if (leaseTerms.includes(SHORT_TERM_LEASE_TERM) || draft.shortTermRentalsAllowed) {
      out.push({ id: SHORT_TERM_LEASE_TERM, label: "Short term", summary: "" });
    }
    for (const term of extraLeaseTerms) {
      out.push({ id: term, label: term, summary: "" });
    }
    return out.map((s) => {
      if (s.id === "bundle") return s;
      if (subject.kind === "bundle") {
        const bundle = draft.bundles.find((b) => b.id === subject.bundleId);
        const summary =
          s.id === LONG_TERM_LEASE_TERM
            ? bundle?.price?.trim() || "—"
            : bundle?.shortTermNightlyRent?.trim() || "—";
        return { ...s, summary };
      }
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
  }, [draft, extraLeaseTerms, leaseTerms, subject]);

  const activeStepId = steps[step]?.id ?? LONG_TERM_LEASE_TERM;
  const activeTerm =
    activeStepId === "bundle" ? LONG_TERM_LEASE_TERM : activeStepId;
  const quoteTerm = listingPricingTabToLeaseTerm(activeTerm) ?? LONG_TERM_LEASE_TERM;

  const jumpStep = (index: number) => {
    setSlideDir(index > step ? 1 : index < step ? -1 : 0);
    setStep(index);
  };

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
          const isStay = activeStepId === SHORT_TERM_LEASE_TERM;
          const priceSource = roomPricingSourceLabel(draft.roomPricingMeta?.[room.id]);
          const stepTitle =
            activeStepId === SHORT_TERM_LEASE_TERM
              ? "Short term"
              : activeStepId === LONG_TERM_LEASE_TERM
                ? "Long-term"
                : String(activeStepId);
          return (
            <StepColumn>
              <StepHeading title={stepTitle} />
              {priceSource ? (
                <p className="text-[12px] font-semibold text-muted" data-rp-src>
                  {priceSource}
                </p>
              ) : null}
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
                    <FeeRows
                      sub={draft}
                      patch={patch}
                      roomId={room.id}
                      roomName={room.name?.trim() || "Room"}
                      term={quoteTerm}
                    />
                  </>
                ) : cap > 1 ? (
                  <ArrangementPriceEditor
                    room={room}
                    onRoom={(next) => updateRoom(room.id, next)}
                    sub={draft}
                    patch={patch}
                    term={quoteTerm}
                    prorate={activeStepId === LONG_TERM_LEASE_TERM}
                    showResidentsCapacity
                    showMonthToMonthSurcharge={allowM2m}
                    showCustomStartSurcharge={allowCustomStart}
                  />
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
                    <FeeRows
                      sub={draft}
                      patch={patch}
                      roomId={room.id}
                      roomName={room.name?.trim() || "Room"}
                      term={quoteTerm}
                    />
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
          if (activeStepId === "bundle") {
            const roomOptions = draft.rooms.map((r, i) => ({
              value: r.id,
              label: r.name?.trim() || `Room ${i + 1}`,
            }));
            const selected = (bundle.includedRoomIds ?? []).filter((id) =>
              draft.rooms.some((r) => r.id === id),
            );
            return (
              <StepColumn>
                <StepHeading title="Bundle" />
                <FactRow label="Name">
                  <input
                    className="h-9 w-full max-w-[280px] rounded-lg border border-border bg-background px-2 text-[14px] font-semibold"
                    value={bundle.label}
                    onChange={(e) => patchBundle({ label: e.target.value })}
                    aria-label="Bundle name"
                  />
                </FactRow>
                <FactRow label="Rooms">
                  <CheckboxMultiSelect
                    label="Rooms in bundle"
                    options={roomOptions}
                    selected={selected}
                    onChange={(ids) => patchBundle({ includedRoomIds: ids })}
                    dataAttr="property-bundle-rooms"
                  />
                </FactRow>
              </StepColumn>
            );
          }
          const copySources = pricingCopySourceBundles(draft, bundle.id, activeTerm);
          const copyValue = bundle.copyFromBundleIdByTerm?.[activeTerm] ?? "";
          const isStay = activeStepId === SHORT_TERM_LEASE_TERM;
          const isBaseLong = activeStepId === LONG_TERM_LEASE_TERM;
          const termOverride = !isBaseLong && !isStay ? bundle.termPricing?.[activeStepId] : undefined;
          const stepTitle =
            activeStepId === "bundle"
              ? "Bundle"
              : isStay
                ? "Short term"
                : isBaseLong
                  ? "Long-term"
                  : String(activeStepId);
          return (
            <StepColumn>
              <StepHeading title={stepTitle} />
              {copySources.length > 0 ? (
                <FactRow label="Pricing">
                  <FieldSingleSelect
                    label="Pricing"
                    options={[
                      { value: "", label: "Set for this bundle" },
                      ...copySources.map((b) => ({
                        value: b.id,
                        label: `Same as ${b.label?.trim() || "Bundle"}`,
                      })),
                    ]}
                    value={copyValue}
                    onChange={(v) => {
                      const next = setBundlePricingCopyFrom(draft, bundle.id, activeTerm, v || null);
                      setDraft(normalizeManagerListingSubmissionV1(next));
                    }}
                    dataAttr="property-bundle-pricing-copy"
                  />
                </FactRow>
              ) : null}
              {!copyValue ? (
                isStay ? (
                  <>
                    <FactRow label="Nightly rate">
                      <MoneyInput
                        label="Nightly rate"
                        value={bundle.shortTermNightlyRent ?? ""}
                        onChange={(v) => patchBundle({ shortTermNightlyRent: v })}
                      />
                    </FactRow>
                    <FeeRows sub={draft} patch={patch} roomId={null} term={quoteTerm} />
                  </>
                ) : (
                  <>
                    <FactRow label="Rent /mo">
                      <MoneyInput
                        label="Bundle rent"
                        value={
                          termOverride?.monthlyRent != null && termOverride.monthlyRent > 0
                            ? String(termOverride.monthlyRent)
                            : bundle.price ?? ""
                        }
                        onChange={(v) => {
                          const n = Number(v.replace(/[^0-9.]/g, "")) || 0;
                          if (isBaseLong) patchBundle({ price: v });
                          else
                            patchBundle({
                              termPricing: {
                                ...(bundle.termPricing ?? {}),
                                [activeStepId]: {
                                  ...(bundle.termPricing?.[activeStepId] ?? {}),
                                  monthlyRent: n,
                                },
                              },
                            });
                        }}
                      />
                    </FactRow>
                    <FactRow label="Utilities /mo">
                      <MoneyInput
                        label="Bundle utilities"
                        value={termOverride?.utilitiesEstimate ?? bundle.utilitiesEstimate ?? ""}
                        onChange={(v) => {
                          if (isBaseLong) patchBundle({ utilitiesEstimate: v });
                          else
                            patchBundle({
                              termPricing: {
                                ...(bundle.termPricing ?? {}),
                                [activeStepId]: {
                                  ...(bundle.termPricing?.[activeStepId] ?? {}),
                                  utilitiesEstimate: v,
                                },
                              },
                            });
                        }}
                      />
                    </FactRow>
                    <FactRow label="Deposit">
                      <MoneyInput
                        label="Bundle deposit"
                        value={termOverride?.securityDeposit ?? bundle.securityDeposit ?? ""}
                        onChange={(v) => {
                          if (isBaseLong) patchBundle({ securityDeposit: v });
                          else
                            patchBundle({
                              termPricing: {
                                ...(bundle.termPricing ?? {}),
                                [activeStepId]: {
                                  ...(bundle.termPricing?.[activeStepId] ?? {}),
                                  securityDeposit: v,
                                },
                              },
                            });
                        }}
                      />
                    </FactRow>
                    <FeeRows sub={draft} patch={patch} roomId={null} term={quoteTerm} />
                  </>
                )
              ) : (
                <p className="text-[13px] font-semibold text-muted">
                  Mirroring another bundle — change Pricing to edit on its own.
                </p>
              )}
            </StepColumn>
          );
        })()
      : null;

  const center =
    subject.kind === "bundle"
      ? bundleBody
      : subject.kind === "room" && activeStepId !== "bundle"
        ? roomBody
        : wholeBody;

  if (!open) return null;

  return (
    <AddWorkspace
      title={subjectTitle(subject, draft)}
      subtitle={propertyLabel}
      steps={steps}
      current={step}
      onJump={jumpStep}
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
            plainReceipt
            allowMonthToMonthStart={allowM2m}
            allowCustomStart={allowCustomStart}
          />
        ) : subject.kind === "whole" ? (
          <BundleWholePricingReceiptPanel
            sub={draft}
            kind="whole"
            leaseTerm={quoteTerm}
            leaseTerms={leaseTerms}
            allowMonthToMonthStart={allowM2m}
            allowCustomStart={allowCustomStart}
          />
        ) : subject.kind === "bundle" ? (
          <BundleWholePricingReceiptPanel
            sub={draft}
            kind="bundle"
            bundleId={subject.bundleId}
            leaseTerm={quoteTerm}
            leaseTerms={leaseTerms}
            allowMonthToMonthStart={allowM2m}
            allowCustomStart={allowCustomStart}
          />
        ) : undefined
      }
    >
      <div className="plp-wizard-root plp-ws-col" data-rp-form>
        <div
          key={activeStepId}
          className={
            slideDir === 0
              ? ""
              : slideDir > 0
                ? "plp-step-enter-forward motion-reduce:transform-none"
                : "plp-step-enter-back motion-reduce:transform-none"
          }
        >
          {center}
        </div>
      </div>
    </AddWorkspace>
  );
}
