"use client";

import { pricingSectionOptions } from "@/lib/pricing-lease-options";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AddWorkspace, workspaceSaveState, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  BundleWholePricingReceiptPanel,
  PricingReceiptPanel,
} from "@/components/portal/listing-wizard-v2/listing-side-panel";
import {
  FactRow,
  MoneyInput,
  SectionGroup,
  StepColumn,
  StepHeading,
  ToggleRow,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ArrangementPriceEditor } from "@/components/portal/listing-wizard-v2/listing-arrangement-editor";
import { perDay } from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import {
  PricingSubjectFields,
  type PricingSubjectAdapter,
} from "@/components/portal/listing-wizard-v2/pricing-subject-fields";
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
import type { WorkspacePricingDefaults } from "@/lib/workspace-pricing-defaults";
import { propertyPricingRoomSummary } from "@/lib/property-pricing-summary";
import {
  persistManagerListingSubmissionOnServer,
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

const moneyNumber = (raw: string) => Number(raw.replace(/[^0-9.]/g, "")) || 0;

/**
 * One room's pricing fields for one lease type step (Long-term, Short term ...): rent, utilities, deposit,
 * the fee rows and the standard fees. The pricing workspace's room step and the listing editor's inline
 * Pricing step draw this one component, so both edit exactly the same fields. A single-occupant room draws
 * the field list it shares with bundles and the whole house (`PricingSubjectFields`).
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
  const roomName = room.name?.trim() || "Room";
  const utilitiesAmount = moneyNumber(room.utilitiesEstimate ?? "");
  const adapter: PricingSubjectAdapter = {
    rent: {
      label: "Rent",
      value: room.monthlyRent > 0 ? String(room.monthlyRent) : "",
      onChange: (v) => updateRoom(room.id, { ...room, monthlyRent: moneyNumber(v) }),
    },
    utilities: {
      label: "Utilities",
      value: room.utilitiesEstimate ?? "",
      onChange: (v) => updateRoom(room.id, { ...room, utilitiesEstimate: v }),
    },
    deposit: {
      label: "Deposit",
      value: room.securityDeposit ?? "",
      onChange: (v) => updateRoom(room.id, { ...room, securityDeposit: v }),
    },
    nightly: {
      label: "Nightly rate",
      value: room.shortTermRent ?? "",
      onChange: (v) => updateRoom(room.id, { ...room, shortTermRent: v }),
    },
    shortDeposit: {
      label: "Deposit",
      value: room.shortTermDeposit ?? room.securityDeposit ?? "",
      onChange: (v) => updateRoom(room.id, { ...room, shortTermDeposit: v }),
    },
    feeScope: { roomId: room.id, roomName },
    prorate: {
      name: roomName,
      dataAttr: "property-room-pricing-prorate",
      automatic: (room.prorateMethod ?? "auto") !== "daily_rate",
      onAutomatic: (next) => updateRoom(room.id, { ...room, prorateMethod: next ? "auto" : "daily_rate" }),
      rent: {
        text: room.dailyRentRate ? String(room.dailyRentRate) : "",
        placeholder: perDay(room.monthlyRent) || "35",
        onChange: (v) => updateRoom(room.id, { ...room, dailyRentRate: moneyNumber(v) || undefined }),
      },
      util:
        utilitiesAmount > 0
          ? {
              text: room.dailyUtilitiesRate ? String(room.dailyUtilitiesRate) : "",
              placeholder: perDay(utilitiesAmount),
              onChange: (v) => updateRoom(room.id, { ...room, dailyUtilitiesRate: moneyNumber(v) || undefined }),
            }
          : null,
    },
    standardFees: {
      row: feeRowForStep(room, quoteTerm, isBaseLong),
      onPatch: (feePatch) => updateRoom(room.id, patchStandardFeesForTerm(room, quoteTerm, isBaseLong, feePatch)),
      storage: "term",
      inheritedRow: inheritedFeesForTerm(room, isBaseLong),
    },
  };
  return (
    <>
      {copySources.length > 0 ? (
        <FactRow label="Pricing">
          <FieldSingleSelect
            hideLabel
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
        cap > 1 ? (
          isStay ? (
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
          )
        ) : (
          <PricingSubjectFields draft={draft} patch={patch} term={activeTerm} visibility={feeVisibility} adapter={adapter} />
        )
      ) : null}
    </>
  );
}

/**
 * The whole house's pricing fields for one lease type step; the workspace and the inline Pricing step share it.
 * It draws the same field list as a room and a bundle (`PricingSubjectFields`), stored on the whole-house row.
 */
export function WholeHousePricingFields({
  draft,
  activeStepId,
  patch,
  offerToggle = true,
}: {
  draft: ManagerListingSubmissionV1;
  /** The pricing step's term id: Long-term or Short term. */
  activeStepId: string;
  patch: (next: Partial<ManagerListingSubmissionV1>) => void;
  /** "Offer the whole house" on a by-the-room listing. A caller that draws its own Offered switch passes false. */
  offerToggle?: boolean;
}) {
  const visibility = feeVisibilityForTerms(listingPricingLeaseTabs(draft), draft);
  const fees = draft.entireHomeArrangementFees ?? {};
  const patchWholeFees = (next: Partial<typeof fees>) => {
    patch({
      entireHomeArrangementFees: { ...fees, ...next },
      entireHomePriceSource: "own",
    });
  };
  const utilitiesAmount = moneyNumber(draft.entireHomeUtilitiesEstimate ?? "");
  const adapter: PricingSubjectAdapter = {
    rent: {
      label: "Whole house rent",
      value:
        draft.entireHomeMonthlyRent && draft.entireHomeMonthlyRent > 0 ? String(draft.entireHomeMonthlyRent) : "",
      onChange: (v) => patch({ entireHomeMonthlyRent: moneyNumber(v), entireHomePriceSource: "own" }),
    },
    utilities: {
      label: "Whole house utilities",
      value: draft.entireHomeUtilitiesEstimate ?? "",
      onChange: (v) => patch({ entireHomeUtilitiesEstimate: v, entireHomePriceSource: "own" }),
    },
    deposit: {
      label: "Whole house deposit",
      value: draft.securityDeposit ?? "",
      onChange: (v) => patch({ securityDeposit: v, entireHomePriceSource: "own" }),
    },
    nightly: {
      label: "Whole house nightly rate",
      value: draft.shortTermDailyCost ?? "",
      onChange: (v) => patch({ shortTermDailyCost: v, entireHomePriceSource: "own" }),
    },
    shortDeposit: {
      label: "Whole house deposit",
      value: draft.securityDeposit ?? "",
      onChange: (v) => patch({ securityDeposit: v, entireHomePriceSource: "own" }),
    },
    feeScope: { roomId: null },
    prorate: {
      name: "Whole house",
      dataAttr: "property-whole-pricing-prorate",
      automatic: (draft.entireHomeProrateMethod ?? "auto") !== "daily_rate",
      onAutomatic: (next) =>
        patch({ entireHomeProrateMethod: next ? "auto" : "daily_rate", entireHomePriceSource: "own" }),
      rent: {
        text: draft.entireHomeDailyRentRate ? String(draft.entireHomeDailyRentRate) : "",
        placeholder: perDay(draft.entireHomeMonthlyRent ?? 0) || "35",
        onChange: (v) =>
          patch({ entireHomeDailyRentRate: moneyNumber(v) || undefined, entireHomePriceSource: "own" }),
      },
      util:
        utilitiesAmount > 0
          ? {
              text: draft.entireHomeDailyUtilitiesRate ? String(draft.entireHomeDailyUtilitiesRate) : "",
              placeholder: perDay(utilitiesAmount),
              onChange: (v) =>
                patch({ entireHomeDailyUtilitiesRate: moneyNumber(v) || undefined, entireHomePriceSource: "own" }),
            }
          : null,
    },
    standardFees: { row: { count: 1, ...fees }, onPatch: patchWholeFees },
  };
  return (
    <>
      {offerToggle && !isEntireHomeListing(draft) ? (
        <ToggleRow
          label="Offer the whole house"
          checked={Boolean(draft.entireHomeOffered)}
          onChange={(on) => patch({ entireHomeOffered: on, entireHomePriceSource: "own" })}
          dataAttr="property-whole-house-offer"
        />
      ) : null}
      <PricingSubjectFields draft={draft} patch={patch} term={activeStepId} visibility={visibility} adapter={adapter} />
    </>
  );
}

/** A bundle's Lease fee / Application fee for one lease type: the entry a room's non-long-term step also uses. */
function bundleStepFees(bundle: ManagerBundleRow, term: string): { leaseFee?: string; applicationFee?: string } {
  const entry = bundle.termPricing?.[term];
  return { leaseFee: entry?.leaseFee, applicationFee: entry?.applicationFee };
}

/**
 * One bundle's pricing fields for one lease type step; the workspace and the inline Pricing step share it.
 * Same field list as a room and the whole house (`PricingSubjectFields`). A bundle keeps its Lease fee and
 * Application fee in `termPricing[term]` (the entry shape a room's non-long-term step uses), its Move-in fee
 * in `moveInFee` / `shortTermMoveInFee`, and its two start surcharges flat on the bundle.
 */
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
  const visibility = feeVisibilityForTerms(listingPricingLeaseTabs(draft), draft);
  const patchBundle = (next: Partial<ManagerBundleRow>) => {
    patch({ bundles: draft.bundles.map((b) => (b.id === bundle.id ? { ...b, ...next } : b)) });
  };
  const copySources = pricingCopySourceBundles(draft, bundle.id, activeTerm);
  const copyValue = bundle.copyFromBundleIdByTerm?.[activeTerm] ?? "";
  const isStay = isStayLeaseTerm(quoteTerm);
  const isBaseLong = quoteTerm === LONG_TERM_LEASE_TERM;
  const bundleLabel = bundle.label?.trim() || "Bundle";
  const bundleRentMonthly = parseMoneyAmount(bundle.price ?? "");
  const utilitiesAmount = moneyNumber(bundle.utilitiesEstimate ?? "");
  const stepFees = bundleStepFees(bundle, quoteTerm);
  const longFees = bundleStepFees(bundle, LONG_TERM_LEASE_TERM);
  const adapter: PricingSubjectAdapter = {
    rent: { label: "Bundle rent", value: bundle.price ?? "", onChange: (v) => patchBundle({ price: v }) },
    utilities: {
      label: "Bundle utilities",
      value: bundle.utilitiesEstimate ?? "",
      onChange: (v) => patchBundle({ utilitiesEstimate: v }),
    },
    deposit: {
      label: "Bundle deposit",
      value: bundle.securityDeposit ?? "",
      onChange: (v) => patchBundle({ securityDeposit: v }),
    },
    nightly: {
      label: "Nightly rate",
      value: bundle.shortTermNightlyRent ?? "",
      onChange: (v) => patchBundle({ shortTermNightlyRent: v }),
    },
    shortDeposit: {
      label: "Bundle short-term deposit",
      value: bundle.shortTermDeposit ?? bundle.securityDeposit ?? "",
      onChange: (v) => patchBundle({ shortTermDeposit: v }),
    },
    feeScope: { roomId: bundle.id, roomName: bundleLabel },
    prorate: {
      name: bundleLabel,
      dataAttr: "property-bundle-pricing-prorate",
      automatic: (bundle.prorateMethod ?? "auto") !== "daily_rate",
      onAutomatic: (next) => patchBundle({ prorateMethod: next ? "auto" : "daily_rate" }),
      rent: {
        text: bundle.dailyRentRate ? String(bundle.dailyRentRate) : "",
        placeholder: perDay(bundleRentMonthly) || "35",
        onChange: (v) => patchBundle({ dailyRentRate: moneyNumber(v) || undefined }),
      },
      util:
        utilitiesAmount > 0
          ? {
              text: bundle.dailyUtilitiesRate ? String(bundle.dailyUtilitiesRate) : "",
              placeholder: perDay(utilitiesAmount),
              onChange: (v) => patchBundle({ dailyUtilitiesRate: moneyNumber(v) || undefined }),
            }
          : null,
    },
    standardFees: {
      row: {
        count: 1,
        leaseFee: formatPlacementMoneyField(stepFees.leaseFee ?? ""),
        applicationFee: formatPlacementMoneyField(stepFees.applicationFee ?? ""),
        moveInFee: isStay ? bundle.shortTermMoveInFee : bundle.moveInFee,
        monthToMonthSurcharge: bundle.monthToMonthSurcharge,
        customStartSurcharge: bundle.customStartSurcharge,
      },
      onPatch: (feePatch) => {
        const { leaseFee, applicationFee, moveInFee, monthToMonthSurcharge, customStartSurcharge } = feePatch;
        const next: Partial<ManagerBundleRow> = {};
        if (moveInFee !== undefined) next[isStay ? "shortTermMoveInFee" : "moveInFee"] = moveInFee;
        if (monthToMonthSurcharge !== undefined) next.monthToMonthSurcharge = monthToMonthSurcharge;
        if (customStartSurcharge !== undefined) next.customStartSurcharge = customStartSurcharge;
        if (leaseFee !== undefined || applicationFee !== undefined) {
          next.termPricing = mergeTermStandardFees(bundle, quoteTerm, { leaseFee, applicationFee }).termPricing;
        }
        patchBundle(next);
      },
      storage: "term",
      inheritedRow: isBaseLong
        ? undefined
        : {
            leaseFee: formatPlacementMoneyField(longFees.leaseFee ?? ""),
            applicationFee: formatPlacementMoneyField(longFees.applicationFee ?? ""),
          },
    },
  };
  return (
    <>
      {copySources.length > 0 ? (
        <FactRow label="Pricing">
          <FieldSingleSelect
            hideLabel
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
        <PricingSubjectFields draft={draft} patch={patch} term={activeTerm} visibility={visibility} adapter={adapter} />
      ) : null}
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
  /** Which leasing option's tab is open (first by default); "What a resident pays" quotes that option. */
  const [optionId, setOptionId] = useState<string | null>(null);
  const [quoteRoomId, setQuoteRoomId] = useState<string | null>(
    subject.kind === "room" ? subject.roomId : null,
  );

  useEffect(() => {
    if (open) {
      setDraft(normalizeManagerListingSubmissionV1(sub));
      setOptionId(null);
      setQuoteRoomId(subject.kind === "room" ? subject.roomId : null);
    }
  }, [open, sub, subject]);

  // Only a real edit asks before closing; opening and closing an untouched room is silent.
  const baseline = useMemo(() => JSON.stringify(normalizeManagerListingSubmissionV1(sub)), [sub]);
  const dirty = useMemo(() => JSON.stringify(draft) !== baseline, [draft, baseline]);

  const leaseTerms = useMemo(() => resolveAllowedLeaseTerms(draft), [draft]);
  /*
   * Custom start surcharge and Partial months follow what is OFFERED: the room's own Leases
   * offered when it restricts them, else the listing's. (A lease can start mid-month only on
   * Custom, so Partial months rides with it.) Month-to-month has no surcharge any more.
   */
  const feeVisibility = useMemo(
    () =>
      subject.kind === "room"
        ? roomPricingFeeVisibility(
            draft,
            draft.rooms.find((r) => r.id === subject.roomId),
          )
        : feeVisibilityForTerms(listingPricingLeaseTabs(draft), draft),
    [draft, subject],
  );
  const allowM2m = feeVisibility.monthToMonthSurcharge;
  const allowCustomStart = feeVisibility.customStartSurcharge;
  /*
   * The left rail lists every leasing option the property offers (Long-term, Short-term, a custom lease by name,
   * Month-to-month only when a lease allows it); a tab shows ONLY that option's fields, and "What a resident
   * pays" quotes it. They are tabs of one screen, not steps: Save is always there.
   */
  const options = useMemo(() => pricingSectionOptions(draft), [draft]);
  const steps: AddWorkspaceStep[] = useMemo(() => options.map((option) => ({ id: option.id, label: option.label })), [options]);
  const currentIndex = Math.max(0, options.findIndex((option) => option.id === optionId));
  const activeOption = options[currentIndex] ?? options[0]!;
  const activeTerm = activeOption.term;
  const quoteTerm = listingPricingTabToLeaseTerm(activeTerm) ?? LONG_TERM_LEASE_TERM;

  /** The open option's fields, titled by the option. */
  const optionSection = (body: ReactNode, first: boolean) => (
    <div key={activeOption.id} data-attr={`property-pricing-section-${activeOption.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}>
      <SectionGroup title={activeOption.label} first={first}>
        {body}
      </SectionGroup>
    </div>
  );

  const patch: (next: Partial<ManagerListingSubmissionV1>) => void = (next) => {
    setDraft((prev) => normalizeManagerListingSubmissionV1({ ...prev, ...next }));
  };

  const updateRoom = (roomId: string, next: ManagerRoomSubmission) => {
    patch(roomPricingPatch(draft, roomId, next));
  };

  // Server-confirmed: the editor closes, and says "Pricing saved", only once the record is stored.
  const save = async () => {
    const normalized = normalizeManagerListingSubmissionV1(draft);
    if (!(await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, normalized))) {
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
          return (
            <StepColumn>
              {optionSection(
                <RoomPricingFields
                  draft={draft}
                  room={room}
                  activeTerm={activeTerm}
                  patch={patch}
                  setDraft={(next) => setDraft(normalizeManagerListingSubmissionV1(next))}
                  updateRoom={updateRoom}
                />,
                true,
              )}
            </StepColumn>
          );
        })()
      : null;

  const wholeBody =
    subject.kind === "whole" ? (
      <StepColumn>
        {optionSection(
          <WholeHousePricingFields draft={draft} activeStepId={activeTerm} patch={patch} offerToggle={currentIndex === 0} />,
          true,
        )}
      </StepColumn>
    ) : null;

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
          const roomOptions = draft.rooms.map((r, i) => ({
            value: r.id,
            label: r.name?.trim() || `Room ${i + 1}`,
          }));
          const selected = (bundle.includedRoomIds ?? []).filter((id) =>
            draft.rooms.some((r) => r.id === id),
          );
          return (
            <StepColumn>
              <SectionGroup title="Bundle" first>
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
              </SectionGroup>
              {optionSection(
                <BundlePricingFields
                  draft={draft}
                  bundle={bundle}
                  activeStepId={activeTerm}
                  patch={patch}
                  setDraft={(next) => setDraft(normalizeManagerListingSubmissionV1(next))}
                />,
                false,
              )}
            </StepColumn>
          );
        })()
      : null;

  const center = subject.kind === "bundle" ? bundleBody : subject.kind === "whole" ? wholeBody : roomBody;

  if (!open) return null;

  return (
    <AddWorkspace
      title={subjectTitle(subject, draft)}
      subtitle={propertyLabel}
      steps={steps}
      current={currentIndex}
      onJump={(index) => setOptionId(options[index]?.id ?? null)}
      tabRail
      finishCount={0}
      hideFooterStepCount
      onClose={onClose}
      dirty={dirty}
      saveState={workspaceSaveState({ dirty })}
      lastLabel="Save"
      onFinish={() => {
        void save().then((ok) => {
          if (ok) onClose();
        });
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
            allowCustomStart={allowCustomStart}
            allowMonthToMonthStart={allowM2m}
          />
        ) : subject.kind === "whole" ? (
          <BundleWholePricingReceiptPanel
            sub={draft}
            kind="whole"
            leaseTerm={quoteTerm}
            leaseTerms={leaseTerms}
            allowCustomStart={allowCustomStart}
            allowMonthToMonthStart={allowM2m}
          />
        ) : subject.kind === "bundle" ? (
          <BundleWholePricingReceiptPanel
            sub={draft}
            kind="bundle"
            bundleId={subject.bundleId}
            leaseTerm={quoteTerm}
            leaseTerms={leaseTerms}
            allowCustomStart={allowCustomStart}
            allowMonthToMonthStart={allowM2m}
          />
        ) : undefined
      }
    >
      <StepColumn><StepHeading title={steps[0]?.label ?? "Pricing"} /></StepColumn>
      <div className="plp-wizard-root plp-ws-col" data-rp-form>
        {center}
      </div>
    </AddWorkspace>
  );
}
