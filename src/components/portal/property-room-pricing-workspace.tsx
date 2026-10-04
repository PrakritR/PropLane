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
import { ArrangementStandardFeeRows } from "@/components/portal/listing-wizard-v2/arrangement-standard-fee-rows";
import { FeeRows, ProrateRows, perDay } from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import type { ArrangementFeePatch } from "@/components/portal/listing-wizard-v2/arrangement-standard-fee-rows";
import type { RoomOccupancyPrice } from "@/lib/room-arrangement-pricing";
import {
  formatPlacementMoneyField,
  longTermPrivateArrangementRow,
  mergeLongTermPrivateArrangementRow,
  mergeTermStandardFees,
  termStandardFeeRow,
} from "@/lib/listing-placement-standard-fees";
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
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import { listingPricingLeaseTabs, listingPricingTabToLeaseTerm } from "@/lib/listing-fee-scope";
import {
  feeVisibilityForTerms,
  roomFeeTermScope,
  roomPricingFeeVisibility,
} from "@/lib/room-term-fees";
import { parseMoneyAmount } from "@/lib/parse-money";
import { isStayLeaseTerm } from "@/lib/listing-quote";
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
  type ManagerPricingSaveTarget,
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
  saveTarget: ManagerPricingSaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onSaved: () => void;
  showToast: (message: string) => void;
  workspacePricingDefaults?: WorkspacePricingDefaults;
};

function standardFeesForTerm(
  room: ManagerRoomSubmission,
  term: string,
  isBaseLong: boolean,
): Pick<RoomOccupancyPrice, "leaseFee" | "applicationFee" | "moveInFee"> {
  const longRow = longTermPrivateArrangementRow(room);
  if (isBaseLong) return longRow;
  const own = termStandardFeeRow(room, term);
  // A Short term step saved before stay types kept their own entry holds its fees on the long-term row.
  const stay = roomFeeTermScope(term) === "short";
  return {
    leaseFee: own.leaseFee ?? (stay ? longRow.shortTermLeaseFee : undefined),
    applicationFee: own.applicationFee ?? (stay ? longRow.shortTermApplicationFee : undefined),
    moveInFee: own.moveInFee,
  };
}

/** What an empty box on a non-long-term step follows: the long-term row (the resolver's next level). */
function inheritedFeesForTerm(
  room: ManagerRoomSubmission,
  isBaseLong: boolean,
): Pick<RoomOccupancyPrice, "leaseFee" | "applicationFee" | "moveInFee"> | undefined {
  if (isBaseLong) return undefined;
  const row = longTermPrivateArrangementRow(room);
  return {
    leaseFee: formatPlacementMoneyField(row.leaseFee ?? ""),
    applicationFee: formatPlacementMoneyField(row.applicationFee ?? ""),
    moveInFee: formatPlacementMoneyField(row.moveInFee ?? ""),
  };
}

function patchStandardFeesForTerm(
  room: ManagerRoomSubmission,
  term: string,
  isBaseLong: boolean,
  patch: ArrangementFeePatch,
): ManagerRoomSubmission {
  // The two start surcharges always live on the long-term private row; a stay type's own
  // Lease / Application / Move-in fees live on its term entry (the long-term row on the base step).
  const { monthToMonthSurcharge, customStartSurcharge, shortTermLeaseFee, shortTermApplicationFee, ...fees } = patch;
  void shortTermLeaseFee;
  void shortTermApplicationFee;
  const surcharges: { monthToMonthSurcharge?: string; customStartSurcharge?: string } = {};
  if (monthToMonthSurcharge !== undefined) surcharges.monthToMonthSurcharge = monthToMonthSurcharge;
  if (customStartSurcharge !== undefined) surcharges.customStartSurcharge = customStartSurcharge;
  let next = room;
  if (Object.keys(surcharges).length > 0) next = mergeLongTermPrivateArrangementRow(next, surcharges);
  if (Object.keys(fees).length > 0) {
    next = isBaseLong ? mergeLongTermPrivateArrangementRow(next, fees) : mergeTermStandardFees(next, term, fees);
  }
  return next;
}

/** The row the fee block shows for a step: that step's own fees, plus the long-term row's start surcharges. */
function feeRowForStep(room: ManagerRoomSubmission, term: string, isBaseLong: boolean): RoomOccupancyPrice {
  const longRow = longTermPrivateArrangementRow(room);
  return {
    count: 1,
    ...displayFeeRow(standardFeesForTerm(room, term, isBaseLong)),
    monthToMonthSurcharge: longRow.monthToMonthSurcharge,
    customStartSurcharge: longRow.customStartSurcharge,
  };
}

function displayFeeRow(
  row: Pick<RoomOccupancyPrice, "leaseFee" | "applicationFee" | "moveInFee">,
): Pick<RoomOccupancyPrice, "leaseFee" | "applicationFee" | "moveInFee"> {
  return {
    leaseFee: formatPlacementMoneyField(row.leaseFee ?? ""),
    applicationFee: formatPlacementMoneyField(row.applicationFee ?? ""),
    moveInFee: formatPlacementMoneyField(row.moveInFee ?? ""),
  };
}

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

/** The submission patch for a room's pricing edit: the room itself, marked as priced on its own. */
export function roomPricingPatch(
  draft: ManagerListingSubmissionV1,
  roomId: string,
  next: ManagerRoomSubmission,
): Pick<ManagerListingSubmissionV1, "rooms" | "roomPricingMeta"> {
  const meta = draft.roomPricingMeta?.[roomId];
  return {
    rooms: draft.rooms.map((r) => (r.id === roomId ? next : r)),
    roomPricingMeta: {
      ...(draft.roomPricingMeta ?? {}),
      [roomId]: { ...meta, priceSource: "own" as const },
    },
  };
}

/**
 * One room's pricing fields for one lease type step (Long-term, Short term ...): rent, utilities, deposit,
 * the fee rows and the standard fees. The pricing workspace's room step and the listing editor's inline
 * Pricing step draw this one component, so both edit exactly the same fields.
 */
export function RoomPricingFields({
  draft,
  room,
  activeTerm,
  patch,
  setDraft,
  updateRoom,
}: {
  draft: ManagerListingSubmissionV1;
  room: ManagerRoomSubmission;
  /** The pricing step's term id: Long-term, Short term, ... */
  activeTerm: string;
  patch: (next: Partial<ManagerListingSubmissionV1>) => void;
  setDraft: (next: ManagerListingSubmissionV1) => void;
  updateRoom: (roomId: string, next: ManagerRoomSubmission) => void;
}) {
  const quoteTerm = listingPricingTabToLeaseTerm(activeTerm) ?? LONG_TERM_LEASE_TERM;
  const feeScope = roomFeeTermScope(quoteTerm);
  const feeVisibility = roomPricingFeeVisibility(draft, room);
  const allowM2m = feeVisibility.monthToMonthSurcharge;
  const allowCustomStart = feeVisibility.customStartSurcharge;
  const cap = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const copySources = pricingCopySourceRooms(draft, room.id, activeTerm);
  const copyValue = draft.roomPricingMeta?.[room.id]?.copyFromRoomIdByTerm?.[activeTerm] ?? "";
  const isStay = isStayLeaseTerm(quoteTerm);
  const isBaseLong = quoteTerm === LONG_TERM_LEASE_TERM;
  const priceSource = roomPricingSourceLabel(draft.roomPricingMeta?.[room.id]);
  return (
    <>
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
          cap > 1 ? (
            <ArrangementPriceEditor
              room={room}
              onRoom={(next) => updateRoom(room.id, next)}
              sub={draft}
              patch={patch}
              term={quoteTerm}
              prorate={false}
              stayMode
              showResidentsCapacity
            />
          ) : (
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
              <ArrangementStandardFeeRows
                count={1}
                row={feeRowForStep(room, quoteTerm, isBaseLong)}
                onPatch={(feePatch) =>
                  updateRoom(room.id, patchStandardFeesForTerm(room, quoteTerm, isBaseLong, feePatch))
                }
                showMonthToMonth={false}
                showCustomStart={false}
                scope={feeScope}
                storage="term"
                inheritedRow={inheritedFeesForTerm(room, isBaseLong)}
              />
            </>
          )
        ) : cap > 1 ? (
          <ArrangementPriceEditor
            room={room}
            onRoom={(next) => updateRoom(room.id, next)}
            sub={draft}
            patch={patch}
            term={quoteTerm}
            prorate={isBaseLong && feeVisibility.partialMonths}
            showResidentsCapacity
            showMonthToMonthSurcharge={allowM2m && isBaseLong}
            showCustomStartSurcharge={allowCustomStart && isBaseLong}
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
            {isBaseLong && allowCustomStart ? (
              <ProrateRows
                sub={draft}
                patch={patch}
                term={quoteTerm}
                roomId={room.id}
                name={room.name?.trim() || "Room"}
                automatic={(room.prorateMethod ?? "auto") !== "daily_rate"}
                onAutomatic={(next) =>
                  updateRoom(room.id, { ...room, prorateMethod: next ? "auto" : "daily_rate" })
                }
                rent={{
                  text: room.dailyRentRate ? String(room.dailyRentRate) : "",
                  placeholder: perDay(room.monthlyRent) || "35",
                  onChange: (v) =>
                    updateRoom(room.id, {
                      ...room,
                      dailyRentRate: Number(v.replace(/[^0-9.]/g, "")) || undefined,
                    }),
                }}
                util={
                  Number((room.utilitiesEstimate ?? "").replace(/[^0-9.]/g, "")) > 0
                    ? {
                        text: room.dailyUtilitiesRate ? String(room.dailyUtilitiesRate) : "",
                        placeholder: perDay(Number((room.utilitiesEstimate ?? "").replace(/[^0-9.]/g, ""))),
                        onChange: (v) =>
                          updateRoom(room.id, {
                            ...room,
                            dailyUtilitiesRate: Number(v.replace(/[^0-9.]/g, "")) || undefined,
                          }),
                      }
                    : null
                }
                dataAttr="property-room-pricing-prorate"
              />
            ) : null}
            <ArrangementStandardFeeRows
              count={1}
              row={feeRowForStep(room, quoteTerm, isBaseLong)}
              onPatch={(feePatch) =>
                updateRoom(room.id, patchStandardFeesForTerm(room, quoteTerm, isBaseLong, feePatch))
              }
              showMonthToMonth={allowM2m}
              showCustomStart={allowCustomStart}
              scope={feeScope}
              storage="term"
              inheritedRow={inheritedFeesForTerm(room, isBaseLong)}
            />
          </>
        )
      ) : (
        <p className="text-[13px] font-semibold text-muted">
          Mirroring {copySources.find((r) => r.id === copyValue)?.name?.trim() || "another room"} — change
          Pricing to edit this room on its own.
        </p>
      )}
    </>
  );
}

/** The whole house's pricing fields for one lease type step; the workspace and the inline Pricing step share it. */
export function WholeHousePricingFields({
  draft,
  activeStepId,
  patch,
}: {
  draft: ManagerListingSubmissionV1;
  /** The pricing step's term id: Long-term or Short term. */
  activeStepId: string;
  patch: (next: Partial<ManagerListingSubmissionV1>) => void;
}) {
  const quoteTerm = listingPricingTabToLeaseTerm(activeStepId) ?? LONG_TERM_LEASE_TERM;
  const feeVisibility = feeVisibilityForTerms(listingPricingLeaseTabs(draft));
  const allowM2m = feeVisibility.monthToMonthSurcharge;
  const allowCustomStart = feeVisibility.customStartSurcharge;
  const isStay = activeStepId === SHORT_TERM_LEASE_TERM;
  const isBaseLong = activeStepId === LONG_TERM_LEASE_TERM;
  const fees = draft.entireHomeArrangementFees ?? {};
  const priceSource =
    draft.entireHomePriceSource === "default"
      ? "Workspace default"
      : draft.entireHomePriceSource === "own"
        ? "This property"
        : null;
  const patchWholeFees = (next: Partial<typeof fees>) => {
    patch({
      entireHomeArrangementFees: { ...fees, ...next },
      entireHomePriceSource: "own",
    });
  };
  return (
    <>
      {!isEntireHomeListing(draft) ? (
        <ToggleRow
          label="Offer the whole house"
          checked={Boolean(draft.entireHomeOffered)}
          onChange={(on) => patch({ entireHomeOffered: on, entireHomePriceSource: "own" })}
          dataAttr="property-whole-house-offer"
        />
      ) : null}
      {priceSource ? (
        <p className="text-[12px] font-semibold text-muted" data-rp-src>
          {priceSource}
        </p>
      ) : null}
      {isStay ? (
        <>
          <FactRow label="Nightly rate">
            <MoneyInput
              label="Whole house nightly rate"
              value={draft.shortTermDailyCost ?? ""}
              onChange={(v) => patch({ shortTermDailyCost: v, entireHomePriceSource: "own" })}
            />
          </FactRow>
          <FactRow label="Deposit">
            <MoneyInput
              label="Whole house deposit"
              value={draft.securityDeposit ?? ""}
              onChange={(v) => patch({ securityDeposit: v, entireHomePriceSource: "own" })}
            />
          </FactRow>
          <FeeRows sub={draft} patch={patch} roomId={null} term={quoteTerm} />
          <ArrangementStandardFeeRows
            count={1}
            row={{ count: 1, ...fees }}
            onPatch={(feePatch) => patchWholeFees(feePatch)}
            showMonthToMonth={false}
            showCustomStart={false}
            scope="short"
          />
        </>
      ) : (
        <>
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
                  entireHomePriceSource: "own",
                })
              }
            />
          </FactRow>
          <FactRow label="Utilities /mo">
            <MoneyInput
              label="Whole house utilities"
              value={draft.entireHomeUtilitiesEstimate ?? ""}
              onChange={(v) =>
                patch({ entireHomeUtilitiesEstimate: v, entireHomePriceSource: "own" })
              }
            />
          </FactRow>
          <FactRow label="Deposit">
            <MoneyInput
              label="Whole house deposit"
              value={draft.securityDeposit ?? ""}
              onChange={(v) => patch({ securityDeposit: v, entireHomePriceSource: "own" })}
            />
          </FactRow>
          <FeeRows sub={draft} patch={patch} roomId={null} term={quoteTerm} />
          {isBaseLong && allowCustomStart ? (
            <ProrateRows
              sub={draft}
              patch={patch}
              term={quoteTerm}
              roomId={null}
              name="Whole house"
              automatic={(draft.entireHomeProrateMethod ?? "auto") !== "daily_rate"}
              onAutomatic={(next) =>
                patch({
                  entireHomeProrateMethod: next ? "auto" : "daily_rate",
                  entireHomePriceSource: "own",
                })
              }
              rent={{
                text: draft.entireHomeDailyRentRate ? String(draft.entireHomeDailyRentRate) : "",
                placeholder: perDay(draft.entireHomeMonthlyRent ?? 0) || "35",
                onChange: (v) =>
                  patch({
                    entireHomeDailyRentRate: Number(v.replace(/[^0-9.]/g, "")) || undefined,
                    entireHomePriceSource: "own",
                  }),
              }}
              util={
                Number((draft.entireHomeUtilitiesEstimate ?? "").replace(/[^0-9.]/g, "")) > 0
                  ? {
                      text: draft.entireHomeDailyUtilitiesRate
                        ? String(draft.entireHomeDailyUtilitiesRate)
                        : "",
                      placeholder: perDay(
                        Number((draft.entireHomeUtilitiesEstimate ?? "").replace(/[^0-9.]/g, "")),
                      ),
                      onChange: (v) =>
                        patch({
                          entireHomeDailyUtilitiesRate:
                            Number(v.replace(/[^0-9.]/g, "")) || undefined,
                          entireHomePriceSource: "own",
                        }),
                    }
                  : null
              }
              dataAttr="property-whole-pricing-prorate"
            />
          ) : null}
          <ArrangementStandardFeeRows
            count={1}
            row={{ count: 1, ...fees }}
            onPatch={(feePatch) => patchWholeFees(feePatch)}
            showMonthToMonth={allowM2m && isBaseLong}
            showCustomStart={allowCustomStart && isBaseLong}
          />
        </>
      )}
    </>
  );
}

/** One bundle's pricing fields for one lease type step; the workspace and the inline Pricing step share it. */
export function BundlePricingFields({
  draft,
  bundle,
  activeStepId,
  patch,
  setDraft,
}: {
  draft: ManagerListingSubmissionV1;
  bundle: ManagerBundleRow;
  /** The pricing step's term id: Long-term or Short term. */
  activeStepId: string;
  patch: (next: Partial<ManagerListingSubmissionV1>) => void;
  setDraft: (next: ManagerListingSubmissionV1) => void;
}) {
  const activeTerm = activeStepId;
  const quoteTerm = listingPricingTabToLeaseTerm(activeTerm) ?? LONG_TERM_LEASE_TERM;
  const allowCustomStart = feeVisibilityForTerms(listingPricingLeaseTabs(draft)).customStartSurcharge;
  const patchBundle = (next: Partial<ManagerBundleRow>) => {
    patch({ bundles: draft.bundles.map((b) => (b.id === bundle.id ? { ...b, ...next } : b)) });
  };
  const copySources = pricingCopySourceBundles(draft, bundle.id, activeTerm);
  const copyValue = bundle.copyFromBundleIdByTerm?.[activeTerm] ?? "";
  const isStay = activeStepId === SHORT_TERM_LEASE_TERM;
  const bundleLabel = bundle.label?.trim() || "Bundle";
  const bundleFeeScopeId = bundle.id;
  const bundleRentMonthly = parseMoneyAmount(bundle.price ?? "");
  return (
    <>
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
            <FactRow label="Deposit">
              <MoneyInput
                label="Bundle short-term deposit"
                value={bundle.shortTermDeposit ?? bundle.securityDeposit ?? ""}
                onChange={(v) => patchBundle({ shortTermDeposit: v })}
              />
            </FactRow>
            <FactRow label="Move-in fee">
              <MoneyInput
                label="Bundle short-term move-in fee"
                value={bundle.shortTermMoveInFee ?? ""}
                onChange={(v) => patchBundle({ shortTermMoveInFee: v })}
              />
            </FactRow>
            <FeeRows
              sub={draft}
              patch={patch}
              roomId={bundleFeeScopeId}
              roomName={bundleLabel}
              term={quoteTerm}
            />
          </>
        ) : (
          <>
            <FactRow label="Rent /mo">
              <MoneyInput
                label="Bundle rent"
                value={bundle.price ?? ""}
                onChange={(v) => patchBundle({ price: v })}
              />
            </FactRow>
            <FactRow label="Utilities /mo">
              <MoneyInput
                label="Bundle utilities"
                value={bundle.utilitiesEstimate ?? ""}
                onChange={(v) => patchBundle({ utilitiesEstimate: v })}
              />
            </FactRow>
            <FactRow label="Deposit">
              <MoneyInput
                label="Bundle deposit"
                value={bundle.securityDeposit ?? ""}
                onChange={(v) => patchBundle({ securityDeposit: v })}
              />
            </FactRow>
            <FactRow label="Move-in fee">
              <MoneyInput
                label="Bundle move-in fee"
                value={bundle.moveInFee ?? ""}
                onChange={(v) => patchBundle({ moveInFee: v })}
              />
            </FactRow>
            <FeeRows
              sub={draft}
              patch={patch}
              roomId={bundleFeeScopeId}
              roomName={bundleLabel}
              term={quoteTerm}
            />
            {allowCustomStart ? (
              <ProrateRows
                sub={draft}
                patch={patch}
                term={quoteTerm}
                roomId={bundleFeeScopeId}
                name={bundleLabel}
                automatic={(bundle.prorateMethod ?? "auto") !== "daily_rate"}
                onAutomatic={(next) => patchBundle({ prorateMethod: next ? "auto" : "daily_rate" })}
                rent={{
                  text: bundle.dailyRentRate ? String(bundle.dailyRentRate) : "",
                  placeholder: perDay(bundleRentMonthly) || "35",
                  onChange: (v) =>
                    patchBundle({
                      dailyRentRate: Number(v.replace(/[^0-9.]/g, "")) || undefined,
                    }),
                }}
                util={
                  Number((bundle.utilitiesEstimate ?? "").replace(/[^0-9.]/g, "")) > 0
                    ? {
                        text: bundle.dailyUtilitiesRate ? String(bundle.dailyUtilitiesRate) : "",
                        placeholder: perDay(
                          Number((bundle.utilitiesEstimate ?? "").replace(/[^0-9.]/g, "")),
                        ),
                        onChange: (v) =>
                          patchBundle({
                            dailyUtilitiesRate: Number(v.replace(/[^0-9.]/g, "")) || undefined,
                          }),
                      }
                    : null
                }
                dataAttr="property-bundle-pricing-prorate"
              />
            ) : null}
          </>
        )
      ) : (
        <p className="text-[13px] font-semibold text-muted">
          Mirroring another bundle — change Pricing to edit on its own.
        </p>
      )}
    </>
  );
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

  // Only a real edit asks before closing; opening and closing an untouched room is silent.
  const baseline = useMemo(() => JSON.stringify(normalizeManagerListingSubmissionV1(sub)), [sub]);
  const dirty = useMemo(() => JSON.stringify(draft) !== baseline, [draft, baseline]);

  const leaseTerms = useMemo(() => resolveAllowedLeaseTerms(draft), [draft]);
  /*
   * Month-to-month surcharge, Custom start surcharge and Partial months follow what is
   * OFFERED: the room's own Leases offered when it restricts them, else the listing's.
   * (A lease can start mid-month only on Custom, so Partial months rides with it.)
   */
  const feeVisibility = useMemo(
    () =>
      subject.kind === "room"
        ? roomPricingFeeVisibility(
            draft,
            draft.rooms.find((r) => r.id === subject.roomId),
          )
        : feeVisibilityForTerms(listingPricingLeaseTabs(draft)),
    [draft, subject],
  );
  const allowM2m = feeVisibility.monthToMonthSurcharge;
  const allowCustomStart = feeVisibility.customStartSurcharge;
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
      out.push({ id: SHORT_TERM_LEASE_TERM, label: "Short-term", summary: "" });
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
      if (subject.kind === "whole") {
        const summary =
          s.id === SHORT_TERM_LEASE_TERM
            ? draft.shortTermDailyCost?.trim()
              ? `$${draft.shortTermDailyCost.replace(/^\$/, "")}/night`
              : "—"
            : draft.entireHomeMonthlyRent && draft.entireHomeMonthlyRent > 0
              ? `$${draft.entireHomeMonthlyRent}/mo`
              : "—";
        return { ...s, summary };
      }
      if (subject.kind !== "room") return s;
      const room = draft.rooms.find((r) => r.id === subject.roomId);
      if (!room) return s;
      if (s.id === LONG_TERM_LEASE_TERM) {
        return { ...s, summary: propertyPricingRoomSummary(room, draft, draft.roomPricingMeta?.[room.id]) };
      }
      if (s.id === SHORT_TERM_LEASE_TERM || isStayLeaseTerm(s.id)) {
        const nightly = room.shortTermRent?.trim();
        return { ...s, summary: nightly ? `$${nightly.replace(/^\$/, "")}/night` : "—" };
      }
      return s;
    });
  }, [draft, leaseTerms, subject]);

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
    patch(roomPricingPatch(draft, roomId, next));
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
          const stepTitle =
            activeStepId === SHORT_TERM_LEASE_TERM
              ? "Short-term"
              : activeStepId === LONG_TERM_LEASE_TERM
                ? "Long-term"
                : String(activeStepId);
          return (
            <StepColumn>
              <StepHeading title={stepTitle} />
              <RoomPricingFields
                draft={draft}
                room={room}
                activeTerm={activeTerm}
                patch={patch}
                setDraft={(next) => setDraft(normalizeManagerListingSubmissionV1(next))}
                updateRoom={updateRoom}
              />
            </StepColumn>
          );
        })()
      : null;

  const wholeBody =
    subject.kind === "whole"
      ? (() => {
          const isStay = activeStepId === SHORT_TERM_LEASE_TERM;
          const isBaseLong = activeStepId === LONG_TERM_LEASE_TERM;
          const stepTitle = isStay ? "Short-term" : isBaseLong ? "Long-term" : String(activeStepId);
          return (
            <StepColumn>
              <StepHeading title={stepTitle} />
              <WholeHousePricingFields draft={draft} activeStepId={activeStepId} patch={patch} />
            </StepColumn>
          );
        })()
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
          const stepTitle = activeStepId === SHORT_TERM_LEASE_TERM ? "Short-term" : activeStepId === LONG_TERM_LEASE_TERM ? "Long-term" : String(activeStepId);
          return (
            <StepColumn>
              <StepHeading title={stepTitle} />
              <BundlePricingFields
                draft={draft}
                bundle={bundle}
                activeStepId={activeStepId}
                patch={patch}
                setDraft={(next) => setDraft(normalizeManagerListingSubmissionV1(next))}
              />
            </StepColumn>
          );
        })()
      : null;

  const center =
    subject.kind === "bundle"
      ? bundleBody
      : subject.kind === "whole"
        ? wholeBody
        : subject.kind === "room" && activeStepId !== "bundle"
          ? roomBody
          : null;

  if (!open) return null;

  return (
    <AddWorkspace
      title={subjectTitle(subject, draft)}
      subtitle={propertyLabel}
      steps={steps}
      current={step}
      onJump={jumpStep}
      onClose={onClose}
      dirty={dirty}
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
