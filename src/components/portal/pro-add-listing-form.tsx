"use client";

import type { DragEvent, ReactNode } from "react";
import { Children, useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { Bath, DoorOpen, LayoutGrid, type LucideIcon } from "lucide-react";
import { useIsClient } from "@/hooks/use-is-client";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import {
  DEMO_LISTING_AUTOFILL_EVENT,
  DEMO_LISTING_SUBMITTED_EVENT,
} from "@/lib/demo/demo-playback";
import { Button } from "@/components/ui/button";
import { PortalListAddRow, PORTAL_LIST_ADD_ROW_WRAP_CLASS } from "@/components/portal/portal-list-add-row";
import { ModalShell, useModalPresentation } from "@/components/ui/modal";
import { MODAL_FULL_PAGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { cn } from "@/lib/utils";
import { buildListingModalAssistantContext } from "@/lib/listing-assistant-context";
import { LISTING_ASSISTANT_UPDATED_EVENT, type ListingAssistantUpdatedDetail } from "@/lib/listing-assistant-events";
import { Input, Select, Textarea } from "@/components/ui/input";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import {
  ListingUnifiedFeesTable,
  type FeeExpandableSection,
} from "@/components/portal/listing-unified-fees-table";
import { LISTING_FEE_PRESETS } from "@/lib/listing-fees";
import {
  submitManagerPendingPropertyToServer,
  syncPropertyPipelineFromServer,
  updateExtraListingFromSubmissionOnServer,
  updatePendingManagerPropertyOnServer,
} from "@/lib/demo-property-pipeline";
import {
  publishManagerPropertyDraftToServer,
  saveManagerPropertyDraftToServer,
  updateRequestChangeProperty,
} from "@/lib/demo-admin-property-inventory";
import {
  listingSubmissionFingerprint,
  listingWizardHasUnsavedInput,
  LISTING_DRAFT_AUTOSAVE_DEBOUNCE_MS,
  stripSubmissionDataUrls,
} from "@/lib/manager-listing-draft-autosave";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { sortRoomIndicesByFloor } from "@/lib/listing-floor-order";
import {
  fileListFromFiles,
  firstVideoFileFromDataTransfer,
  imageFilesFromDataTransfer,
  isImageUploadFile,
  isVideoUploadFile,
} from "@/lib/listing-media-drop";
import {
  scoreRoomMedia,
  shouldWarnOnPublish,
  summarizePropertyMediaReadiness,
  type RoomMediaScore,
} from "@/lib/listing-room-media-quality";
import { uploadLeaseTemplateDataUrl } from "@/lib/lease-template-storage";
import { getPortalListingNote } from "@/lib/portal-listing-notes";
import {
  managerPropertyLimitMessage,
  managerTierPropertyLimitReached,
  normalizeManagerSkuTier,
} from "@/lib/manager-access";
import { loadManagerPaymentWaiverGrantedClient } from "@/lib/manager-subscription-client";
import {
  listingProplaneAbsorbNeedsWaiverCode,
  listingServiceFeePayerUiValue,
  managerCanSelectManagerAbsorbServiceFee,
  normalizeListingPaymentWaiverCode,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import {
  applyListingBedroomSlots,
  applyListingBathroomSlots,
  listingTotalBathroomsIdFromCount,
  applyEntireHomeListingPricing,
  createDefaultListingSubmission,
  createNewListingWizardSubmission,
  customApplicationFieldKeyFromLabel,
  entireHomeMonthlyRentAmount,
  formatLeaseTermsBodyFromAllowed,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  normalizeRoomSizeSqft,
  resolveAllowedLeaseTerms,
  syncAirbnbLeaseTermInAllowed,
  syncShortTermLeaseTermInAllowed,
  duplicateRoomEntry,
  emptyBathroom,
  emptyBundleRow,
  emptyCustomFeeRow,
  emptyQuickFactRow,
  emptyRoom,
  emptySharedSpace,
  PAYMENT_AT_SIGNING_OPTIONS,
  type ManagerBathroomRoomAccessKind,
  type ManagerBathroomSubmission,
  type ManagerBundleRow,
  type ManagerCustomApplicationField,
  type ManagerCustomFeeRow,
  type ManagerListingSubmissionV1,
  type ManagerListingServiceOption,
  type ManagerQuickFactRow,
  type ManagerRoomSubmission,
  type ManagerSharedSpaceSubmission,
  type PaymentAtSigningOptionId,
  normalizeFlexibleRentBound,
  normalizeShortLeaseMaxMonths,
} from "@/lib/manager-listing-submission";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { applyListingFeeContextDefaults } from "@/lib/listing-fee-defaults";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";
import {
  LONG_TERM_UTILITIES_PAYMENT_OPTIONS,
  longTermUtilitiesEstimateRequired,
  utilitiesAmountFieldNoun,
  longTermUtilitiesPickerValue,
  resolveRoomUtilitiesPaymentModel,
  type UtilitiesPaymentModel,
} from "@/lib/listing-utilities-payment";
import {
  BATHROOM_EXTRA_AMENITY_PRESETS,
  HOUSE_WIDE_AMENITY_PRESETS,
  LISTING_BEDROOM_SLOT_OPTIONS,
  LISTING_PROPERTY_TYPE_OPTIONS,
  LISTING_STORIES_OPTIONS,
  LISTING_TOTAL_BATH_OPTIONS,
  ROOM_AMENITY_PRESETS,
  ROOM_FURNITURE_PRESETS,
  floorLevelSelectOptions,
  ROOM_FURNISHING_OPTIONS,
  SHARED_SPACE_AMENITY_PRESETS,
  SHARED_SPACE_KIND_OPTIONS,
  normalizeSharedSpaceKind,
  sharedSpaceAmenityPresetsForKind,
  pruneSharedSpaceAmenitiesForKind,
  type SharedSpaceKind,
  mergeFurnitureToggle,
  parseFurnitureSet,
  roomFurnishingIsFurnished,
  sanitizeRoomAmenityText,
  splitCommaSeparatedList,
  listingAmenityLinesFromValue,
} from "@/data/manager-listing-presets";
import { loadListingPresetConfig, type ListingPresetConfig } from "@/lib/site-content";
import {
  parseOptionalSanitizedMoneyNumber,
  parseSanitizedInteger,
  parseSanitizedMoneyNumber,
  sanitizeBuildingNameInput,
  sanitizeCityInput,
  sanitizeMoneyInput,
  sanitizePlaceNameInput,
  sanitizeStateInput,
  sanitizeStreetAddressInput,
  sanitizeZipInput,
} from "@/lib/listing-form-inputs";
import {
  applyListingLtFeeAmount,
  applyListingLtFeeAmountForRow,
  applyListingLtFeeToggle,
  applyListingStFeeAmount,
  applyListingStFeeToggle,
  deriveListingLtFeeToggles,
  deriveListingStFeeToggles,
  leaseLengthGatedHiddenFeeRowIds,
  LISTING_STANDARD_FEE_ROWS,
  type ListingFeeRowId,
  type ListingLtFeeToggles,
  type ListingStFeeToggles,
} from "@/lib/listing-fee-term-toggles";
import {
  applyPaymentAtSigningSelection,
  ensureSubmissionListingFees,
  parseRemovedStandardListingFeeRows,
  removedStandardListingFeeRowSet,
} from "@/lib/listing-fees";
import { bundleShortTermPriceLabel } from "@/lib/listing-bundle-short-term";
import { shortTermNightlyRate } from "@/lib/short-term-stay-pricing";
import { canNavigateToWizardStep } from "@/lib/wizard-step-nav";
import {
  buildListingStepFieldOrder,
  firstInvalidListingStep,
  listingBathroomNameKey,
  listingRoomDailyRentKey,
  listingRoomHasRent,
  listingRoomNameKey,
  listingRoomRentKey,
  listingRoomWeeklyRentKey,
  listingSharedSpaceNameKey,
  validateListingWizardStep,
} from "@/lib/listing-wizard-validation";
import { roomHeadlinePriceLabel, roomShortLeaseSurcharge } from "@/lib/room-pricing";
import { listingRoomPricingSummaryLabel } from "@/lib/rental-application/listing-fees-display";
import {
  scrollToFirstWizardFieldError,
  wizardFieldErrorClass,
  wizardSectionErrorClass,
} from "@/lib/wizard-field-errors";
import { LEASE_TERM_CHOICES } from "@/lib/rental-application/lease-terms";
import { AIRBNB_LEASE_TERM, CUSTOM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { usePortalContainer } from "@/components/ui/portal-container-context";

const selectInputCls =
  "min-h-[44px] w-full rounded-xl border border-white/20 bg-[#1c2433] px-3.5 py-2.5 text-[14px] text-foreground outline-none transition focus:border-primary/50 focus:bg-[#232c3d] focus:ring-2 focus:ring-primary/20 [html[data-theme=light]_&]:border-border [html[data-theme=light]_&]:bg-auth-input-bg [html[data-theme=light]_&]:focus:bg-card";

const listingTextInputCls =
  "rounded-xl border-white/20 bg-[#1c2433] [html[data-theme=light]_&]:border-border [html[data-theme=light]_&]:bg-auth-input-bg";

function dedupeByLabel<T extends { label: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = item.label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const DEFAULT_LISTING_PRESETS: ListingPresetConfig = {
  houseWide: [...HOUSE_WIDE_AMENITY_PRESETS],
  sharedSpace: [...SHARED_SPACE_AMENITY_PRESETS],
  bathroom: [...BATHROOM_EXTRA_AMENITY_PRESETS],
  room: [...ROOM_AMENITY_PRESETS],
  furniture: [...ROOM_FURNITURE_PRESETS],
  availability: [],
  furnishing: ROOM_FURNISHING_OPTIONS,
};

/** Blue-outlined ADD row — same affordance as Properties → Add property. */
const LISTING_WIZARD_ADD_ROW_CLASS =
  "!border-solid min-h-[7rem] border-2 border-primary bg-card shadow-none hover:border-primary hover:bg-primary/[0.04] sm:min-h-[8.5rem] sm:py-10 [&>svg]:h-8 [&>svg]:w-8 sm:[&>svg]:h-9 sm:[&>svg]:w-9";

function ListingWizardListAddRow({
  label,
  ariaLabel,
  icon,
  onClick,
  disabled,
  dataAttr,
  inline = false,
}: {
  label: string;
  ariaLabel: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  dataAttr: string;
  inline?: boolean;
}) {
  return (
    <div className={cn(PORTAL_LIST_ADD_ROW_WRAP_CLASS, inline ? "py-3 sm:py-4" : undefined)}>
      <PortalListAddRow
        label={label}
        ariaLabel={ariaLabel}
        icon={icon}
        onClick={onClick}
        disabled={disabled}
        dataAttr={dataAttr}
        inline={inline}
        className={LISTING_WIZARD_ADD_ROW_CLASS}
      />
    </div>
  );
}

function FormSection({
  id,
  title,
  description,
  children,
  compact,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <section id={id} className={compact ? "space-y-3" : "space-y-5"}>
      <header>
        <h3 className="text-base font-bold tracking-tight text-foreground sm:text-[17px]">{title}</h3>
        {description ? (
          <p className={`max-w-3xl text-muted ${compact ? "mt-1 text-xs leading-snug" : "mt-1.5 text-[13px] leading-relaxed"}`}>
            {description}
          </p>
        ) : null}
      </header>
      <div className={compact ? "space-y-3" : "space-y-5"}>{children}</div>
    </section>
  );
}

function ListingWizardChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-90" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * In rent-by-bedroom mode the security deposit lives inside each Room (and Bundle)
 * dropdown, so it is hidden from — and not re-addable in — the shared "Other fees"
 * table. Entire-home listings have no per-room UI, so they keep it in Other fees.
 */
const RENT_BY_ROOM_HIDDEN_FEE_ROWS: ReadonlySet<ListingFeeRowId> = new Set(["securityDeposit"]);

/** Right-aligned headline value on a wizard list row (rent, bathroom type). */
function ListingWizardRowMeta({ value, muted = false }: { value: string; muted?: boolean }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold tabular-nums ${
        muted
          ? "border border-dashed border-border bg-card text-muted"
          : "bg-primary/[0.08] text-primary"
      }`}
    >
      {value}
    </span>
  );
}

const LISTING_WIZARD_ACTION_BTN = "h-8 rounded-full px-3 text-xs";
const LISTING_WIZARD_REMOVE_BTN = `${LISTING_WIZARD_ACTION_BTN} shrink-0 border-rose-200 text-rose-800 portal-danger-outline`;

function roomMediaTierBadgeClass(score: RoomMediaScore): string {
  if (score.tier === "gold") {
    return "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  }
  if (score.tier === "silver") {
    return "border border-sky-200 bg-sky-50 text-sky-900 [html[data-theme=dark]_&]:border-sky-800 [html[data-theme=dark]_&]:bg-sky-950/40 [html[data-theme=dark]_&]:text-sky-200";
  }
  if (score.tier === "bronze") {
    return "border border-amber-200 bg-amber-50 text-amber-900 [html[data-theme=dark]_&]:border-amber-800 [html[data-theme=dark]_&]:bg-amber-950/40 [html[data-theme=dark]_&]:text-amber-200";
  }
  return "border border-rose-200 bg-rose-50 text-rose-800 [html[data-theme=dark]_&]:border-rose-800 [html[data-theme=dark]_&]:bg-rose-950/40 [html[data-theme=dark]_&]:text-rose-200";
}

function RoomMediaTierBadge({ score }: { score: RoomMediaScore }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${roomMediaTierBadgeClass(score)}`}
      data-testid="room-media-tier-badge"
    >
      {score.label}
    </span>
  );
}

function listingItemKey(kind: string, id: string) {
  return `${kind}:${id}`;
}

/**
 * One row per room, bathroom or shared space — collapsed it is a list row, open
 * it is the editor.
 *
 * `meta` is the right-aligned answer the row exists to show: a room's rent, a
 * bathroom's type. Collapsed, these steps used to show a bare name and nothing
 * else, so comparing two rooms' rent meant opening both — the thing a manager
 * most wants to see side by side (PRP-137/138/139). The facts belong in the row.
 */
function ListingWizardCollapsibleCard({
  expanded,
  onToggle,
  title,
  subtitle,
  meta,
  headerActions,
  hasError,
  bodyClassName = "p-4 sm:p-5",
  toggleDataAttr,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  title: string;
  subtitle?: string;
  /** Right-aligned headline value (rent, type). Shown collapsed AND open. */
  meta?: ReactNode;
  headerActions?: ReactNode;
  hasError?: boolean;
  bodyClassName?: string;
  toggleDataAttr?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border bg-card shadow-sm ${hasError ? "border-red-300 ring-2 ring-red-100" : "border-border"}`}
    >
      <div
        className={`flex flex-col gap-3 bg-accent/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4 ${expanded ? "border-b border-border" : ""}`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left sm:items-center"
          aria-expanded={expanded}
          data-attr={toggleDataAttr}
          onClick={onToggle}
        >
          <ListingWizardChevron open={expanded} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-foreground">{title}</p>
            {subtitle ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{subtitle}</p> : null}
          </div>
          {meta ? <div className="ml-auto shrink-0 self-center pl-2">{meta}</div> : null}
        </button>
        {headerActions ? (
          <div className="flex flex-wrap gap-2 pl-6 sm:pl-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {headerActions}
          </div>
        ) : null}
      </div>
      {expanded ? <div className={bodyClassName}>{children}</div> : null}
    </div>
  );
}

const MAX_IMG_BYTES = 10 * 1024 * 1024;
const MAX_HOUSE_PHOTOS = 12;
/** Max pixel width after compression. */
const IMG_MAX_WIDTH = 1280;
const IMG_QUALITY = 0.75;

function mediaDropZoneClass(active: boolean) {
  return `rounded-xl border border-dashed p-4 transition ${
    active
      ? "border-primary/50 bg-primary/[0.06] shadow-[inset_0_0_0_1px_rgba(37,99,235,0.18)]"
      : "border-border bg-card hover:border-primary/30 hover:bg-primary/[0.03]"
  }`;
}

const MEDIA_PICK_BTN_CLASS =
  "inline-flex cursor-pointer items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:border-primary/35 hover:bg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-60";

/** Programmatic file picker — avoids label/htmlFor inside overflow-hidden modals blanking the UI. */
function MediaPickTrigger({
  accept,
  multiple,
  disabled,
  className,
  onFiles,
  children,
}: {
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  onFiles: (files: FileList | null) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px opacity-0"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        className={className ?? MEDIA_PICK_BTN_CLASS}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          inputRef.current?.click();
        }}
      >
        {children}
      </button>
    </>
  );
}


function LongTermUtilitiesPaymentPicker({
  value,
  onSelect,
}: {
  value: UtilitiesPaymentModel | undefined;
  onSelect: (model: UtilitiesPaymentModel) => void;
}) {
  const selected = longTermUtilitiesPickerValue(value);
  return (
    <div>
      <FieldLabel>Utilities</FieldLabel>
      <Select
        aria-label="Utilities payment"
        className={selectInputCls}
        value={selected}
        onChange={(e) => onSelect(e.target.value as UtilitiesPaymentModel)}
      >
        {LONG_TERM_UTILITIES_PAYMENT_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * The one segmented toggle used across the wizard (rounds 25–26). Two invariants make it a
 * peer of the money inputs it sits beside, not a smaller afterthought:
 *  - **Equal-width segments** — an inline grid with `auto-cols-fr` sizes every column to the
 *    widest label, so Auto / Set per day is symmetrical instead of hugging each label.
 *  - **Input height** — `min-h-[44px]` matches the shared field height (`fieldBase`), so a
 *    row of [toggle][input][input] is one clean line with its labels on a shared baseline.
 * Built once so it holds on the room, grouped-lease and whole-place panels alike.
 */
function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "inline-grid min-h-[44px] grid-flow-col auto-cols-fr items-stretch rounded-2xl border border-border bg-card p-1",
        className,
      )}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center justify-center rounded-xl px-3 text-center text-xs font-medium transition-colors",
              active ? "bg-primary/10 text-primary" : "text-muted hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ProrationMethodFields({
  prorateMethod,
  monthlyRent,
  dailyRentRate,
  dailyUtilitiesRate,
  onMethod,
  onDailyRent,
  onDailyUtilities,
}: {
  prorateMethod: "auto" | "daily_rate";
  monthlyRent: number;
  dailyRentRate?: number;
  dailyUtilitiesRate?: number;
  onMethod: (m: "auto" | "daily_rate") => void;
  onDailyRent: (n: number | undefined) => void;
  onDailyUtilities: (n: number | undefined) => void;
}) {
  // Prorated rent: Auto = (rent + utilities) ÷ days in month; "Set per day" bills an
  // explicit per-day rent AND per-day utilities separately.
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <FieldLabel hint={prorateMethod === "auto" ? "Auto = (rent + utilities) ÷ days in the month." : undefined}>
          Prorated rent
        </FieldLabel>
        <SegmentedToggle
          ariaLabel="Prorated rent method"
          value={prorateMethod}
          onChange={onMethod}
          options={[
            { value: "auto", label: "Auto" },
            { value: "daily_rate", label: "Set per day" },
          ]}
        />
      </div>
      {prorateMethod === "daily_rate" ? (
        <>
          <div>
            <FieldLabel>Rent / day</FieldLabel>
            <MoneyInput
              value={dailyRentRate ?? ""}
              onChange={(e) => onDailyRent(parseOptionalSanitizedMoneyNumber(e.target.value))}
              placeholder={monthlyRent > 0 ? String(Math.ceil(monthlyRent / 30)) : "28"}
            />
          </div>
          <div>
            <FieldLabel>Utilities / day</FieldLabel>
            <MoneyInput
              value={dailyUtilitiesRate ?? ""}
              onChange={(e) => onDailyUtilities(parseOptionalSanitizedMoneyNumber(e.target.value))}
              placeholder="6"
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The LONG-TERM half of a rent row.
 *
 * It used to be loose, unlabelled fields sitting directly above a boxed and
 * clearly-titled "Short-term" section. The asymmetry was the problem a manager
 * ran into (PRP-146): the short stay announced itself, the monthly terms did
 * not, so the row read as one pile of money fields with a short-term box tacked
 * on. Both halves are now sections with a heading, so which rate you are typing
 * is never in question.
 *
 * Rendered only when the listing offers short-term stays too. On a long-term-only
 * listing there is nothing to distinguish it FROM, and a lone "Long-term" heading
 * over the only pricing on the page is noise.
 */
function LongTermRentSection({ heading, children }: { heading: boolean; children: ReactNode }) {
  if (!heading) return <>{children}</>;
  return (
    <div className="w-full rounded-lg border border-dashed border-border bg-accent/10 p-3">
      <FieldLabel hint="Monthly rate, billed with utilities and fees.">Long-term</FieldLabel>
      <div className="mt-1 flex w-full flex-wrap items-end gap-x-4 gap-y-2">{children}</div>
    </div>
  );
}

/**
 * The dedicated SHORT-TERM section on every rent row (round 20) — room, grouped lease, and
 * whole-place. It appears only when the listing offers short-term stays and holds an ALL-IN
 * nightly rent plus a short-term move-in fee and deposit. There is NO utilities control here
 * by design: the short-term rate is all-in, so a short-term booking never bills a separate
 * utilities line. Long-term values on the same row are untouched — these are a separate set.
 */
function ShortTermRentSection({
  labelFor,
  rent,
  moveInFee,
  deposit,
  onRent,
  onMoveIn,
  onDeposit,
  rentInvalid,
}: {
  labelFor?: string;
  rent: string;
  moveInFee: string;
  deposit: string;
  onRent: (sanitized: string) => void;
  onMoveIn: (sanitized: string) => void;
  onDeposit: (sanitized: string) => void;
  rentInvalid?: boolean;
}) {
  const suffix = labelFor ? ` for ${labelFor}` : "";
  return (
    <div className="w-full rounded-lg border border-dashed border-border bg-accent/10 p-3">
      <FieldLabel hint="All-in nightly rate — no separate utilities.">Short-term</FieldLabel>
      <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-2">
        <GridField>
          <FieldLabel>Rent / night</FieldLabel>
          <MoneyInput
            ariaLabel={`Short-term nightly rent${suffix}`}
            invalid={rentInvalid}
            value={rent}
            onChange={(e) => onRent(sanitizeMoneyInput(e.target.value))}
            placeholder="85"
          />
        </GridField>
        <GridField>
          <FieldLabel>Move-in fee</FieldLabel>
          <MoneyInput
            ariaLabel={`Short-term move-in fee${suffix}`}
            value={moveInFee}
            onChange={(e) => onMoveIn(sanitizeMoneyInput(e.target.value))}
            placeholder="150"
          />
        </GridField>
        <GridField>
          <FieldLabel>Security deposit</FieldLabel>
          <MoneyInput
            ariaLabel={`Short-term deposit${suffix}`}
            value={deposit}
            onChange={(e) => onDeposit(sanitizeMoneyInput(e.target.value))}
            placeholder="300"
          />
        </GridField>
      </div>
    </div>
  );
}

/**
 * Compact dollar-amount input — a short value should look like one. Fixed narrow
 * width with an inline `$` affix, used across the Pricing step's amount fields.
 */
function MoneyInput({
  value,
  onChange,
  placeholder,
  disabled,
  invalid,
  ariaLabel,
  className,
}: {
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={`relative w-full max-w-[11rem] ${className ?? ""}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">$</span>
      <Input
        inputMode="decimal"
        aria-label={ariaLabel}
        disabled={disabled}
        className={wizardFieldErrorClass(Boolean(invalid), "pl-7")}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  );
}

/** Tile icon per shared-space kind — recognisable beats a wall of identical pills (PRP-139). */
const SHARED_SPACE_KIND_ICONS: Record<string, string> = {
  kitchen: "🍳",
  living: "🛋️",
  laundry: "🧺",
  outdoor: "🌳",
  workspace: "💻",
  other: "🪑",
};

const SHARED_SPACE_TEMPLATES = [
  {
    label: "Kitchen & dining",
    kind: "kitchen" as const,
    detail: "",
    amenities: ["Refrigerator", "Microwave", "Oven / range", "Dishwasher"],
  },
  {
    label: "Living room / lounge",
    kind: "living" as const,
    detail: "",
    amenities: ["Living / lounge seating", "Couch / sofa", "TV in common area"],
  },
  {
    label: "Laundry",
    kind: "laundry" as const,
    detail: "",
    amenities: ["Washer / dryer", "Laundry sink"],
  },
  {
    label: "Outdoor / yard",
    kind: "outdoor" as const,
    detail: "",
    amenities: ["Patio / deck seating", "BBQ grill", "Yard / lawn"],
  },
  {
    label: "Workspace",
    kind: "workspace" as const,
    detail: "",
    amenities: ["Desk / workspace", "Office chair"],
  },
] as const;

/** Ignore the second click of a double-click on wizard template tiles (detail > 1). */
function ignoreMultiClick(e: { detail: number }) {
  return e.detail > 1;
}

function buildBathroomPreset(
  index: number,
  type: "full" | "half" | "ensuite",
): ManagerBathroomSubmission {
  const base = emptyBathroom(index);
  const preset =
    type === "half"
      ? { shower: false, bathtub: false, toilet: true, sink: true, mirror: false }
      : type === "ensuite"
        ? { shower: true, bathtub: false, toilet: true, sink: true, mirror: true, allResidents: false }
        : { shower: true, bathtub: false, toilet: true, sink: true, mirror: true };
  return {
    ...base,
    ...preset,
    name: `Bathroom ${index + 1}`,
  };
}

const LISTING_FORM_STEPS = [
  { id: "home",        label: "Home",           icon: "🏠" },
  { id: "rooms",       label: "Rooms",          icon: "🛏" },
  { id: "bathrooms",   label: "Bathrooms",      icon: "🚿" },
  { id: "spaces",      label: "Shared spaces",  icon: "🪑" },
  { id: "lease",       label: "Pricing",        icon: "💰" },
  { id: "finish",      label: "Submit",         icon: "✅" },
] as const;

/** Public listing preview tabs — same steps as the full wizard (marketing + submit). */
export const LISTING_PREVIEW_STEP_IDS = ["home", "rooms", "bathrooms", "spaces", "lease", "finish"] as const;

export type ListingWizardScope = "full" | "preview";

export function listingWizardStepIndices(scope: ListingWizardScope): number[] {
  if (scope === "full") return LISTING_FORM_STEPS.map((_, i) => i);
  const previewIds = new Set<string>(LISTING_PREVIEW_STEP_IDS);
  return LISTING_FORM_STEPS.map((step, i) => (previewIds.has(step.id) ? i : -1)).filter((i) => i >= 0);
}

const LISTING_STEP_COUNT = LISTING_FORM_STEPS.length;

/** A step position restored from a saved draft, clamped to a step that exists today. */
function clampWizardStep(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(LISTING_STEP_COUNT - 1, Math.max(0, Math.floor(value)));
}

const LISTING_STEP_BLURBS: Record<(typeof LISTING_FORM_STEPS)[number]["id"], string> = {
  home:        "Property type, address, layout, move-in access, amenities, and photos.",
  rooms:       "Bedroom names, floor, furnishing, amenities, and room move-in notes when renting by room.",
  bathrooms:   "Bathroom name, location, and amenities for the public listing.",
  spaces:      "Shared areas — name, location, and amenities (kitchen, laundry, lounge, outdoor).",
  lease:       "Rent, utilities, lease lengths, deposits, and fees.",
  finish:      "Sidebar quick facts and final submit.",
};

/** Reads a file and returns a compressed JPEG data URL. Falls back to raw data URL for non-image files. */
/** Yields control back to the browser so it can paint/handle input before heavy work. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function fileToDataUrl(file: File, maxBytes: number): Promise<string | null> {
  if (file.size > maxBytes) return null;
  if (!file.type.startsWith("image/")) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }
  return new Promise((resolve) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const scale = Math.min(1, IMG_MAX_WIDTH / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", IMG_QUALITY));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
    img.src = objectUrl;
  });
}

const TUS_CHUNK = 6 * 1024 * 1024; // 6 MB per chunk

async function uploadViaTus(file: File, path: string, mime: string, token: string, supabaseUrl: string): Promise<void> {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
  const metadata = [
    `bucketName ${b64("listing-photos")}`,
    `objectName ${b64(path)}`,
    `contentType ${b64(mime)}`,
    // Filenames are timestamp+random and never overwritten, so the object is
    // immutable — cache for a year to avoid re-fetching media on every view.
    `cacheControl ${b64("31536000")}`,
  ].join(",");

  const createRes = await fetch(`${supabaseUrl}/storage/v1/upload/resumable`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Length": "0",
      "Upload-Length": String(file.size),
      "Upload-Metadata": metadata,
      "Tus-Resumable": "1.0.0",
      "x-upsert": "false",
    },
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`TUS session failed (${createRes.status}): ${body}`);
  }
  const rawLoc = createRes.headers.get("Location");
  if (!rawLoc) throw new Error("TUS: no Location header in response");
  const location = rawLoc.startsWith("http") ? rawLoc : `${supabaseUrl}${rawLoc}`;

  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + TUS_CHUNK, file.size);
    const chunk = file.slice(offset, end);
    const patchRes = await fetch(location, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(end - offset),
        "Upload-Offset": String(offset),
        "Tus-Resumable": "1.0.0",
      },
      body: chunk,
    });
    if (!patchRes.ok) {
      const body = await patchRes.text().catch(() => "");
      throw new Error(`TUS chunk failed at offset ${offset} (${patchRes.status}): ${body}`);
    }
    offset = end;
  }
}

async function uploadToBucket(input: File | string): Promise<string> {
  const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser");
  const db = createSupabaseBrowserClient();
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error("Not signed in.");

  const userId = session.user.id;
  let body: Blob;
  let mime: string;
  let ext: string;

  if (typeof input === "string") {
    body = await fetch(input).then((r) => r.blob());
    mime = body.type || "image/jpeg";
    ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  } else {
    body = input;
    ext = input.name.split(".").pop()?.toLowerCase() ?? "mp4";
    mime = input.type || extToMime(ext);
  }

  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  // Use TUS resumable upload for large files (videos) to avoid Supabase's single-request size limit
  if (input instanceof File && input.size >= 10 * 1024 * 1024) {
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
    const token = session.access_token;
    await uploadViaTus(input, path, mime, token, supabaseUrl);
    return db.storage.from("listing-photos").getPublicUrl(path).data.publicUrl;
  }

  const { error } = await db.storage.from("listing-photos").upload(path, body, {
    contentType: mime,
    cacheControl: "31536000", // immutable object (unique filename); cache 1 year
    upsert: false,
    duplex: "half",
  });
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("Payload too large") || msg.includes("413") || msg.includes("exceeded")) {
      throw new Error("File is too large. Try splitting the video into shorter clips.");
    }
    throw new Error(msg || "Upload failed.");
  }
  return db.storage.from("listing-photos").getPublicUrl(path).data.publicUrl;
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
    webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska",
    wmv: "video/x-ms-wmv", flv: "video/x-flv",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif", heic: "image/heic",
  };
  return map[ext] ?? "application/octet-stream";
}

async function uploadDataUrl(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith("data:")) return dataUrl;
  // /demo has no signed-in Supabase session to upload against — keep the
  // data URL as-is so demo photos and lease templates round-trip locally.
  if (isDemoModeActive()) return dataUrl;
  return uploadToBucket(dataUrl);
}

type SubmissionMediaUpload = {
  submission: import("@/lib/manager-listing-submission").ManagerListingSubmissionV1;
  /** Attachments whose upload failed. They are dropped, never kept as base64. */
  failedCount: number;
};

/**
 * Uploads settle per attachment: one flaky object costs that object alone, and
 * every sibling that did land keeps its storage URL. A failed item is dropped
 * rather than left as a `data:` URL, so no caller can persist base64.
 */
async function uploadSubmissionMedia(
  sub: import("@/lib/manager-listing-submission").ManagerListingSubmissionV1,
): Promise<SubmissionMediaUpload> {
  let failedCount = 0;
  async function uploadOne(url: string | null | undefined): Promise<string | null> {
    if (!url) return url ?? null;
    try {
      return await uploadDataUrl(url);
    } catch (err) {
      console.error("manager-add-listing-form: attachment upload failed", err);
      failedCount += 1;
      return null;
    }
  }
  async function uploadAll(urls: string[]): Promise<string[]> {
    const settled = await Promise.all(urls.map((u) => uploadOne(u)));
    return settled.filter((u): u is string => typeof u === "string" && u.length > 0);
  }
  // Lease templates are the manager's own legal document, so they go to the
  // PRIVATE bucket, never through `uploadOne` (which publishes). Pickers already
  // upload on select; this only catches a legacy draft still carrying base64.
  async function uploadLeaseTemplate(url: string | null | undefined, name?: string | null) {
    if (!url) return url ?? null;
    try {
      return await uploadLeaseTemplateDataUrl(url, name);
    } catch (err) {
      console.error("manager-add-listing-form: lease template upload failed", err);
      failedCount += 1;
      return null;
    }
  }

  const [housePhotos, houseVideo, leaseTemplateDocUrl, propertyLeaseTemplates, propertyFloorPlan, floorPlanByLabel, rooms, bathrooms, sharedSpaces] = await Promise.all([
    uploadAll(sub.housePhotoDataUrls ?? []),
    uploadOne(sub.houseVideoDataUrl),
    uploadLeaseTemplate(sub.leaseTemplateDocUrl, sub.leaseTemplateDocName),
    // Per-property lease templates carry their own uploads and were previously
    // invisible to this pass, so a base64 PDF rode into `property_data` verbatim.
    sub.propertyLeaseTemplates
      ? Promise.all(
          sub.propertyLeaseTemplates.map(async (t) => ({
            ...t,
            leaseTemplateDocUrl: await uploadLeaseTemplate(t.leaseTemplateDocUrl, t.leaseTemplateDocName),
          })),
        )
      : Promise.resolve(undefined),
    uploadOne(sub.propertyFloorPlanDataUrl),
    (async () => {
      const entries = Object.entries(sub.floorPlanByLabel ?? {});
      if (entries.length === 0) return {} as Record<string, string>;
      const uploaded = await Promise.all(
        entries.map(async ([label, url]) => [label, await uploadOne(url)] as const),
      );
      return Object.fromEntries(
        uploaded.filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
      ) as Record<string, string>;
    })(),
    Promise.all(
      sub.rooms.map(async (r) => ({
        ...r,
        photoDataUrls: await uploadAll(r.photoDataUrls),
        videoDataUrl: await uploadOne(r.videoDataUrl),
      })),
    ),
    Promise.all(
      sub.bathrooms.map(async (b) => ({
        ...b,
        photoDataUrls: await uploadAll(b.photoDataUrls ?? []),
        videoDataUrl: await uploadOne(b.videoDataUrl),
      })),
    ),
    Promise.all(
      sub.sharedSpaces.map(async (s) => ({
        ...s,
        photoDataUrls: await uploadAll(s.photoDataUrls ?? []),
        videoDataUrl: await uploadOne(s.videoDataUrl),
      })),
    ),
  ]);

  return {
    submission: {
      ...sub,
      housePhotoDataUrls: housePhotos,
      houseVideoDataUrl: houseVideo,
      leaseTemplateDocUrl,
      ...(propertyLeaseTemplates ? { propertyLeaseTemplates } : {}),
      propertyFloorPlanDataUrl: propertyFloorPlan,
      floorPlanByLabel: Object.keys(floorPlanByLabel).length > 0 ? floorPlanByLabel : undefined,
      rooms,
      bathrooms,
      sharedSpaces,
    },
    failedCount,
  };
}

async function uploadVideoFile(file: File): Promise<string> {
  return uploadToBucket(file);
}

/**
 * One field's label. `required` marks a must-fill with a red asterisk;
 * `optional` prints a muted "Optional" tag so the two are never the same visual
 * weight (a plain optional input used to look identical to a required select).
 * Pass at most one of the two.
 */
function FieldLabel({
  children,
  hint,
  required,
  optional,
}: {
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
  optional?: boolean;
}) {
  // The hint sits INLINE on the same line as the label (round 17) so every field header is
  // one line tall — this keeps controls laid out in a row on a shared baseline instead of
  // some being pushed down by a two-line header.
  return (
    <div className="mb-1.5">
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs font-semibold text-foreground">
        <span>
          {children}
          {required ? <span className="text-red-600"> *</span> : null}
        </span>
        {optional && !required ? (
          <span className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            Optional
          </span>
        ) : null}
        {hint ? <span className="text-[11px] font-normal text-muted">{hint}</span> : null}
      </p>
    </div>
  );
}

function StepFieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs font-medium text-red-600">{msg}</p>;
}

/**
 * The one checkbox-group used for every preset list (amenities, furniture, …). A
 * "Select all" checkbox comes FIRST with a real indeterminate state; the presets follow
 * in a compact borderless grid; "Other" comes LAST and reveals a SMALL input holding ONLY
 * the custom (non-preset) values — no permanent notes box, nothing echoed. Value is the
 * stored newline list; the component preserves custom lines when presets toggle and vice
 * versa. Built once so the same pattern is solved the same way everywhere.
 */
function PresetCheckboxGroup({
  presets,
  value,
  onChange,
  otherForcedOpen,
  onOtherForcedOpenChange,
  columns = "sm:grid-cols-2 lg:grid-cols-3",
  otherPlaceholder = "Other, comma-separated",
}: {
  presets: readonly { id: string; label: string }[];
  value: string;
  onChange: (nextValue: string) => void;
  otherForcedOpen: boolean;
  onOtherForcedOpenChange: (open: boolean) => void;
  columns?: string;
  otherPlaceholder?: string;
}) {
  const presetLabels = presets.map((p) => p.label);
  const lines = listingAmenityLinesFromValue(value);
  const checked = new Set(lines.filter((l) => presetLabels.includes(l)));
  const custom = lines.filter((l) => !presetLabels.includes(l));
  const allChecked = presets.length > 0 && checked.size === presets.length;
  const someChecked = checked.size > 0 && !allChecked;
  const otherOpen = otherForcedOpen || custom.length > 0;
  const write = (nextChecked: Set<string>, nextCustom: string[]) =>
    onChange(
      [...presetLabels.filter((l) => nextChecked.has(l)), ...nextCustom.filter((entry) => entry.length > 0)].join("\n"),
    );
  const presetSelectionKey = [...checked].sort().join("|");
  const [otherDraft, setOtherDraft] = useState(() => custom.join(", "));
  useEffect(() => {
    if (!otherOpen) return;
    setOtherDraft(custom.join(", "));
  }, [presetSelectionKey, otherOpen]);
  return (
    <>
      <div className={`mt-1 grid gap-x-4 gap-y-1.5 sm:grid-cols-2 ${columns}`}>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 rounded border-border"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = someChecked;
            }}
            onChange={(e) => write(new Set(e.target.checked ? presetLabels : []), custom)}
          />
          <span className="font-medium text-muted">Select all</span>
        </label>
        {presets.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 rounded border-border"
              checked={checked.has(p.label)}
              onChange={(e) => {
                const next = new Set(checked);
                if (e.target.checked) next.add(p.label);
                else next.delete(p.label);
                write(next, custom);
              }}
            />
            <span className="font-medium text-foreground">{p.label}</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 rounded border-border"
            checked={otherOpen}
            onChange={(e) => onOtherForcedOpenChange(e.target.checked)}
          />
          <span className="font-medium text-foreground">Other</span>
        </label>
      </div>
      {otherOpen ? (
        <Input
          className="mt-2 h-9 text-sm"
          value={otherDraft}
          onChange={(e) => {
            const raw = e.target.value;
            setOtherDraft(raw);
            write(checked, splitCommaSeparatedList(raw));
          }}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={otherPlaceholder}
        />
      ) : null}
    </>
  );
}

/**
 * The select-all row for a room/item SELECTION group (bundle rooms, shared-space room
 * access). It is the FIRST checkbox in the grid with a genuine `indeterminate` state and
 * replaces the old "All rooms" / "Clear rooms" header buttons (round 18): one control that
 * checks everything, clears everything, and shows the partial state — keyboard and
 * screen-reader correct, matching PresetCheckboxGroup's own select-all above.
 */
function SelectAllCheckbox({
  allChecked,
  someChecked,
  onToggle,
  label = "Select all",
  disabled,
}: {
  allChecked: boolean;
  someChecked: boolean;
  onToggle: (checkAll: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-center gap-2 text-sm", disabled ? "cursor-default" : "cursor-pointer")}>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 rounded border-border disabled:opacity-60"
        checked={allChecked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = someChecked;
        }}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span className="font-medium text-muted">{label}</span>
    </label>
  );
}

/** In CSS grid rows, bottom-aligns the control with siblings when label/hint blocks differ in height. */
function GridField({ children, className }: { children: React.ReactNode; className?: string }) {
  const parts = Children.toArray(children);
  if (parts.length !== 2) {
    return <div className={className}>{children}</div>;
  }
  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ""}`}>
      <div className="shrink-0">{parts[0]}</div>
      <div className="mt-auto w-full shrink-0">{parts[1]}</div>
    </div>
  );
}

function ListingSubsection({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="space-y-5 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <div className="space-y-1.5">
        <h4 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h4>
        {description ? <p className="text-xs leading-relaxed text-muted">{description}</p> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function roomAccessSummary(space: ManagerSharedSpaceSubmission, rooms: ManagerRoomSubmission[]) {
  const ids = new Set(space.roomAccessIds ?? []);
  if (rooms.length === 0) return "No rooms added yet";
  if (ids.size === 0) return "No room access selected";
  if (ids.size === rooms.length) return "All rooms have access";
  return `${ids.size} of ${rooms.length} rooms have access`;
}

function roomLabelForBundle(room: ManagerRoomSubmission) {
  return room.name.trim() || `Room (${room.id.slice(-6)})`;
}

function bundleRoomsLine(roomIds: string[], rooms: ManagerRoomSubmission[]) {
  const names = roomIds.map((id) => rooms.find((room) => room.id === id)).filter(Boolean).map((room) => roomLabelForBundle(room!));
  if (names.length === 0) return "";
  return names.length === rooms.length ? `Whole house - ${names.length} rooms` : names.join(", ");
}

function bundleRentLabel(roomIds: string[], rooms: ManagerRoomSubmission[], entireHomeRent = 0) {
  if (entireHomeRent > 0) return `$${entireHomeRent}/mo`;
  const total = roomIds
    .map((id) => rooms.find((room) => room.id === id)?.monthlyRent ?? 0)
    .filter((rent) => Number.isFinite(rent) && rent > 0)
    .reduce((sum, rent) => sum + rent, 0);
  return total > 0 ? `$${total}/mo` : "";
}

export function ManagerAddListingForm({
  onClose,
  onSubmitted,
  showToast,
  skuTier,
  propCountBeforeSubmit,
  editPendingId = null,
  editListingId = null,
  editListingOwnerUserId = null,
  editRequestChangeId = null,
  editDraftId = null,
  initialSubmission = null,
  initialStepIndex = null,
  initialMaxStepReached = null,
  noteKey = null,
  wizardScope = "full",
  onSaved,
}: {
  onClose: () => void;
  onSubmitted: () => void;
  showToast: (m: string) => void;
  skuTier: string | null;
  propCountBeforeSubmit: number;
  editPendingId?: string | null;
  editListingId?: string | null;
  /** Owner's userId to use when saving edits to a linked listing (overrides the current user's id). */
  editListingOwnerUserId?: string | null;
  /** adminRefId of a "request change" (edits requested by admin) row to save back to. */
  editRequestChangeId?: string | null;
  /**
   * Record id of a saved draft being resumed. Publishing re-uses this id
   * (draft → live), and closing updates it in place rather than minting a
   * second draft row.
   */
  editDraftId?: string | null;
  initialSubmission?: ManagerListingSubmissionV1 | null;
  /** Wizard position saved with a draft, so resuming reopens where it was left. */
  initialStepIndex?: number | null;
  initialMaxStepReached?: number | null;
  /** Stable key for legacy localStorage house-detail notes, used to backfill houseRulesText if empty on the submission. */
  noteKey?: string | null;
  /** `preview` limits steps to public listing marketing content (floor plans, lease basics, amenities, etc.). */
  wizardScope?: ListingWizardScope;
  /** Called after progress is auto-saved as a draft, so the list surface can refresh. */
  onSaved?: () => void;
}) {
  const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => {
    const base = initialSubmission
      ? normalizeManagerListingSubmissionV1(initialSubmission)
      : createNewListingWizardSubmission();
    if (!noteKey || base.houseRulesText?.trim()) return base;
    const legacy = getPortalListingNote(noteKey);
    return {
      ...base,
      houseRulesText: base.houseRulesText?.trim() || legacy.houseRulesText || "",
      generalHouseInfo: base.generalHouseInfo?.trim() || legacy.generalHouseInfo || "",
    };
  });
  const [busy, setBusy] = useState(false);
  const [closingDraft, setClosingDraft] = useState(false);
  /**
   * Why the wizard refused to close. Shown inline in the footer because the
   * toast container renders below this modal's overlay — without it, a failed
   * draft save just reads as a broken Close button.
   */
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [demoAutofillSubmitPending, setDemoAutofillSubmitPending] = useState(false);
  const [paymentWaiverGranted, setPaymentWaiverGranted] = useState(false);
  const managerSkuTier = normalizeManagerSkuTier(skuTier) ?? "free";
  const canSelectManagerAbsorbFee = managerCanSelectManagerAbsorbServiceFee(managerSkuTier);
  const proplaneAbsorbNeedsWaiverCode = listingProplaneAbsorbNeedsWaiverCode(
    managerSkuTier,
    sub.serviceFeePayer,
    paymentWaiverGranted,
  );
  const serviceFeePayerUi = listingServiceFeePayerUiValue(
    sub.serviceFeePayer,
    managerSkuTier,
    paymentWaiverGranted,
  );
  const showProcessingFeeWaiveCode = serviceFeePayerUi === "proplane";

  useEffect(() => {
    if (isDemoModeActive()) return;
    void loadManagerPaymentWaiverGrantedClient().then(setPaymentWaiverGranted);
  }, []);
  const [assistantTriggerTarget, setAssistantTriggerTarget] = useState<HTMLSpanElement | null>(null);
  const resumedStepIndex = clampWizardStep(initialStepIndex);
  const resumedMaxStepReached = Math.max(clampWizardStep(initialMaxStepReached), resumedStepIndex);
  const [stepIndex, setStepIndex] = useState(resumedStepIndex);
  const [stepFieldErrors, setStepFieldErrors] = useState<Record<string, string>>({});
  const [maxStepReached, setMaxStepReached] = useState(() =>
    (editPendingId ?? editListingId ?? editRequestChangeId) ? LISTING_STEP_COUNT - 1 : resumedMaxStepReached,
  );
  // Portal to document.body once mounted, so this modal can't get visually trapped by an
  // ancestor that creates a containing block for fixed-position descendants (e.g. transform/filter).
  const mounted = useIsClient();
  const portalContainer = usePortalContainer();
  const [listingPresets, setListingPresets] = useState<ListingPresetConfig>(DEFAULT_LISTING_PRESETS);
  const [activeDropZone, setActiveDropZone] = useState<string | null>(null);
  const [serviceOffers, setServiceOffers] = useState<ManagerListingServiceOption[]>(() => {
    const normalized = normalizeManagerListingSubmissionV1(initialSubmission ?? createDefaultListingSubmission());
    return normalized.serviceRequestOptions ?? [];
  });
  const [expandedListingItems, setExpandedListingItems] = useState<Set<string>>(() => new Set());
  const [stFeeToggles, setStFeeToggles] = useState<ListingStFeeToggles>(() =>
    deriveListingStFeeToggles(
      normalizeManagerListingSubmissionV1(initialSubmission ?? createDefaultListingSubmission()),
    ),
  );
  const [ltFeeToggles, setLtFeeToggles] = useState<ListingLtFeeToggles>(() =>
    deriveListingLtFeeToggles(
      normalizeManagerListingSubmissionV1(initialSubmission ?? createDefaultListingSubmission()),
    ),
  );
  // Standard "Other fees" rows the manager removed — persisted on the submission so
  // normalize/sync does not re-materialize them on save or reload.
  const removedFeeRows = useMemo(
    () => removedStandardListingFeeRowSet(sub) as Set<ListingFeeRowId>,
    [sub.removedStandardListingFeeRows],
  );
  const hiddenStandardFeeRows = useMemo(() => {
    const hidden = new Set(leaseLengthGatedHiddenFeeRowIds(sub));
    if (!isEntireHomeListing(sub)) {
      for (const id of RENT_BY_ROOM_HIDDEN_FEE_ROWS) hidden.add(id);
    }
    return hidden;
  }, [
    sub.allowedLeaseTerms,
    sub.leaseTermsBody,
    sub.shortTermRentalsAllowed,
    sub.airbnbRentalsAllowed,
    sub.rolloverToMonthToMonth,
    sub.listingPlaceCategoryId,
  ]);
  // Furnishing is a "Furnished" checkbox (default off = unfurnished). This holds rooms the
  // manager just checked Furnished on that have no furniture ticked yet (an empty furnished
  // state the `furnishing` string alone can't represent), plus the furniture we remember so
  // unchecking + re-checking restores their picks instead of wiping them.
  const [furnishedOpenRooms, setFurnishedOpenRooms] = useState<Set<string>>(() => new Set());
  const rememberedFurnitureRef = useRef<Map<string, string>>(new Map());
  // "Rent by room" is the explicit stored signal that replaced the rental-model dropdown:
  // checked ⟺ shared-home (rent by bedroom), unchecked ⟺ entire-place (one rent for the
  // whole unit). Switching to entire-place syncs/zeroes per-room rents, so we remember each
  // room's pricing here and restore it when the manager switches back — unticking never
  // destroys amounts already entered.
  const rememberedRoomPricingRef = useRef<Map<string, Partial<ManagerRoomSubmission>>>(new Map());
  const handleRentByRoomToggle = (on: boolean) => {
    clearListingFieldError("listingPlaceCategoryId");
    clearListingFieldError("monthlyRent");
    setSub((s) => {
      if (on) {
        // → shared-home. Restore any remembered per-room pricing, then clear entire-home fields.
        const rooms = s.rooms.map((r) => {
          const remembered = rememberedRoomPricingRef.current.get(r.id);
          return remembered ? { ...r, ...remembered } : r;
        });
        return {
          ...s,
          rooms,
          listingPlaceCategoryId: "shared_home",
          rentalModelStamp: "shared_home",
          entireHomeMonthlyRent: undefined,
          entireHomeUtilitiesEstimate: undefined,
          entireHomeUtilitiesPaymentModel: undefined,
          entireHomeProrateMethod: undefined,
          entireHomeDailyRentRate: undefined,
          entireHomeDailyUtilitiesRate: undefined,
        };
      }
      // → entire-place. Remember current per-room pricing first (syncEntireHomeRoomPricing
      // will overwrite it), then seed the whole-home rent from the rooms.
      for (const r of s.rooms) {
        rememberedRoomPricingRef.current.set(r.id, {
          monthlyRent: r.monthlyRent,
          securityDeposit: r.securityDeposit,
          utilitiesEstimate: r.utilitiesEstimate,
          utilitiesPaymentModel: r.utilitiesPaymentModel,
          prorateMethod: r.prorateMethod,
          dailyRentRate: r.dailyRentRate,
          rentBasis: r.rentBasis,
          dailyRentPrice: r.dailyRentPrice,
        });
      }
      const sum = s.rooms.reduce((acc, room) => acc + (room.monthlyRent > 0 ? room.monthlyRent : 0), 0);
      const rent = (s.entireHomeMonthlyRent ?? 0) > 0 ? s.entireHomeMonthlyRent! : sum > 0 ? sum : s.rooms[0]?.monthlyRent ?? 0;
      return applyEntireHomeListingPricing(
        { ...s, listingPlaceCategoryId: "entire_home", rentalModelStamp: "entire_home" },
        { entireHomeMonthlyRent: rent },
      );
    });
  };
  // Rooms where the "Other amenities" small text box is revealed even though it is still
  // empty (the manager just ticked Other). Rooms that already have custom amenity text
  // read as open without needing to be in this set.
  const [otherAmenitiesOpenRooms, setOtherAmenitiesOpenRooms] = useState<Set<string>>(() => new Set());
  const toggleOtherAmenitiesOpen = (roomId: string, on: boolean) =>
    setOtherAmenitiesOpenRooms((prev) => {
      const next = new Set(prev);
      if (on) next.add(roomId);
      else next.delete(roomId);
      return next;
    });
  /**
   * Rooms whose furnishing "Other" write-in is open (AXI-136). Same shape as the
   * amenities toggle above: the box also counts as open whenever `detail`
   * already holds text, so a saved note is never hidden behind an unticked box.
   */
  const [otherFurnishingOpenRooms, setOtherFurnishingOpenRooms] = useState<Set<string>>(() => new Set());
  const toggleOtherFurnishingOpen = (roomId: string, on: boolean) =>
    setOtherFurnishingOpenRooms((prev) => {
      const next = new Set(prev);
      if (on) next.add(roomId);
      else next.delete(roomId);
      return next;
    });
  const roomIsFurnished = (room: ManagerRoomSubmission): boolean =>
    furnishedOpenRooms.has(room.id) || roomFurnishingIsFurnished(room.furnishing);
  const setRoomFurnished = (index: number, room: ManagerRoomSubmission, on: boolean) => {
    if (on) {
      const remembered = rememberedFurnitureRef.current.get(room.id);
      setFurnishedOpenRooms((prev) => new Set(prev).add(room.id));
      setRoom(index, { furnishing: remembered && remembered.toLowerCase() !== "unfurnished" ? remembered : "" });
    } else {
      if (room.furnishing.trim() && room.furnishing.trim().toLowerCase() !== "unfurnished") {
        rememberedFurnitureRef.current.set(room.id, room.furnishing);
      }
      setFurnishedOpenRooms((prev) => {
        const next = new Set(prev);
        next.delete(room.id);
        return next;
      });
      setRoom(index, { furnishing: "Unfurnished" });
    }
  };

  const toggleListingItem = (key: string) => {
    setExpandedListingItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandListingItem = (key: string) => {
    setExpandedListingItems((prev) => new Set(prev).add(key));
  };

  const isListingItemExpanded = (key: string) => expandedListingItems.has(key);

  const scrollRef = useRef<HTMLDivElement>(null);
  const submitListingRef = useRef<() => Promise<void>>(async () => {});
  // Object URLs for video preview (avoids putting huge base64 strings in <video src>).
  // Keyed by a stable id like "room-<id>", "bath-<id>", "space-<id>", "house".
  const [videoPreviewUrls, setVideoPreviewUrls] = useState<Record<string, string>>({});
  const videoPreviewUrlsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    videoPreviewUrlsRef.current = videoPreviewUrls;
  }, [videoPreviewUrls]);
  const { userId, ready: authReady } = useManagerUserId();
  const dedupedPresets = useMemo(
    () => ({
      furniture: dedupeByLabel(listingPresets.furniture),
      room: dedupeByLabel(listingPresets.room),
      bathroom: dedupeByLabel(listingPresets.bathroom),
      sharedSpace: dedupeByLabel(listingPresets.sharedSpace),
      houseWide: dedupeByLabel(listingPresets.houseWide),
    }),
    [listingPresets],
  );

  const isEditMode = Boolean(editPendingId ?? editListingId ?? editRequestChangeId);
  // The draft record this wizard owns. It starts as the resumed draft's id (if
  // any) and is filled in by the first auto-save; publishing re-uses it, so the
  // draft becomes the live listing rather than a second row.
  const draftIdRef = useRef<string | null>(editDraftId?.trim() || null);
  // Only the wizard that minted a provisional (`mgr-listing-…`) id may re-key it
  // once a property name exists. A RESUMED draft's id is the drafts-table row
  // key the list surface is rendering, so re-keying it would unmount the editor.
  const draftIdMintedHereRef = useRef(!editDraftId?.trim());
  // Sticky for the whole wizard session: a dropped attachment is already gone
  // from the form, so the manager has to be told even when the close that
  // dropped it went on to fail. Cleared only once a save actually reports it.
  const droppedAttachmentsRef = useRef(false);
  // Snapshot of what the wizard opened with, captured on the first render and
  // never recomputed. Closing only persists a draft when the manager actually
  // changed something since then — an untouched wizard must not litter the
  // Drafts stage with an "Untitled draft".
  const baselineFingerprintRef = useRef<string | null>(null);
  if (baselineFingerprintRef.current === null) {
    baselineFingerprintRef.current = listingSubmissionFingerprint({
      ...sub,
      serviceRequestOptions: serviceOffers,
    });
  }
  /** Last submission fingerprint successfully written to the drafts bucket or server. */
  const lastPersistedFingerprintRef = useRef<string | null>(
    editDraftId?.trim() || editListingId?.trim() || editPendingId?.trim() || editRequestChangeId?.trim()
      ? listingSubmissionFingerprint({
          ...(initialSubmission
            ? normalizeManagerListingSubmissionV1(initialSubmission)
            : createNewListingWizardSubmission()),
          serviceRequestOptions:
            normalizeManagerListingSubmissionV1(initialSubmission ?? createDefaultListingSubmission())
              .serviceRequestOptions ?? [],
        })
      : null,
  );
  const lastPersistedStepRef = useRef({ stepIndex: resumedStepIndex, maxStepReached: resumedMaxStepReached });
  // "saved-without-photos" exists because "saved" over a payload that lost
  // attachments is the sentence that made the loss invisible: the manager reads
  // it, believes their photos are stored, and finds out later.
  const [autosaveStatus, setAutosaveStatus] = useState<
    "idle" | "saving" | "saved" | "saved-without-photos" | "error"
  >("idle");
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveDirtyRef = useRef(false);
  const persistDraftRef = useRef<
    (opts?: { silent?: boolean; closeAfter?: boolean }) => Promise<boolean>
  >(() => Promise.resolve(false));
  const persistEditListingRef = useRef<
    (opts?: { advanceOnSuccess?: boolean; closeAfter?: boolean; silent?: boolean }) => Promise<boolean>
  >(() => Promise.resolve(false));
  const wizardSteps = useMemo(() => listingWizardStepIndices(wizardScope), [wizardScope]);
  const lastStepIndex = wizardSteps[wizardSteps.length - 1] ?? LISTING_STEP_COUNT - 1;
  const visibleStepPosition = Math.max(0, wizardSteps.indexOf(stepIndex));
  const visibleStepCount = wizardSteps.length;
  const isFinalStep = stepIndex === lastStepIndex;
  const isPreviewWizard = wizardScope === "preview";
  const wizardTitlePrefix = isPreviewWizard ? "Edit preview" : isEditMode ? "Edit listing" : "New listing";
  const [savedListingId, setSavedListingId] = useState<string | null>(
    () => editDraftId?.trim() || editPendingId?.trim() || editListingId?.trim() || editRequestChangeId?.trim() || null,
  );
  const listingAssistantContext = useMemo(
    () =>
      buildListingModalAssistantContext({
        wizardTitle: wizardTitlePrefix,
        stepLabel: LISTING_FORM_STEPS[stepIndex]?.label ?? "Create listing",
        // savedListingId mirrors draftIdRef at every render-observable point
        // (both start from editDraftId; every ref assignment of a real id also
        // sets it), and refs must not be read during render (react-hooks/refs).
        propertyId: savedListingId,
        submission: sub,
      }),
    [wizardTitlePrefix, stepIndex, savedListingId, sub],
  );

  useEffect(() => {
    const propertyId = savedListingId ?? draftIdRef.current;
    if (!propertyId?.trim() || !userId) return;
    const onAssistantUpdated = (event: Event) => {
      const detail = (event as CustomEvent<ListingAssistantUpdatedDetail>).detail;
      if (!detail || detail.propertyId !== propertyId) return;
      void (async () => {
        await syncPropertyPipelineFromServer({ userId, force: true });
        const hit = resolveManagerListingSubmissionForPropertyId(userId, propertyId);
        if (hit) {
          setSub(normalizeManagerListingSubmissionV1(hit.sub));
          showToast("Assistant added photos to your listing.");
        }
      })();
    };
    window.addEventListener(LISTING_ASSISTANT_UPDATED_EVENT, onAssistantUpdated);
    return () => window.removeEventListener(LISTING_ASSISTANT_UPDATED_EVENT, onAssistantUpdated);
  }, [savedListingId, showToast, userId]);

  // Revoke all object URLs on unmount.
  useEffect(() => {
    return () => {
      Object.values(videoPreviewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!isDemoModeActive()) return;
    const onAutofill = (e: Event) => {
      const detail = (e as CustomEvent<{ submission?: ManagerListingSubmissionV1; submitAfter?: boolean }>).detail;
      const submission = detail?.submission;
      if (!submission) return;
      const normalized = normalizeManagerListingSubmissionV1(submission);
      setSub(normalized);
      setServiceOffers(normalized.serviceRequestOptions ?? []);
      setMaxStepReached(LISTING_STEP_COUNT - 1);
      setStepIndex(LISTING_STEP_COUNT - 1);
      setStepFieldErrors({});
      if (detail?.submitAfter) setDemoAutofillSubmitPending(true);
    };
    window.addEventListener(DEMO_LISTING_AUTOFILL_EVENT, onAutofill as EventListener);
    return () => window.removeEventListener(DEMO_LISTING_AUTOFILL_EVENT, onAutofill as EventListener);
  }, []);

  const setVideoPreview = (key: string, file: File) => {
    setVideoPreviewUrls((prev) => {
      const old = prev[key];
      if (old) URL.revokeObjectURL(old);
      return { ...prev, [key]: URL.createObjectURL(file) };
    });
  };

  /** Remove the preview object URL for a video key, revoking it. */
  const clearVideoPreview = (key: string) => {
    setVideoPreviewUrls((prev) => {
      const old = prev[key];
      if (!old) return prev;
      URL.revokeObjectURL(old);
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const [videoUploadingKeys, setVideoUploadingKeys] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [stepIndex]);

  useEffect(() => {
    if (stepIndex !== 2) return;
    queueMicrotask(() =>
      setSub((s) => {
        const applied = applyListingBathroomSlots(s);
        return applied.ok ? applied.sub : s.bathrooms.length > 0 ? s : { ...s, bathrooms: [emptyBathroom(0)] };
      }),
    );
  }, [stepIndex]);

  useEffect(() => {
    let cancelled = false;
    loadListingPresetConfig()
      .then((presets) => {
        if (!cancelled) setListingPresets(presets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const isEntireHome = isEntireHomeListing(sub);
  const rentByRoom = !isEntireHome;
  const entireHomeRent = entireHomeMonthlyRentAmount(sub);

  const clearListingFieldError = (key: string) => {
    setStepFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const longTermLeaseEnabled = useMemo(() => {
    const longTermTerms = resolveAllowedLeaseTerms(sub).filter((t) => t !== SHORT_TERM_LEASE_TERM);
    return longTermTerms.length > 0;
  }, [sub]);

  const handleStFeeToggle = (feeId: ListingFeeRowId, enabled: boolean) => {
    setStFeeToggles((prev) => ({ ...prev, [feeId]: enabled }));
    setSub((s) => applyListingStFeeToggle(s, feeId, enabled, ltFeeToggles));
    const row = LISTING_STANDARD_FEE_ROWS.find((r) => r.id === feeId);
    if (row?.stField) clearListingFieldError(String(row.stField));
  };

  const handleStFeeAmount = (feeId: ListingFeeRowId, amount: string) => {
    const sanitized = sanitizeMoneyInput(amount);
    setSub((s) => applyListingStFeeAmount(s, feeId, sanitized));
    const row = LISTING_STANDARD_FEE_ROWS.find((r) => r.id === feeId);
    if (row?.stField) clearListingFieldError(String(row.stField));
    if (sanitized.trim()) {
      setStFeeToggles((prev) => ({ ...prev, [feeId]: true }));
    }
  };

  const handleLtFeeToggle = (feeId: ListingFeeRowId, enabled: boolean) => {
    setLtFeeToggles((prev) => ({ ...prev, [feeId]: enabled }));
    setSub((s) => applyListingLtFeeToggle(s, feeId, enabled, stFeeToggles));
    const row = LISTING_STANDARD_FEE_ROWS.find((r) => r.id === feeId);
    if (row?.ltField) clearListingFieldError(String(row.ltField));
    if (feeId === "rent") clearListingFieldError("monthlyRent");
  };

  // Delete a standard "Other fees" row entirely: turn both terms off (which clears the
  // backing amounts via applyListingLtFeeToggle/applyListingStFeeToggle) and hide it. Never
  // called for "rent" (the core price row is not removable).
  const handleRemoveStandardRow = (feeId: ListingFeeRowId) => {
    setSub((s) => {
      let next = applyListingLtFeeToggle(s, feeId, false);
      next = applyListingStFeeToggle(next, feeId, false);
      const removed = new Set(parseRemovedStandardListingFeeRows(next));
      removed.add(feeId);
      next = { ...next, removedStandardListingFeeRows: [...removed] };
      return ensureSubmissionListingFees(next);
    });
    setLtFeeToggles((prev) => ({ ...prev, [feeId]: false }));
    setStFeeToggles((prev) => ({ ...prev, [feeId]: false }));
    const row = LISTING_STANDARD_FEE_ROWS.find((r) => r.id === feeId);
    if (row?.ltField) clearListingFieldError(String(row.ltField));
    if (row?.stField) clearListingFieldError(String(row.stField));
  };

  const handleAddStandardRow = (feeId: ListingFeeRowId) => {
    setSub((s) =>
      ensureSubmissionListingFees({
        ...s,
        removedStandardListingFeeRows: parseRemovedStandardListingFeeRows(s).filter((id) => id !== feeId),
      }),
    );
  };

  const handleLtFeeAmount = (field: keyof ManagerListingSubmissionV1, amount: string) => {
    const sanitized = sanitizeMoneyInput(amount);
    setSub((s) => applyListingLtFeeAmount(s, field, sanitized));
    clearListingFieldError(String(field));
    if (field === "entireHomeMonthlyRent") {
      clearListingFieldError("monthlyRent");
      if (sanitized.trim() && sanitized !== ".") {
        setLtFeeToggles((prev) => ({ ...prev, rent: true }));
      }
    } else {
      const row = LISTING_STANDARD_FEE_ROWS.find((r) => r.ltField === field);
      if (row && sanitized.trim()) {
        setLtFeeToggles((prev) => ({ ...prev, [row.id]: true }));
      }
    }
  };

  const handleLtFeeAmountForRow = (feeId: ListingFeeRowId, amount: string) => {
    const sanitized = sanitizeMoneyInput(amount);
    setSub((s) => applyListingLtFeeAmountForRow(s, feeId, sanitized));
    const row = LISTING_STANDARD_FEE_ROWS.find((r) => r.id === feeId);
    if (row?.ltField) clearListingFieldError(String(row.ltField));
    if (sanitized.trim()) {
      setLtFeeToggles((prev) => ({ ...prev, [feeId]: true }));
    }
  };

  const validateListingStep = (i: number): Record<string, string> =>
    validateListingWizardStep(i, sub, {
      isEditMode,
      entireHomeRent,
      stFeeToggles,
      ltFeeToggles,
      managerSkuTier,
      accountPaymentWaiverGranted: paymentWaiverGranted,
    });

  const advanceFromCurrentStep = () => {
    if (stepIndex === 0) {
      const slots = sub.listingBedroomSlots ?? sub.rooms.length;
      let nextSub = sub;
      const appliedRooms = applyListingBedroomSlots(nextSub, slots);
      if (!appliedRooms.ok) {
        if (isEditMode) {
          nextSub = { ...nextSub, listingBedroomSlots: nextSub.rooms.length };
          showToast("Bedroom count was reset to match existing room rows so your layout updates can continue.");
        } else {
          showToast(appliedRooms.message);
          return;
        }
      } else {
        nextSub = appliedRooms.sub;
      }
      const appliedBaths = applyListingBathroomSlots(nextSub);
      if (!appliedBaths.ok) {
        if (isEditMode) {
          nextSub = {
            ...nextSub,
            listingTotalBathroomsId: listingTotalBathroomsIdFromCount(nextSub.bathrooms.length),
          };
          showToast("Bathroom count was reset to match existing bathroom rows so your layout updates can continue.");
        } else {
          showToast(appliedBaths.message);
          return;
        }
      } else {
        nextSub = appliedBaths.sub;
      }
      setSub(nextSub);
    }
    if (stepIndex === 1) {
      setSub((s) => ({
        ...s,
        rooms: s.rooms.map((room, i) => ({
          ...room,
          name: room.name.trim() || `Room ${i + 1}`,
        })),
      }));
    }
    if (stepIndex === 2) {
      setSub((s) => ({
        ...s,
        bathrooms: s.bathrooms.map((bath, i) => ({
          ...bath,
          name: bath.name.trim() || emptyBathroom(i).name,
        })),
      }));
    }
    if (stepIndex === 3) {
      setSub((s) => ({
        ...s,
        sharedSpaces: s.sharedSpaces.filter((space) => space.name.trim()),
      }));
    }
    const pos = wizardSteps.indexOf(stepIndex);
    if (pos < 0 || pos >= wizardSteps.length - 1) return;
    const nextIdx = wizardSteps[pos + 1]!;
    setStepIndex(nextIdx);
    setMaxStepReached((m) => Math.max(m, nextIdx));
  };

  const goNext = () => {
    const errs = validateListingStep(stepIndex);
    if (Object.keys(errs).length > 0) {
      setStepFieldErrors(errs);
      showToast("Please fix the highlighted fields before continuing.");
      queueMicrotask(() =>
        scrollToFirstWizardFieldError(buildListingStepFieldOrder(stepIndex, sub), errs, scrollRef.current),
      );
      return;
    }
    setStepFieldErrors({});
    if (isEditMode) {
      const current = ensureSubmissionListingFees({ ...sub, serviceRequestOptions: serviceOffers });
      if (!listingWizardHasUnsavedInput(current, baselineFingerprintRef.current ?? "")) {
        advanceFromCurrentStep();
        return;
      }
      void persistEditListingRef.current({ advanceOnSuccess: true });
      return;
    }
    if (!isPreviewWizard) {
      void persistDraftRef.current({ silent: true }).then((ok) => {
        if (ok) advanceFromCurrentStep();
      });
      return;
    }
    advanceFromCurrentStep();
  };

  const goPrev = () => {
    setStepFieldErrors({});
    const pos = wizardSteps.indexOf(stepIndex);
    if (pos > 0) setStepIndex(wizardSteps[pos - 1]!);
  };

  const setRoom = (i: number, patch: Partial<ManagerRoomSubmission>) => {
    setSub((s) => {
      const rooms = [...s.rooms];
      rooms[i] = { ...rooms[i]!, ...patch };
      return { ...s, rooms };
    });
  };

  const setBath = (i: number, patch: Partial<ManagerBathroomSubmission>) => {
    setSub((s) => {
      const bathrooms = [...s.bathrooms];
      bathrooms[i] = { ...bathrooms[i]!, ...patch };
      return { ...s, bathrooms };
    });
  };

  const setSharedSpace = (i: number, patch: Partial<ManagerSharedSpaceSubmission>) => {
    setSub((s) => {
      const sharedSpaces = [...s.sharedSpaces];
      sharedSpaces[i] = { ...sharedSpaces[i]!, ...patch };
      return { ...s, sharedSpaces };
    });
  };

  const addRoom = () => {
    if (sub.rooms.length >= 20) return;
    const next = emptyRoom(sub.rooms.length);
    expandListingItem(listingItemKey("room", next.id));
    setSub((s) => ({ ...s, rooms: [...s.rooms, next] }));
  };

  const removeRoom = (i: number) => {
    if (sub.rooms.length <= 1) return;
    const removedId = sub.rooms[i]!.id;
    setSub((s) => ({
      ...s,
      rooms: s.rooms.filter((_, j) => j !== i),
      bathrooms: s.bathrooms.map((b) => {
        const assignedRoomIds = (b.assignedRoomIds ?? []).filter((id) => id !== removedId);
        let accessKindByRoomId = b.accessKindByRoomId;
        if (accessKindByRoomId?.[removedId]) {
          accessKindByRoomId = { ...accessKindByRoomId };
          delete accessKindByRoomId[removedId];
          if (Object.keys(accessKindByRoomId).length === 0) accessKindByRoomId = undefined;
        }
        return { ...b, assignedRoomIds, accessKindByRoomId };
      }),
      sharedSpaces: s.sharedSpaces.map((ss) => ({
        ...ss,
        roomAccessIds: (ss.roomAccessIds ?? []).filter((id) => id !== removedId),
      })),
      bundles: (s.bundles ?? []).map((bundle) => {
        const nextRooms = s.rooms.filter((_, j) => j !== i);
        const includedRoomIds = (bundle.includedRoomIds ?? []).filter((id) => id !== removedId);
        return {
          ...bundle,
          includedRoomIds,
          roomsLine: bundle.roomsLine.trim() ? bundle.roomsLine : bundleRoomsLine(includedRoomIds, nextRooms),
        };
      }),
    }));
  };

  const toggleBathroomRoom = (bathIndex: number, roomId: string, on: boolean) => {
    setSub((s) => {
      if (s.bathrooms[bathIndex]?.allResidents) return s;
      const nextBathrooms = s.bathrooms.map((b, bi) => {
        if (bi === bathIndex) {
          const set = new Set(b.assignedRoomIds ?? []);
          if (on) set.add(roomId);
          else set.delete(roomId);
          const nextIds = s.rooms.map((r) => r.id).filter((id) => set.has(id));
          let access = b.accessKindByRoomId;
          if (!on && access?.[roomId]) {
            access = { ...access };
            delete access[roomId];
            if (Object.keys(access).length === 0) access = undefined;
          }
          return { ...b, assignedRoomIds: nextIds, accessKindByRoomId: access };
        }
        if (on && !b.allResidents) {
          return { ...b, assignedRoomIds: (b.assignedRoomIds ?? []).filter((id) => id !== roomId) };
        }
        return b;
      });
      return { ...s, bathrooms: nextBathrooms };
    });
  };

  const setBathRoomAccessKind = (bathIndex: number, roomId: string, value: "" | ManagerBathroomRoomAccessKind) => {
    setSub((s) => {
      const bathrooms = [...s.bathrooms];
      const b = bathrooms[bathIndex];
      if (!b || b.allResidents) return s;
      if (!(b.assignedRoomIds ?? []).includes(roomId)) return s;
      const nextAccess: Partial<Record<string, ManagerBathroomRoomAccessKind>> = { ...(b.accessKindByRoomId ?? {}) };
      if (!value) delete nextAccess[roomId];
      else nextAccess[roomId] = value;
      bathrooms[bathIndex] = {
        ...b,
        accessKindByRoomId: Object.keys(nextAccess).length ? nextAccess : undefined,
      };
      return { ...s, bathrooms };
    });
  };

  const duplicateRoom = (i: number) => {
    if (sub.rooms.length >= 20) {
      showToast("Maximum 20 rooms.");
      return;
    }
    const copy = duplicateRoomEntry(sub.rooms[i]!);
    expandListingItem(listingItemKey("room", copy.id));
    setSub((s) => ({
      ...s,
      rooms: [...s.rooms.slice(0, i + 1), copy, ...s.rooms.slice(i + 1)],
    }));
    showToast("Room duplicated — edit the copy below.");
  };

  const addBathroom = () => {
    setSub((s) => {
      if (s.bathrooms.length >= 12) return s;
      const next = emptyBathroom(s.bathrooms.length);
      expandListingItem(listingItemKey("bathroom", next.id));
      return { ...s, bathrooms: [...s.bathrooms, next] };
    });
  };

  /**
   * The three answers a bathroom has 95% of the time (PRP-138).
   *
   * Fixtures were four loose checkboxes, so every bathroom had to be assembled
   * from parts. These preset them and name the row; anything unusual is still
   * one chip away inside the row, so nothing is taken off the table.
   */
  const addBathroomOfType = (type: "full" | "half" | "ensuite") => {
    setSub((s) => {
      if (s.bathrooms.length >= 12) return s;
      const next = buildBathroomPreset(s.bathrooms.length, type);
      expandListingItem(listingItemKey("bathroom", next.id));
      return { ...s, bathrooms: [...s.bathrooms, next] };
    });
  };

  const removeBathroom = (i: number) => {
    const bathId = sub.bathrooms[i]?.id;
    if (bathId) clearVideoPreview(`bath-${bathId}`);
    setSub((s) => ({ ...s, bathrooms: s.bathrooms.filter((_, j) => j !== i) }));
  };

  const addSharedSpace = () => {
    setSub((s) => {
      if (s.sharedSpaces.length >= 24) return s;
      const next = emptySharedSpace(s.sharedSpaces.length);
      expandListingItem(listingItemKey("shared", next.id));
      return { ...s, sharedSpaces: [...s.sharedSpaces, next] };
    });
  };

  const addSharedSpaceFromTemplate = (template: (typeof SHARED_SPACE_TEMPLATES)[number]) => {
    setSub((s) => {
      if (s.sharedSpaces.length >= 24) return s;
      const row = {
        ...emptySharedSpace(s.sharedSpaces.length),
        name: template.label,
        spaceKind: template.kind,
        detail: template.detail,
        amenitiesText: template.amenities.join("\n"),
        roomAccessIds: s.rooms.map((room) => room.id),
      };
      expandListingItem(listingItemKey("shared", row.id));
      return { ...s, sharedSpaces: [...s.sharedSpaces, row] };
    });
  };

  const removeSharedSpace = (i: number) => {
    const spaceId = sub.sharedSpaces[i]?.id;
    if (spaceId) clearVideoPreview(`space-${spaceId}`);
    setSub((s) => ({ ...s, sharedSpaces: s.sharedSpaces.filter((_, j) => j !== i) }));
  };

  const setSharedSpaceRoomAccess = (spaceIndex: number, mode: "all" | "none") => {
    setSub((s) => {
      const sharedSpaces = s.sharedSpaces.map((ss, si) =>
        si === spaceIndex ? { ...ss, roomAccessIds: mode === "all" ? s.rooms.map((room) => room.id) : [] } : ss,
      );
      return { ...s, sharedSpaces };
    });
  };

  const toggleSharedSpaceRoom = (spaceIndex: number, roomId: string, on: boolean) => {
    setSub((s) => {
      const sharedSpaces = s.sharedSpaces.map((ss, si) => {
        if (si !== spaceIndex) return ss;
        const set = new Set(ss.roomAccessIds ?? []);
        if (on) set.add(roomId);
        else set.delete(roomId);
        return { ...ss, roomAccessIds: s.rooms.map((r) => r.id).filter((id) => set.has(id)) };
      });
      return { ...s, sharedSpaces };
    });
  };

  const toggleBundleRoom = (bundleIndex: number, roomId: string, on: boolean) => {
    setSub((s) => {
      const bundles = [...(s.bundles ?? [])];
      const cur = bundles[bundleIndex];
      if (!cur) return s;
      const nextSet = new Set(cur.includedRoomIds ?? []);
      if (on) nextSet.add(roomId);
      else nextSet.delete(roomId);
      const includedRoomIds = s.rooms.map((r) => r.id).filter((id) => nextSet.has(id));
      bundles[bundleIndex] = {
        ...cur,
        includedRoomIds,
        roomsLine: cur.roomsLine.trim() ? cur.roomsLine : bundleRoomsLine(includedRoomIds, s.rooms),
        price: cur.price.trim() ? cur.price : bundleRentLabel(includedRoomIds, s.rooms, entireHomeMonthlyRentAmount(s)),
      };
      return { ...s, bundles };
    });
  };

  const setBundle = (i: number, patch: Partial<ManagerBundleRow>) => {
    setSub((s) => {
      const bundles = [...(s.bundles ?? [])];
      bundles[i] = { ...bundles[i]!, ...patch };
      return { ...s, bundles };
    });
  };

  const addBundle = () => {
    // A custom bundle is a group offering — seed it with the group_bundle defaults
    // (utilities model + estimate; deposit fills once a rent is entered).
    const next = applyListingFeeContextDefaults(emptyBundleRow(), "group_bundle", 0);
    expandListingItem(listingItemKey("bundle", next.id));
    setSub((s) => ({ ...s, bundles: [...(s.bundles ?? []), next] }));
  };

  const removeBundle = (i: number) => {
    setSub((s) => {
      const bundles = (s.bundles ?? []).filter((_, j) => j !== i);
      return { ...s, bundles };
    });
  };

  const applyBundleRoomScope = (bundleIndex: number, mode: "all_named" | "none") => {
    setSub((s) => {
      const bundles = [...(s.bundles ?? [])];
      const cur = bundles[bundleIndex];
      if (!cur) return s;
      const includedRoomIds = mode === "all_named" ? s.rooms.map((r) => r.id) : [];
      bundles[bundleIndex] = {
        ...cur,
        includedRoomIds,
        roomsLine: bundleRoomsLine(includedRoomIds, s.rooms),
        price: bundleRentLabel(includedRoomIds, s.rooms, entireHomeMonthlyRentAmount(s)),
      };
      return { ...s, bundles };
    });
  };

  const setQuickFact = (i: number, patch: Partial<ManagerQuickFactRow>) => {
    setSub((s) => {
      const quickFacts = [...(s.quickFacts ?? [])];
      quickFacts[i] = { ...quickFacts[i]!, ...patch };
      return { ...s, quickFacts };
    });
  };

  const addQuickFact = () => {
    const next = emptyQuickFactRow();
    expandListingItem(listingItemKey("quickfact", next.id));
    setSub((s) => ({ ...s, quickFacts: [...(s.quickFacts ?? []), next] }));
  };

  const removeQuickFact = (i: number) => {
    setSub((s) => ({
      ...s,
      quickFacts: (s.quickFacts ?? []).filter((_, j) => j !== i),
    }));
  };

  const setCustomFee = (i: number, patch: Partial<ManagerCustomFeeRow>) => {
    setSub((s) => {
      const customFees = [...(s.customFees ?? [])];
      customFees[i] = { ...customFees[i]!, ...patch };
      return { ...s, customFees };
    });
  };

  const addCustomFee = () => {
    const next = emptyCustomFeeRow();
    expandListingItem(listingItemKey("fee", next.id));
    setSub((s) => ({ ...s, customFees: [...(s.customFees ?? []), next] }));
  };

  const removeCustomFee = (i: number) => {
    setSub((s) => ({
      ...s,
      customFees: (s.customFees ?? []).filter((_, j) => j !== i),
    }));
  };

  const onPickRoomPhotos = async (roomIndex: number, files: FileList | null) => {
    if (!files?.length) return;
    const fileArray = Array.from(files);
    try {
    const next: string[] = [];
    for (let i = 0; i < Math.min(fileArray.length, 6); i++) {
      await yieldToMain();
      const f = fileArray[i]!;
      if (!f.type.startsWith("image/")) {
        showToast("Images only for room photos.");
        return;
      }
      const url = await fileToDataUrl(f, MAX_IMG_BYTES);
      if (!url) {
        showToast(`Image too large (max ${Math.round(MAX_IMG_BYTES / 1024 / 1024)} MB): ${f.name}`);
        return;
      }
      next.push(url);
    }
    startTransition(() => {
    setSub((s) => {
      const rooms = [...s.rooms];
      const cur = rooms[roomIndex]!;
      rooms[roomIndex] = { ...cur, photoDataUrls: [...cur.photoDataUrls, ...next].slice(0, 8) };
      return { ...s, rooms };
    });
    });
    } catch { showToast("Could not process image. Please try a different file."); }
  };

  const onPickRoomVideo = async (roomIndex: number, file: File | null) => {
    if (!file) return;
    if (!isVideoUploadFile(file)) { showToast("Please choose a video file."); return; }
    const roomId = sub.rooms[roomIndex]?.id;
    if (!roomId) return;
    const key = `room-${roomId}`;
    setVideoPreview(key, file);
    setVideoUploadingKeys((s) => new Set([...s, key]));
    try {
      const url = await uploadVideoFile(file);
      setRoom(roomIndex, { videoDataUrl: url });
    } catch {
      showToast("Could not upload video. Check your connection and try again.");
      clearVideoPreview(key);
    } finally {
      setVideoUploadingKeys((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  };

  const removeRoomPhoto = (roomIndex: number, photoIndex: number) => {
    setSub((s) => {
      const rooms = [...s.rooms];
      const cur = rooms[roomIndex]!;
      rooms[roomIndex] = {
        ...cur,
        photoDataUrls: cur.photoDataUrls.filter((_, j) => j !== photoIndex),
      };
      return { ...s, rooms };
    });
  };

  const onPickBathroomPhotos = async (bathId: string, files: FileList | null) => {
    if (!files?.length) return;
    const fileArray = Array.from(files);
    try {
    const next: string[] = [];
    for (let i = 0; i < Math.min(fileArray.length, 6); i++) {
      await yieldToMain();
      const f = fileArray[i]!;
      if (!isImageUploadFile(f)) {
        showToast("Images only for bathroom photos.");
        return;
      }
      const url = await fileToDataUrl(f, MAX_IMG_BYTES);
      if (!url) {
        showToast(`Image too large (max ${Math.round(MAX_IMG_BYTES / 1024 / 1024)} MB): ${f.name}`);
        return;
      }
      next.push(url);
    }
    startTransition(() => {
    setSub((s) => {
      const bathIndex = s.bathrooms.findIndex((b) => b.id === bathId);
      if (bathIndex < 0) return s;
      const bathrooms = [...s.bathrooms];
      const cur = bathrooms[bathIndex];
      if (!cur) return s;
      bathrooms[bathIndex] = { ...cur, photoDataUrls: [...(cur.photoDataUrls ?? []), ...next].slice(0, 8) };
      return { ...s, bathrooms };
    });
    });
    } catch { showToast("Could not process image. Please try a different file."); }
  };

  const onPickBathroomVideo = async (bathId: string, file: File | null) => {
    if (!file) return;
    if (!isVideoUploadFile(file)) { showToast("Please choose a video file."); return; }
    const key = `bath-${bathId}`;
    setVideoPreview(key, file);
    setVideoUploadingKeys((s) => new Set([...s, key]));
    try {
      const url = await uploadVideoFile(file);
      setSub((s) => {
        const bathIndex = s.bathrooms.findIndex((b) => b.id === bathId);
        if (bathIndex < 0) return s;
        const bathrooms = [...s.bathrooms];
        bathrooms[bathIndex] = { ...bathrooms[bathIndex]!, videoDataUrl: url };
        return { ...s, bathrooms };
      });
    } catch {
      showToast("Could not upload video. Check your connection and try again.");
      clearVideoPreview(key);
    } finally {
      setVideoUploadingKeys((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  };

  const removeBathroomPhoto = (bathId: string, photoIndex: number) => {
    setSub((s) => {
      const bathIndex = s.bathrooms.findIndex((b) => b.id === bathId);
      if (bathIndex < 0) return s;
      const bathrooms = [...s.bathrooms];
      const cur = bathrooms[bathIndex];
      if (!cur) return s;
      bathrooms[bathIndex] = {
        ...cur,
        photoDataUrls: (cur.photoDataUrls ?? []).filter((_, j) => j !== photoIndex),
      };
      return { ...s, bathrooms };
    });
  };

  const clearBathroomVideo = (bathId: string) => {
    clearVideoPreview(`bath-${bathId}`);
    setSub((s) => {
      const bathIndex = s.bathrooms.findIndex((b) => b.id === bathId);
      if (bathIndex < 0) return s;
      const bathrooms = [...s.bathrooms];
      bathrooms[bathIndex] = { ...bathrooms[bathIndex]!, videoDataUrl: null };
      return { ...s, bathrooms };
    });
  };

  const onPickSharedSpacePhotos = async (spaceId: string, files: FileList | null) => {
    if (!files?.length) return;
    const fileArray = Array.from(files);
    try {
    const next: string[] = [];
    for (let i = 0; i < Math.min(fileArray.length, 6); i++) {
      await yieldToMain();
      const f = fileArray[i]!;
      if (!isImageUploadFile(f)) {
        showToast("Images only for shared-space photos.");
        return;
      }
      const url = await fileToDataUrl(f, MAX_IMG_BYTES);
      if (!url) {
        showToast(`Image too large (max ${Math.round(MAX_IMG_BYTES / 1024 / 1024)} MB): ${f.name}`);
        return;
      }
      next.push(url);
    }
    startTransition(() => {
    setSub((s) => {
      const spaceIndex = s.sharedSpaces.findIndex((ss) => ss.id === spaceId);
      if (spaceIndex < 0) return s;
      const sharedSpaces = [...s.sharedSpaces];
      const cur = sharedSpaces[spaceIndex];
      if (!cur) return s;
      sharedSpaces[spaceIndex] = { ...cur, photoDataUrls: [...(cur.photoDataUrls ?? []), ...next].slice(0, 8) };
      return { ...s, sharedSpaces };
    });
    });
    } catch { showToast("Could not process image. Please try a different file."); }
  };

  const onPickSharedSpaceVideo = async (spaceId: string, file: File | null) => {
    if (!file) return;
    if (!isVideoUploadFile(file)) { showToast("Please choose a video file."); return; }
    const key = `space-${spaceId}`;
    setVideoPreview(key, file);
    setVideoUploadingKeys((s) => new Set([...s, key]));
    try {
      const url = await uploadVideoFile(file);
      setSub((s) => {
        const spaceIndex = s.sharedSpaces.findIndex((ss) => ss.id === spaceId);
        if (spaceIndex < 0) return s;
        const sharedSpaces = [...s.sharedSpaces];
        sharedSpaces[spaceIndex] = { ...sharedSpaces[spaceIndex]!, videoDataUrl: url };
        return { ...s, sharedSpaces };
      });
    } catch {
      showToast("Could not upload video. Check your connection and try again.");
      clearVideoPreview(key);
    } finally {
      setVideoUploadingKeys((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  };

  const removeSharedSpacePhoto = (spaceId: string, photoIndex: number) => {
    setSub((s) => {
      const spaceIndex = s.sharedSpaces.findIndex((ss) => ss.id === spaceId);
      if (spaceIndex < 0) return s;
      const sharedSpaces = [...s.sharedSpaces];
      const cur = sharedSpaces[spaceIndex];
      if (!cur) return s;
      sharedSpaces[spaceIndex] = {
        ...cur,
        photoDataUrls: (cur.photoDataUrls ?? []).filter((_, j) => j !== photoIndex),
      };
      return { ...s, sharedSpaces };
    });
  };

  const clearSharedSpaceVideo = (spaceId: string) => {
    clearVideoPreview(`space-${spaceId}`);
    setSub((s) => {
      const spaceIndex = s.sharedSpaces.findIndex((ss) => ss.id === spaceId);
      if (spaceIndex < 0) return s;
      const sharedSpaces = [...s.sharedSpaces];
      sharedSpaces[spaceIndex] = { ...sharedSpaces[spaceIndex]!, videoDataUrl: null };
      return { ...s, sharedSpaces };
    });
  };

  const onPickHousePhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const fileArray = Array.from(files);
    try {
    const cur = sub.housePhotoDataUrls ?? [];
    const remaining = MAX_HOUSE_PHOTOS - cur.length;
    if (remaining <= 0) {
      showToast(`You can add up to ${MAX_HOUSE_PHOTOS} house photos.`);
      return;
    }
    const next: string[] = [...cur];
    for (let i = 0; i < Math.min(fileArray.length, remaining); i++) {
      await yieldToMain();
      const f = fileArray[i]!;
      if (!f.type.startsWith("image/")) {
        showToast("Images only for house photos.");
        return;
      }
      const url = await fileToDataUrl(f, MAX_IMG_BYTES);
      if (!url) {
        showToast(`Image too large (max ${Math.round(MAX_IMG_BYTES / 1024 / 1024)} MB): ${f.name}`);
        return;
      }
      next.push(url);
    }
    startTransition(() => {
      setSub((s) => ({ ...s, housePhotoDataUrls: next }));
    });
    } catch { showToast("Could not process image. Please try a different file."); }
  };

  const removeHousePhoto = (photoIndex: number) => {
    setSub((s) => ({
      ...s,
      housePhotoDataUrls: (s.housePhotoDataUrls ?? []).filter((_, j) => j !== photoIndex),
    }));
  };

  // Floor-plan upload handlers removed with the Floor plans section (data intentionally
  // kept on the submission: propertyFloorPlanDataUrl + floorPlanByLabel).

  const clearRoomVideo = (roomIndex: number) => {
    const roomId = sub.rooms[roomIndex]?.id;
    if (roomId) clearVideoPreview(`room-${roomId}`);
    setRoom(roomIndex, { videoDataUrl: null });
  };

  const onPickHouseVideo = async (file: File | null) => {
    if (!file) return;
    if (!isVideoUploadFile(file)) { showToast("Please choose a video file."); return; }
    setVideoPreview("house", file);
    setVideoUploadingKeys((s) => new Set([...s, "house"]));
    try {
      const url = await uploadVideoFile(file);
      setSub((s) => ({ ...s, houseVideoDataUrl: url }));
    } catch {
      showToast("Could not upload video. Check your connection and try again.");
      clearVideoPreview("house");
    } finally {
      setVideoUploadingKeys((s) => { const n = new Set(s); n.delete("house"); return n; });
    }
  };

  const clearHouseVideo = () => {
    clearVideoPreview("house");
    setSub((s) => ({ ...s, houseVideoDataUrl: null }));
  };

  const onDropHouseVideo = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone("house-video");
    void onPickHouseVideo(firstVideoFileFromDataTransfer(event.dataTransfer));
  };

  const activateDropZone = (zoneId: string) => {
    setActiveDropZone(zoneId);
  };

  const deactivateDropZone = (zoneId?: string) => {
    setActiveDropZone((current) => (zoneId && current !== zoneId ? current : null));
  };

  const handleDragOver = (event: DragEvent<HTMLElement>, zoneId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) {
      event.dataTransfer.dropEffect = "copy";
    }
    activateDropZone(zoneId);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>, zoneId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    deactivateDropZone(zoneId);
  };

  const onDropHousePhotos = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone("house-photos");
    void onPickHousePhotos(fileListFromFiles(imageFilesFromDataTransfer(event.dataTransfer)));
  };

  const onDropRoomPhotos = (roomIndex: number, roomId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone(`room-photos-${roomId}`);
    void onPickRoomPhotos(roomIndex, fileListFromFiles(imageFilesFromDataTransfer(event.dataTransfer)));
  };

  const onDropRoomVideo = (roomIndex: number, roomId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone(`room-video-${roomId}`);
    void onPickRoomVideo(roomIndex, firstVideoFileFromDataTransfer(event.dataTransfer));
  };

  const onDropBathroomPhotos = (bathId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone(`bath-photos-${bathId}`);
    void onPickBathroomPhotos(bathId, fileListFromFiles(imageFilesFromDataTransfer(event.dataTransfer)));
  };

  const onDropBathroomVideo = (bathId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone(`bath-video-${bathId}`);
    void onPickBathroomVideo(bathId, firstVideoFileFromDataTransfer(event.dataTransfer));
  };

  const onDropSharedSpacePhotos = (spaceId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone(`shared-photos-${spaceId}`);
    void onPickSharedSpacePhotos(spaceId, fileListFromFiles(imageFilesFromDataTransfer(event.dataTransfer)));
  };

  const onDropSharedSpaceVideo = (spaceId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deactivateDropZone(`shared-video-${spaceId}`);
    void onPickSharedSpaceVideo(spaceId, firstVideoFileFromDataTransfer(event.dataTransfer));
  };

  /** Assign stable answer keys and drop blank drafts before persisting. */
  const finalizeCustomApplicationFields = (
    fields: ManagerCustomApplicationField[] | undefined,
  ): ManagerCustomApplicationField[] => {
    const out: ManagerCustomApplicationField[] = [];
    const usedKeys = new Set<string>();
    for (const field of fields ?? []) {
      const label = field.label.trim();
      if (!label) continue;
      if (field.type === "select" && field.options.length === 0) continue;
      const key = field.key.trim() || customApplicationFieldKeyFromLabel(label, usedKeys);
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      out.push({ ...field, key, label });
    }
    return out;
  };

  /**
   * A draft only makes sense for a listing that does not exist yet. Every edit
   * mode (pending row, live listing, request-change row, preview scope) is
   * changing a record that is already persisted somewhere else — saving one of
   * those as a draft would fork it into a second record.
   */
  const draftAutoSaveEligible = !isEditMode && !isPreviewWizard;
  const editAutoSaveEligible = isEditMode && !isPreviewWizard;

  const buildSubmissionPayload = useCallback((): ManagerListingSubmissionV1 => {
    const submission = ensureSubmissionListingFees({
      ...sub,
      serviceRequestOptions: serviceOffers,
      customApplicationFields: finalizeCustomApplicationFields(sub.customApplicationFields),
      disabledStandardApplicationKeys: sub.disabledStandardApplicationKeys ?? [],
      applicationConfigMode:
        (sub.disabledStandardApplicationKeys?.length ?? 0) > 0 ||
        (sub.customApplicationFields?.length ?? 0) > 0
          ? "custom"
          : "standard",
      rooms: sub.rooms.map((room) => ({
        ...room,
        roomAmenitiesText: sanitizeRoomAmenityText(room.roomAmenitiesText),
      })),
    });
    submission.sharedSpaces = submission.sharedSpaces.filter((space) => space.name.trim());
    submission.rooms = submission.rooms.map((room, i) => ({
      ...room,
      name: room.name.trim() || `Room ${i + 1}`,
    }));
    submission.bathrooms = submission.bathrooms.map((bath, i) => ({
      ...bath,
      name: bath.name.trim() || emptyBathroom(i).name,
    }));
    return normalizeManagerListingSubmissionV1(submission);
  }, [sub, serviceOffers]);

  const persistEditListing = useCallback(
    async (opts?: { advanceOnSuccess?: boolean; closeAfter?: boolean; silent?: boolean }): Promise<boolean> => {
      if (!isEditMode || closingDraft) return false;
      if (busy) {
        if (!opts?.silent) showToast("Still saving your changes…");
        return false;
      }
      if (!authReady || !userId) {
        const msg = "Sign in to save changes.";
        setDraftSaveError(msg);
        if (!opts?.silent) showToast(msg);
        return false;
      }

      const current = ensureSubmissionListingFees({ ...sub, serviceRequestOptions: serviceOffers });
      const hasChanges = listingWizardHasUnsavedInput(current, baselineFingerprintRef.current ?? "");
      if (!hasChanges) {
        setDraftSaveError(null);
        if (opts?.advanceOnSuccess) advanceFromCurrentStep();
        if (opts?.closeAfter) onClose();
        return true;
      }

      const stepPos = wizardSteps.indexOf(stepIndex);
      const advancingToReview = stepPos >= 0 && stepPos === wizardSteps.length - 2;
      const shouldToast = !opts?.silent && (advancingToReview || opts?.closeAfter);
      const backgroundSave = Boolean(opts?.silent && !opts?.closeAfter && !opts?.advanceOnSuccess);

      if (backgroundSave) {
        setAutosaveStatus("saving");
      } else {
        setBusy(true);
      }

      try {
        droppedAttachmentsRef.current = false;
        let uploadedSubmission = buildSubmissionPayload();
        try {
          const uploaded = await uploadSubmissionMedia(uploadedSubmission);
          uploadedSubmission = uploaded.submission;
          if (uploaded.failedCount > 0) {
            droppedAttachmentsRef.current = true;
          } else {
            setSub(uploadedSubmission);
          }
        } catch (err) {
          console.error("manager-add-listing-form: edit media upload failed", err);
          uploadedSubmission = stripSubmissionDataUrls(buildSubmissionPayload());
          droppedAttachmentsRef.current = true;
        }

        let ok = false;
        if (editPendingId) {
          ok = await updatePendingManagerPropertyOnServer(editPendingId, uploadedSubmission, userId);
        } else if (editRequestChangeId) {
          ok = updateRequestChangeProperty(editRequestChangeId, userId, uploadedSubmission);
        } else if (editListingId) {
          const saveUserId = editListingOwnerUserId?.trim() || userId;
          ok = await updateExtraListingFromSubmissionOnServer(editListingId, saveUserId, uploadedSubmission);
        }
        if (!ok) {
          const msg = "Could not save changes. Check your connection and try again.";
          setDraftSaveError(msg);
          if (backgroundSave) setAutosaveStatus("error");
          if (!opts?.silent) showToast(msg);
          return false;
        }

        const fingerprint = listingSubmissionFingerprint({
          ...uploadedSubmission,
          serviceRequestOptions: serviceOffers,
        });
        baselineFingerprintRef.current = fingerprint;
        lastPersistedFingerprintRef.current = fingerprint;
        setDraftSaveError(null);

        const droppedAttachments = droppedAttachmentsRef.current;
        droppedAttachmentsRef.current = false;

        if (shouldToast) {
          showToast(
            droppedAttachments
              ? "Changes saved. Some photos couldn't be uploaded — they're still in the form."
              : "Changes saved.",
          );
        } else if (droppedAttachments && !opts?.silent) {
          showToast("Saved, but some photos couldn't be uploaded — they are still in the form, try again.");
        } else if (backgroundSave) {
          setAutosaveStatus(droppedAttachments ? "saved-without-photos" : "saved");
          if (droppedAttachments) {
            showToast("Saved, but some photos couldn't be uploaded — they are still in the form, try again.");
          }
        }

        if (opts?.advanceOnSuccess) advanceFromCurrentStep();
        if (opts?.closeAfter) {
          if (droppedAttachments) {
            showToast(
              "Changes saved. Some attachments couldn't be uploaded — they're still in the form for next time.",
            );
          }
          onClose();
        }
        return true;
      } catch (err) {
        console.error("manager-add-listing-form: persistEditListing failed", err);
        const msg = "Could not save changes. Check your connection and try again.";
        setDraftSaveError(msg);
        if (backgroundSave) setAutosaveStatus("error");
        if (!opts?.silent) showToast(msg);
        return false;
      } finally {
        if (!backgroundSave) {
          setBusy(false);
        }
      }
    },
    [
      advanceFromCurrentStep,
      authReady,
      buildSubmissionPayload,
      busy,
      closingDraft,
      editListingId,
      editListingOwnerUserId,
      editPendingId,
      editRequestChangeId,
      isEditMode,
      onClose,
      serviceOffers,
      showToast,
      stepIndex,
      userId,
      wizardSteps,
    ],
  );

  useEffect(() => {
    persistEditListingRef.current = persistEditListing;
  }, [persistEditListing]);

  /**
   * Closing also saves: persist whatever the manager has entered as a draft,
   * then close. Background autosave runs while the wizard stays open; close
   * flushes any edits not yet persisted.
   */
  const closeWizard = () => {
    if (!draftAutoSaveEligible) {
      const current = ensureSubmissionListingFees({ ...sub, serviceRequestOptions: serviceOffers });
      if (
        isEditMode &&
        listingWizardHasUnsavedInput(current, baselineFingerprintRef.current ?? "")
      ) {
        void persistEditListingRef.current({ closeAfter: true });
        return;
      }
      onClose();
      return;
    }
    void persistDraftRef.current({ closeAfter: true });
  };

  const persistListingDraft = useCallback(
    async (opts?: { silent?: boolean; closeAfter?: boolean }): Promise<boolean> => {
      if (!draftAutoSaveEligible || busy || closingDraft) return false;

      const current: ManagerListingSubmissionV1 = ensureSubmissionListingFees({
        ...sub,
        serviceRequestOptions: serviceOffers,
      });
      const fingerprint = listingSubmissionFingerprint(current);
      const contentChangedSinceOpen = listingWizardHasUnsavedInput(
        current,
        baselineFingerprintRef.current ?? "",
      );
      const contentChangedSincePersist =
        fingerprint !== (lastPersistedFingerprintRef.current ?? baselineFingerprintRef.current ?? "");
      const positionChanged =
        stepIndex !== lastPersistedStepRef.current.stepIndex ||
        maxStepReached !== lastPersistedStepRef.current.maxStepReached;

      if (!contentChangedSinceOpen && !positionChanged) {
        setDraftSaveError(null);
        if (opts?.closeAfter) onClose();
        return true;
      }
      if (!contentChangedSincePersist && !positionChanged) {
        setDraftSaveError(null);
        if (opts?.closeAfter) onClose();
        return true;
      }
      if (!authReady || !userId) {
        const msg =
          "Could not save your progress — sign in again, then close. Your work is still here.";
        setDraftSaveError(msg);
        setAutosaveStatus("error");
        if (!opts?.silent) showToast(msg);
        return false;
      }

      if (opts?.closeAfter) {
        setClosingDraft(true);
      } else {
        setAutosaveStatus("saving");
      }

      try {
        let submission = current;
        // Per ATTEMPT, not per session. A failed attachment now stays in the
        // form, so a retry that uploads it really does save it — carrying the
        // previous attempt's warning forward would tell the manager to "add
        // them again next time" about photos that are now stored.
        droppedAttachmentsRef.current = false;
        try {
          const uploaded = await uploadSubmissionMedia(current);
          submission = uploaded.submission;
          if (uploaded.failedCount > 0) {
            // `uploadSubmissionMedia` DROPS whatever failed to upload, so
            // writing its result back into live state deletes the manager's
            // photos out of the form they are looking at — during a background
            // autosave they did not ask for. Persist the reduced copy so the
            // draft is still saved, but leave the form alone: the data URLs are
            // still there and the next save retries them.
            droppedAttachmentsRef.current = true;
          } else {
            setSub(submission);
          }
        } catch (err) {
          console.error("manager-add-listing-form: draft media upload failed", err);
          submission = stripSubmissionDataUrls(current);
          droppedAttachmentsRef.current = true;
        }

        const savedId = await saveManagerPropertyDraftToServer(submission, userId, {
          existingDraftId: draftIdRef.current,
          stepIndex,
          maxStepReached,
          allowIdUpgrade: draftIdMintedHereRef.current,
        });
        if (!savedId) {
          const msg = droppedAttachmentsRef.current
            ? "Could not save your progress. Your listing is still here, but some attachments couldn't be saved — check your connection and close again."
            : "Could not save your progress. It is still here — check your connection and close again.";
          setDraftSaveError(msg);
          setAutosaveStatus("error");
          if (!opts?.silent) showToast(msg);
          return false;
        }

        setDraftSaveError(null);
        draftIdRef.current = savedId;
        setSavedListingId(savedId);
        lastPersistedFingerprintRef.current = listingSubmissionFingerprint(submission);
        lastPersistedStepRef.current = { stepIndex, maxStepReached };
        onSaved?.();

        const droppedAttachments = droppedAttachmentsRef.current;
        droppedAttachmentsRef.current = false;

        if (opts?.closeAfter) {
          showToast(
            droppedAttachments
              ? "Progress saved to Drafts. Some attachments couldn't be saved — add them again next time."
              : "Progress saved to Drafts.",
          );
          onClose();
        } else {
          setAutosaveStatus(droppedAttachments ? "saved-without-photos" : "saved");
          // The silent autosave is the path that runs most often, and it was
          // the one path that swallowed this warning entirely.
          if (droppedAttachments) {
            showToast("Saved, but some photos couldn't be uploaded — they are still in the form, try again.");
          }
        }
        return true;
      } finally {
        if (opts?.closeAfter) {
          setClosingDraft(false);
        }
      }
    },
    [
      authReady,
      busy,
      closingDraft,
      draftAutoSaveEligible,
      maxStepReached,
      onClose,
      onSaved,
      serviceOffers,
      showToast,
      stepIndex,
      sub,
      userId,
    ],
  );

  // Assigned in an effect, not during render: a render-phase ref write is unsafe under
  // concurrent rendering. The ref exists only to let closeWizard, declared above,
  // reach persistListingDraft, declared below, and it is read from that click handler
  // alone, so an effect always lands before it can be called. Its initializer is a
  // no-op resolving false, so an early call cannot throw.
  useEffect(() => {
    persistDraftRef.current = persistListingDraft;
  }, [persistListingDraft]);

  useEffect(() => {
    if ((!draftAutoSaveEligible && !editAutoSaveEligible) || !authReady || !userId) return;

    const current: ManagerListingSubmissionV1 = { ...sub, serviceRequestOptions: serviceOffers };
    if (!listingWizardHasUnsavedInput(current, baselineFingerprintRef.current ?? "")) {
      return;
    }

    const fingerprint = listingSubmissionFingerprint(current);
    const alreadyPersisted =
      fingerprint === lastPersistedFingerprintRef.current &&
      (!draftAutoSaveEligible ||
        (stepIndex === lastPersistedStepRef.current.stepIndex &&
          maxStepReached === lastPersistedStepRef.current.maxStepReached));
    if (alreadyPersisted) return;

    setAutosaveStatus((status) =>
      status === "saved" || status === "saved-without-photos" ? "idle" : status,
    );
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveDirtyRef.current = true;
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      autosaveDirtyRef.current = false;
      if (draftAutoSaveEligible) {
        void persistListingDraft({ silent: true });
      } else {
        void persistEditListing({ silent: true });
      }
    }, LISTING_DRAFT_AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [
    authReady,
    draftAutoSaveEligible,
    editAutoSaveEligible,
    maxStepReached,
    persistEditListing,
    persistListingDraft,
    serviceOffers,
    stepIndex,
    sub,
    userId,
  ]);

  useEffect(() => {
    if (!draftAutoSaveEligible && !editAutoSaveEligible) return;
    const flushOnHide = () => {
      if (document.visibilityState !== "hidden") return;
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      if (!autosaveDirtyRef.current) return;
      autosaveDirtyRef.current = false;
      if (draftAutoSaveEligible) {
        void persistListingDraft({ silent: true });
      } else {
        void persistEditListing({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", flushOnHide);
    return () => document.removeEventListener("visibilitychange", flushOnHide);
  }, [draftAutoSaveEligible, editAutoSaveEligible, persistEditListing, persistListingDraft]);

  const submitListing = async () => {
    // EXACTLY what the steps run. Submit used to omit `stFeeToggles` and
    // `ltFeeToggles`, so the short-term fee checks were skipped entirely and
    // the long-term ones fell back to a derived guess. Already-visited steps
    // stay clickable, so the bypass was accidental as much as deliberate:
    // complete Pricing, go back, clear the nightly rate, click Submit — and a
    // short-term listing published with no nightly rate, which is the exact
    // state `validateListingStFeeToggles` exists to prevent. That rate is not
    // cosmetic: `resolveStayPricing` reads it, and both the lease document and
    // the charge ledger read that.
    const validateOpts = {
      isEditMode,
      entireHomeRent,
      stFeeToggles,
      ltFeeToggles,
      managerSkuTier,
      accountPaymentWaiverGranted: paymentWaiverGranted,
    };
    const invalid = (() => {
      if (!isPreviewWizard) return firstInvalidListingStep(sub, validateOpts, 5);
      for (const i of wizardSteps) {
        const errors = validateListingWizardStep(i, sub, validateOpts);
        if (Object.keys(errors).length > 0) return { stepIndex: i, errors };
      }
      return null;
    })();
    if (invalid) {
      setStepIndex(invalid.stepIndex);
      setMaxStepReached((m) => Math.max(m, invalid.stepIndex));
      setStepFieldErrors(invalid.errors);
      showToast("Please fix the highlighted fields before submitting.");
      queueMicrotask(() =>
        scrollToFirstWizardFieldError(
          buildListingStepFieldOrder(invalid.stepIndex, sub),
          invalid.errors,
          scrollRef.current,
        ),
      );
      return;
    }

    const submission = buildSubmissionPayload();
    // ONE predicate with the Pricing step. Submit used to demand
    // `monthlyRent > 0` while Pricing accepted a daily rate too, so a manager
    // who priced every room daily — the correct setup for the short-term
    // listings this product supports — passed Pricing, reached the end, and was
    // refused by an error pointing back at a step that reported itself as fine.
    // There was no way to resolve it without guessing at a monthly figure the
    // wizard never asked for.
    const roomsOk = isEntireHomeListing(submission)
      ? entireHomeMonthlyRentAmount(submission) > 0 && submission.rooms.some((r) => r.name.trim())
      : submission.rooms.some((r) => r.name.trim() && listingRoomHasRent(r));
    if (!submission.address.trim() || !submission.zip.trim()) {
      showToast("Fill in address and ZIP.");
      return;
    }
    if (!roomsOk) {
      showToast(
        isEntireHomeListing(submission)
          ? "Add at least one bedroom and the monthly rent for the entire home."
          : "Add at least one room with a name and a monthly or daily rent.",
      );
      return;
    }

    const mediaReadiness = summarizePropertyMediaReadiness(submission.rooms);
    if (!isPreviewWizard && shouldWarnOnPublish(mediaReadiness)) {
      const pct = Math.round(mediaReadiness.percentReady * 100);
      const proceed = window.confirm(
        `Only ${mediaReadiness.readyCount} of ${mediaReadiness.listedCount} listed rooms have photos or video (${pct}%). Applicants may see rooms without media. Submit anyway?`,
      );
      if (!proceed) return;
    }

    setBusy(true);
    try {
      if (!authReady || !userId) {
        showToast("Sign in to submit a property.");
        return;
      }
      // A courtesy pre-check so the manager is told before their photos upload.
      // It is NOT the limit — `POST /api/property-records` re-checks against the
      // server's own count and plan, and its refusal is surfaced below.
      if (!isEditMode && managerTierPropertyLimitReached(skuTier, propCountBeforeSubmit)) {
        showToast(managerPropertyLimitMessage(skuTier, { omitUpgradeCta: isNativeRuntimeSync() }));
        return;
      }
      let uploadedSubmission: typeof submission;
      try {
        const uploaded = await uploadSubmissionMedia(submission);
        // A published listing must never quietly go live missing an attachment.
        if (uploaded.failedCount > 0) {
          showToast("Could not upload photos. Check your connection and try again.");
          return;
        }
        uploadedSubmission = uploaded.submission;
      } catch (err) {
        console.error("manager-add-listing-form: uploadSubmissionMedia failed", err);
        showToast("Could not upload photos. Check your connection and try again.");
        return;
      }

      if (editPendingId) {
        const ok = await updatePendingManagerPropertyOnServer(editPendingId, uploadedSubmission, userId);
        if (!ok) {
          console.error("manager-add-listing-form: updatePendingManagerPropertyOnServer returned false", { editPendingId, userId });
          showToast("Could not save changes.");
          return;
        }
        onSubmitted();
        return;
      }
      if (editRequestChangeId) {
        const ok = updateRequestChangeProperty(editRequestChangeId, userId, uploadedSubmission);
        if (!ok) {
          console.error("manager-add-listing-form: updateRequestChangeProperty returned false", { editRequestChangeId, userId });
          showToast("Could not save changes.");
          return;
        }
        showToast("Changes saved. Your listing is live on Rent with PropLane.");
        onSubmitted();
        return;
      }
      if (editListingId) {
        const saveUserId = editListingOwnerUserId?.trim() || userId;
        const ok = await updateExtraListingFromSubmissionOnServer(editListingId, saveUserId, uploadedSubmission);
        if (!ok) {
          console.error("manager-add-listing-form: updateExtraListingFromSubmissionOnServer returned false", { editListingId, saveUserId });
          showToast("Could not save changes.");
          return;
        }
        showToast("Listing saved. It is live on Rent with PropLane.");
        onSubmitted();
        return;
      }
      // Publishing a draft promotes the SAME record id draft → live, so the id
      // the manager's saved progress already carries becomes the listing's
      // permanent public URL — never a second row alongside the draft.
      const draftId = draftIdRef.current;
      // A refusal the server explains — the plan property-limit 403 — must reach
      // the manager verbatim; falling back to "Could not submit listing." would
      // read as a broken button rather than a limit with a way past it.
      let serverError = "";
      const publishOpts = {
        onError: (message: string) => {
          serverError = message;
        },
      };
      const id = draftId
        ? await publishManagerPropertyDraftToServer(draftId, uploadedSubmission, userId, publishOpts)
        : await submitManagerPendingPropertyToServer(uploadedSubmission, userId, publishOpts);
      if (!id) {
        showToast(serverError || "Could not submit listing.");
        return;
      }
      draftIdRef.current = null;
      if (isDemoModeActive()) {
        window.dispatchEvent(new CustomEvent(DEMO_LISTING_SUBMITTED_EVENT, { detail: { id } }));
      }
      onSubmitted();
    } finally {
      setBusy(false);
    }
  };
  // Keep the ref pointing at the latest submitListing without touching it during
  // render (react-hooks/refs) — the demo-autofill effect below reads it.
  useEffect(() => {
    submitListingRef.current = submitListing;
  });

  useEffect(() => {
    if (!demoAutofillSubmitPending || !isDemoModeActive()) return;
    setDemoAutofillSubmitPending(false);
    const body = scrollRef.current;
    if (body && body.scrollHeight > body.clientHeight + 8) {
      body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
      window.setTimeout(() => void submitListingRef.current(), 560);
      return;
    }
    void submitListingRef.current();
  }, [demoAutofillSubmitPending, sub]);

  // Hoisted above the `!mounted` early return: every hook has to run in the same
  // order on every render, and this sat ~460 lines below the return, so an
  // unmounted first paint called one fewer hook than a mounted one.
  const presentation = useModalPresentation();
  const isDrawer = presentation === "drawer";

  if (!mounted) return null;

  // ── Unified Fees UI sections ──
  // Rooms and Bundles are folded into the Pricing step's "Fees" subsection so the whole
  // screen reads as one sectioned table (Rooms | Bundles + Other fees) instead of the old
  // separate floating blocks. Each room and each bundle carries its own dropdown with rent
  // (rooms) / price (bundles), security deposit, and utilities (fixed cost vs resident pays).
  // Rent by room ON (shared-home) ALWAYS lists every room as its own rent row — the primary
  // content of this view. (Previously gated on longTermLeaseEnabled, which hid the rows on a
  // listing with no long-term term and left only the grouped-leases affordance showing.)
  const roomsFeeSection: FeeExpandableSection | null =
    rentByRoom
      ? {
          key: "rooms",
          title: "Rooms",
          hint: "Each room's rent, deposit, and utilities.",
          rows: sub.rooms.map((room, i) => {
            const roomRentKey = listingRoomRentKey(room.id);
            const roomRentErr = stepFieldErrors[roomRentKey];
            const roomDailyRentErr = stepFieldErrors[listingRoomDailyRentKey(room.id)];
            const roomLabel = room.name.trim() || `Room ${i + 1}`;
            const priced = listingRoomHasRent(room);
            const roomSummary = listingRoomPricingSummaryLabel(room, sub);
            const priceKey = listingItemKey("roomPrice", room.id);
            const expanded = priced
              ? isListingItemExpanded(priceKey) || Boolean(roomRentErr || roomDailyRentErr)
              : true;
            return {
              id: room.id,
              title: roomLabel,
              summary: priced ? roomSummary : "Rent not set",
              shortTermSummary: (room.shortTermRent ?? "").replace(/^\$/, "").trim()
                ? `$${(room.shortTermRent ?? "").replace(/^\$/, "").trim()}/night`
                : undefined,
              expanded,
              onToggle: () => toggleListingItem(priceKey),
              onRemove: sub.rooms.length > 1 ? () => removeRoom(i) : undefined,
              hasError: Boolean(roomRentErr || roomDailyRentErr || stepFieldErrors.monthlyRent),
              toggleDataAttr: `listing-room-price-toggle-${room.id}`,
              detail: (
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                  {/* Two labelled halves when the listing offers both, so a
                      manager can see which rate they are typing (PRP-146). */}
                  <LongTermRentSection heading={Boolean(sub.shortTermRentalsAllowed)}>
                  <GridField>
                    <FieldLabel>Monthly rent *</FieldLabel>
                    <div data-wizard-field={roomRentKey}>
                      <MoneyInput
                        invalid={Boolean(roomRentErr || stepFieldErrors.monthlyRent)}
                        ariaLabel={`Monthly rent for ${roomLabel}`}
                        value={room.monthlyRent || ""}
                        onChange={(e) => {
                          clearListingFieldError("monthlyRent");
                          clearListingFieldError(roomRentKey);
                          expandListingItem(priceKey);
                          setRoom(i, { monthlyRent: parseSanitizedMoneyNumber(e.target.value) });
                          if (parseSanitizedMoneyNumber(e.target.value) > 0) {
                            setLtFeeToggles((prev) => ({ ...prev, rent: true }));
                          }
                        }}
                        placeholder="800"
                      />
                      <StepFieldError msg={roomRentErr} />
                    </div>
                  </GridField>
                  <GridField>
                    <FieldLabel>Security deposit</FieldLabel>
                    <MoneyInput
                      ariaLabel={`Security deposit for ${roomLabel}`}
                      value={(room.securityDeposit ?? "").replace(/^\$/, "").trim()}
                      onChange={(e) => setRoom(i, { securityDeposit: sanitizeMoneyInput(e.target.value) })}
                      placeholder="1000"
                    />
                  </GridField>
                  <GridField>
                    <FieldLabel>Move-in fee</FieldLabel>
                    <MoneyInput
                      ariaLabel={`Move-in fee for ${roomLabel}`}
                      value={(room.moveInFee ?? "").replace(/^\$/, "").trim()}
                      onChange={(e) => setRoom(i, { moveInFee: sanitizeMoneyInput(e.target.value) })}
                      placeholder="250"
                    />
                  </GridField>
                  <GridField>
                    {/* Picker + amount on one inline row (no inference: who-pays is set only
                        by the picker, so no billing change). */}
                    <div className="flex flex-wrap items-end gap-2">
                      <LongTermUtilitiesPaymentPicker
                        value={room.utilitiesPaymentModel}
                        onSelect={(model) =>
                          setRoom(i, {
                            utilitiesPaymentModel: model,
                            ...(model === "tenant_direct" ? { utilitiesEstimate: "" } : {}),
                          })
                        }
                      />
                      {longTermUtilitiesEstimateRequired(room.utilitiesPaymentModel) ? (
                        <MoneyInput
                          ariaLabel={`${utilitiesAmountFieldNoun(room.utilitiesPaymentModel)} for ${roomLabel}`}
                          value={room.utilitiesEstimate.replace(/^\$/, "").replace(/\/mo(nth)?\.?$/i, "").trim()}
                          onChange={(e) => setRoom(i, { utilitiesEstimate: sanitizeMoneyInput(e.target.value) })}
                          placeholder="175"
                        />
                      ) : null}
                    </div>
                  </GridField>
                  <div className="w-full">
                    <ProrationMethodFields
                      prorateMethod={room.prorateMethod ?? "auto"}
                      monthlyRent={room.monthlyRent}
                      dailyRentRate={room.dailyRentRate}
                      dailyUtilitiesRate={room.dailyUtilitiesRate}
                      onMethod={(m) => setRoom(i, { prorateMethod: m })}
                      onDailyRent={(n) => setRoom(i, { dailyRentRate: n })}
                      onDailyUtilities={(n) => setRoom(i, { dailyUtilitiesRate: n })}
                    />
                  </div>
                  </LongTermRentSection>
                  {sub.shortTermRentalsAllowed ? (
                    <ShortTermRentSection
                      labelFor={roomLabel}
                      rent={(room.shortTermRent ?? "").replace(/^\$/, "").trim()}
                      moveInFee={(room.shortTermMoveInFee ?? "").replace(/^\$/, "").trim()}
                      deposit={(room.shortTermDeposit ?? "").replace(/^\$/, "").trim()}
                      onRent={(v) => setRoom(i, { shortTermRent: v })}
                      onMoveIn={(v) => setRoom(i, { shortTermMoveInFee: v })}
                      onDeposit={(v) => setRoom(i, { shortTermDeposit: v })}
                    />
                  ) : null}
                </div>
              ),
            };
          }),
        }
      : null;

  // Grouped leases always render, regardless of Rent-by-room (round 18 #1): rent-by-room OFF
  // shows this as the primary way to price the place, ON keeps it as the grouping affordance.
  const bundlesFeeSection: FeeExpandableSection | null = true
    ? {
        key: "bundles",
        title: "Grouped leases",
        hint: "Optional — rent several rooms together on one lease.",
        // No emptyHint: the header hint already says this; a second copy read as a duplicate.
        emptyHint: undefined,
        toolbar: (
          <>
            {/* Grouping is folded into the rent-by-room view as one small affordance instead
                of the old Whole house / Group / Custom pill row. A group can cover any rooms —
                pick all of them for a whole-house lease. */}
            <Button
              type="button"
              variant="outline"
              className="rounded-full text-xs"
              onClick={addBundle}
              disabled={sub.rooms.filter((room) => room.name.trim()).length < 2}
            >
              + Group rooms
            </Button>
          </>
        ),
        rows: (sub.bundles ?? []).map((bundle) => {
          const i = (sub.bundles ?? []).findIndex((b) => b.id === bundle.id);
          const selectedIds = new Set(bundle.includedRoomIds ?? []);
          const namedRooms = sub.rooms.filter((r) => r.name.trim());
          const selectedRooms = namedRooms.filter((r) => selectedIds.has(r.id));
          const rentSum = selectedRooms.reduce((sum, r) => sum + (Number.isFinite(r.monthlyRent) ? r.monthlyRent : 0), 0);
          const priceNum = bundle.price.replace(/^\$/, "").replace(/\/mo(nth)?\.?$/i, "").trim();
          const hasManualPrice = priceNum.length > 0 && Number(priceNum) !== rentSum;
          const stNightlyKey = `bundle-${bundle.id}-shortTermNightlyRent`;
          const stNightlyErr = stepFieldErrors[stNightlyKey];
          const stPriceHint = bundleShortTermPriceLabel(bundle, sub);
          return {
            id: bundle.id,
            title: bundle.label.trim() || `Package ${i + 1}`,
            summary: [
              `${selectedRooms.length} room${selectedRooms.length === 1 ? "" : "s"}`,
              rentSum > 0 ? `$${rentSum}/mo base` : null,
              hasManualPrice ? "Custom price" : null,
              bundle.shortTermEnabled && stPriceHint ? stPriceHint : null,
            ]
              .filter(Boolean)
              .join(" · "),
            expanded: isListingItemExpanded(listingItemKey("bundle", bundle.id)),
            onToggle: () => toggleListingItem(listingItemKey("bundle", bundle.id)),
            onRemove: () => removeBundle(i),
            toggleDataAttr: `listing-bundle-toggle-${bundle.id}`,
            detail: (
              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                <GridField>
                  <FieldLabel>Bundle name</FieldLabel>
                  <Input
                    value={bundle.label}
                    onChange={(e) => setBundle(i, { label: sanitizePlaceNameInput(e.target.value) })}
                    placeholder="Whole house lease, Rooms A+B"
                  />
                </GridField>
                <GridField>
                  <FieldLabel hint="Defaults to sum of room rents; edit for discounts.">Bundle rent / mo</FieldLabel>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">$</span>
                    <Input
                      inputMode="decimal"
                      className="pl-8"
                      value={bundle.price.replace(/^\$/, "").replace(/\/mo(nth)?\.?$/i, "").trim()}
                      onChange={(e) => setBundle(i, { price: sanitizeMoneyInput(e.target.value) })}
                      placeholder={rentSum > 0 ? String(rentSum) : "4500"}
                    />
                  </div>
                </GridField>
                <GridField>
                  <FieldLabel hint="Optional — shows crossed out on the listing.">Original price</FieldLabel>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">$</span>
                    <Input
                      inputMode="decimal"
                      className="pl-8"
                      value={bundle.strikethrough.replace(/^\$/, "").replace(/\/mo(nth)?\.?$/i, "").trim()}
                      onChange={(e) => setBundle(i, { strikethrough: sanitizeMoneyInput(e.target.value) })}
                      placeholder="4800"
                    />
                  </div>
                </GridField>
                <GridField>
                  <FieldLabel>Security deposit</FieldLabel>
                  <MoneyInput
                    ariaLabel={`Security deposit for ${bundle.label.trim() || "bundle"}`}
                    value={(bundle.securityDeposit ?? "").replace(/^\$/, "").trim()}
                    onChange={(e) => setBundle(i, { securityDeposit: sanitizeMoneyInput(e.target.value) })}
                    placeholder="1500"
                  />
                </GridField>
                <GridField>
                  <FieldLabel>Move-in fee</FieldLabel>
                  <MoneyInput
                    ariaLabel={`Move-in fee for ${bundle.label.trim() || "bundle"}`}
                    value={(bundle.moveInFee ?? "").replace(/^\$/, "").trim()}
                    onChange={(e) => setBundle(i, { moveInFee: sanitizeMoneyInput(e.target.value) })}
                    placeholder="250"
                  />
                </GridField>
                <GridField>
                  <div className="flex flex-wrap items-end gap-2">
                    <LongTermUtilitiesPaymentPicker
                      value={bundle.utilitiesPaymentModel}
                      onSelect={(model) =>
                        setBundle(i, {
                          utilitiesPaymentModel: model,
                          ...(model === "tenant_direct" ? { utilitiesEstimate: "" } : {}),
                        })
                      }
                    />
                    {longTermUtilitiesEstimateRequired(bundle.utilitiesPaymentModel) ? (
                      <MoneyInput
                        ariaLabel={`${utilitiesAmountFieldNoun(bundle.utilitiesPaymentModel)} for ${bundle.label.trim() || "bundle"}`}
                        value={(bundle.utilitiesEstimate ?? "").replace(/^\$/, "").replace(/\/mo(nth)?\.?$/i, "").trim()}
                        onChange={(e) => setBundle(i, { utilitiesEstimate: sanitizeMoneyInput(e.target.value) })}
                        placeholder="200"
                      />
                    ) : null}
                  </div>
                </GridField>
                {sub.shortTermRentalsAllowed ? (
                  <ShortTermRentSection
                    labelFor={bundle.label.trim() || "bundle"}
                    rentInvalid={Boolean(stNightlyErr)}
                    rent={(bundle.shortTermNightlyRent ?? "").replace(/^\$/, "").trim()}
                    moveInFee={(bundle.shortTermMoveInFee ?? "").replace(/^\$/, "").trim()}
                    deposit={(bundle.shortTermDeposit ?? "").replace(/^\$/, "").trim()}
                    onRent={(v) => {
                      clearListingFieldError(stNightlyKey);
                      setBundle(i, { shortTermNightlyRent: v, shortTermEnabled: v.trim() !== "" });
                    }}
                    onMoveIn={(v) => setBundle(i, { shortTermMoveInFee: v })}
                    onDeposit={(v) => setBundle(i, { shortTermDeposit: v })}
                  />
                ) : null}
                <div className="w-full">
                  <FieldLabel>Rooms in this bundle</FieldLabel>
                </div>
                <div className="w-full">
                  <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {sub.rooms.length > 0 ? (
                      <SelectAllCheckbox
                        allChecked={sub.rooms.every((r) => selectedIds.has(r.id))}
                        someChecked={selectedIds.size > 0 && !sub.rooms.every((r) => selectedIds.has(r.id))}
                        onToggle={(checkAll) => applyBundleRoomScope(i, checkAll ? "all_named" : "none")}
                        label="All rooms"
                      />
                    ) : null}
                    {sub.rooms.map((room) => (
                      <label key={`${bundle.id}-${room.id}`} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={selectedIds.has(room.id)}
                          onChange={(e) => toggleBundleRoom(i, room.id, e.target.checked)}
                        />
                        <span className="min-w-0 font-medium text-foreground">
                          <span className="truncate">{roomLabelForBundle(room)}</span>
                          {room.monthlyRent > 0 ? (
                            <span className="ml-1 tabular-nums text-xs font-normal text-muted">· ${room.monthlyRent}</span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ),
          };
        }),
      }
    : null;

  // Entire-home rent now lives in the Rent section as its own "Whole place" row (round 27),
  // not in Other fees. It carries the whole-place monthly rent plus utilities & proration
  // (folded in from the old standalone block). Removing it routes through the SAME
  // removedFeeRows("rent") flag the fees table used, and "+ Add rent" comes back here in the
  // Rent section — never in Other fees — so a manager who removes rent is never stranded.
  const wholePlaceRentRemoved = removedFeeRows.has("rent");
  const wholePlaceKey = listingItemKey("wholeplace", "main");
  const entireHomeUtilShort =
    sub.entireHomeUtilitiesPaymentModel === "tenant_direct"
      ? "Paid by resident"
      : sub.entireHomeUtilitiesPaymentModel === "included_in_rent"
        ? "Utilities included"
        : sub.entireHomeUtilitiesPaymentModel === "variable"
          ? "Billed by usage"
          : "Fixed amount";
  const wholePlaceStNightly = shortTermNightlyRate(sub.shortTermDailyCost);
  const wholePlaceStSummary =
    wholePlaceStNightly > 0
      ? `$${wholePlaceStNightly}/night`
      : sub.shortTermRentalsAllowed
        ? "Short-term rent not set"
        : undefined;
  const wholePlaceFeeSection: FeeExpandableSection | null = isEntireHome
    ? {
        key: "wholeplace",
        title: "Whole place",
        hint: "One lease for the entire place.",
        toolbar: wholePlaceRentRemoved ? (
          <Button
            type="button"
            variant="outline"
            className="rounded-full text-xs"
            onClick={() => handleAddStandardRow("rent")}
          >
            + Add rent
          </Button>
        ) : undefined,
        emptyHint: wholePlaceRentRemoved ? "Rent removed — add it back to set a price and publish." : undefined,
        rows: wholePlaceRentRemoved
          ? []
          : [
              {
                id: "whole-place",
                title: "Whole place lease",
                summary: `${entireHomeRent > 0 ? `$${entireHomeRent}/mo` : "Rent not set"} · ${entireHomeUtilShort}`,
                shortTermSummary: wholePlaceStSummary,
                expanded:
                  isListingItemExpanded(wholePlaceKey) ||
                  Boolean(stepFieldErrors.monthlyRent || stepFieldErrors.shortTermDailyCost),
                onToggle: () => toggleListingItem(wholePlaceKey),
                onRemove: () => handleRemoveStandardRow("rent"),
                hasError: Boolean(stepFieldErrors.monthlyRent),
                toggleDataAttr: "listing-wholeplace-toggle",
                detail: (
                  <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                    <GridField>
                      <FieldLabel>Monthly rent *</FieldLabel>
                      <div data-wizard-field="monthlyRent">
                        <MoneyInput
                          invalid={Boolean(stepFieldErrors.monthlyRent)}
                          ariaLabel="Monthly rent for the whole place"
                          value={entireHomeRent || ""}
                          onChange={(e) => {
                            clearListingFieldError("monthlyRent");
                            expandListingItem(wholePlaceKey);
                            const n = parseSanitizedMoneyNumber(e.target.value);
                            setSub((s) => applyEntireHomeListingPricing(s, { entireHomeMonthlyRent: n }));
                            if (n > 0) setLtFeeToggles((prev) => ({ ...prev, rent: true }));
                          }}
                          placeholder="4500"
                        />
                        <StepFieldError msg={stepFieldErrors.monthlyRent} />
                      </div>
                    </GridField>
                    {longTermLeaseEnabled ? (
                      <>
                        <GridField>
                          <div className="flex flex-wrap items-end gap-2">
                            <LongTermUtilitiesPaymentPicker
                              value={sub.entireHomeUtilitiesPaymentModel}
                              onSelect={(model) =>
                                setSub((s) =>
                                  applyEntireHomeListingPricing(s, {
                                    entireHomeUtilitiesPaymentModel: model,
                                    ...(model === "tenant_direct" ? { entireHomeUtilitiesEstimate: "" } : {}),
                                  }),
                                )
                              }
                            />
                            {longTermUtilitiesEstimateRequired(sub.entireHomeUtilitiesPaymentModel) ? (
                              <MoneyInput
                                ariaLabel={`${utilitiesAmountFieldNoun(sub.entireHomeUtilitiesPaymentModel)} (whole home)`}
                                value={(sub.entireHomeUtilitiesEstimate ?? "").replace(/^\$/, "").replace(/\/mo(nth)?\.?$/i, "").trim()}
                                onChange={(e) =>
                                  setSub((s) =>
                                    applyEntireHomeListingPricing(s, { entireHomeUtilitiesEstimate: sanitizeMoneyInput(e.target.value) }),
                                  )
                                }
                                placeholder="175"
                              />
                            ) : null}
                          </div>
                        </GridField>
                        <div className="w-full">
                          <ProrationMethodFields
                            prorateMethod={sub.entireHomeProrateMethod ?? "auto"}
                            monthlyRent={entireHomeRent}
                            dailyRentRate={sub.entireHomeDailyRentRate}
                            dailyUtilitiesRate={sub.entireHomeDailyUtilitiesRate}
                            onMethod={(m) => setSub((s) => applyEntireHomeListingPricing(s, { entireHomeProrateMethod: m }))}
                            onDailyRent={(n) => setSub((s) => applyEntireHomeListingPricing(s, { entireHomeDailyRentRate: n }))}
                            onDailyUtilities={(n) => setSub((s) => applyEntireHomeListingPricing(s, { entireHomeDailyUtilitiesRate: n }))}
                          />
                        </div>
                      </>
                    ) : null}
                    {sub.shortTermRentalsAllowed ? (
                      <ShortTermRentSection
                        rent={(sub.shortTermDailyCost ?? "").replace(/^\$/, "").trim()}
                        moveInFee={(sub.shortTermMoveInFee ?? "").replace(/^\$/, "").trim()}
                        deposit={(sub.shortTermDeposit ?? "").replace(/^\$/, "").trim()}
                        rentInvalid={Boolean(stepFieldErrors.shortTermDailyCost)}
                        onRent={(v) => {
                          clearListingFieldError("shortTermDailyCost");
                          expandListingItem(wholePlaceKey);
                          setSub((s) => ({ ...s, shortTermDailyCost: v }));
                          if (v.trim()) setStFeeToggles((prev) => ({ ...prev, rent: true }));
                        }}
                        onMoveIn={(v) => {
                          clearListingFieldError("shortTermMoveInFee");
                          setSub((s) => ({ ...s, shortTermMoveInFee: v }));
                          if (v.trim()) setStFeeToggles((prev) => ({ ...prev, moveInFee: true }));
                        }}
                        onDeposit={(v) => {
                          clearListingFieldError("shortTermDeposit");
                          setSub((s) => ({ ...s, shortTermDeposit: v }));
                          if (v.trim()) setStFeeToggles((prev) => ({ ...prev, securityDeposit: true }));
                        }}
                      />
                    ) : null}
                  </div>
                ),
              },
            ],
      }
    : null;

  const feeExpandableSections: FeeExpandableSection[] = [
    wholePlaceFeeSection,
    roomsFeeSection,
    bundlesFeeSection,
  ].filter((s): s is FeeExpandableSection => s !== null);


  const requestWizardClose = () => {
    if (busy || closingDraft) return;
    closeWizard();
  };

  if (!mounted) return null;

  return (
    <ModalShell
      open
      onClose={requestWizardClose}
      presentation="dialog"
      portalContainer={portalContainer}
      lockScroll
      dismissBlocked={busy || closingDraft}
      dismissOnCanvasPointerDown
      panelClassName="pointer-events-none fixed inset-0 flex min-h-0 min-w-0 outline-none"
    >
      <div
        data-modal-assistant-workspace=""
        data-full-screen={isDrawer ? "true" : "false"}
        className={cn("pointer-events-none flex min-h-0 min-w-0 flex-1 items-center justify-center", isDrawer ? "p-0" : "p-4")}
      >
      <div data-listing-editor="" className={cn(
        "pointer-events-auto @container flex min-h-0 min-w-0 w-full flex-col overflow-hidden",
        isDrawer
          ? cn(
              MODAL_FULL_PAGE_PANEL_CLASS,
              "!relative !inset-auto !h-full !max-h-full border-border bg-[#111827] [html[data-theme=light]_&]:bg-white",
            )
          : "modal-panel relative z-10 flex max-h-[calc(100svh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-[#111827] shadow-2xl sm:max-h-[calc(100svh-1.5rem)] lg:max-h-[calc(100svh-2rem)] [html[data-theme=light]_&]:border-border [html[data-theme=light]_&]:bg-white",
      )}>
      {/* A plain container, not a <form>: the PropLane Assistant embedded in the
          body has its own <form> for the chat composer, and a form-in-form is
          invalid HTML that throws a hydration error whenever the assistant is
          open. Continue / Submit are onClick buttons,
          so nothing here relied on form submission. */}
      <div id="manager-add-listing-form" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* ── Header ── */}
        <div className="modal-panel shrink-0 border-b border-border px-5 pt-5 pb-6 sm:px-6">
          <div className="flex w-full min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-bold tracking-tight text-foreground sm:text-xl">
                {wizardTitlePrefix} · {LISTING_FORM_STEPS[stepIndex]?.label}
              </p>
            </div>
            <span ref={setAssistantTriggerTarget} className="shrink-0" />
            <button
              type="button"
              onClick={closeWizard}
              disabled={busy || closingDraft}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/30 text-muted hover:bg-accent/40 disabled:opacity-60"
              aria-label="Close"
              data-attr="listing-wizard-close"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
            </button>
          </div>

          {/* The single progress + navigation signal (replaces the old
              "STEP X OF 6" line + duplicate progress bar). A completed step
              shows a ✓ and stays clickable; the current step is filled; a step
              not yet reached is visible but disabled, so the wizard never styles
              a jump the manager cannot actually make. */}
          <nav aria-label="Listing steps" className="mt-3 -mx-1 overflow-x-auto px-1 [-webkit-overflow-scrolling:touch]">
            <ol className="flex min-w-max items-center gap-1">
              {wizardSteps.map((i, pillPos) => {
                const step = LISTING_FORM_STEPS[i]!;
                const reachable = canNavigateToWizardStep(i, maxStepReached);
                const isCurrent = i === stepIndex;
                const completed = pillPos < visibleStepPosition;
                return (
                  <li key={step.id} className="flex items-center">
                    <button
                      type="button"
                      disabled={!reachable}
                      aria-current={isCurrent ? "step" : undefined}
                      onClick={() => { if (reachable) { setStepFieldErrors({}); setStepIndex(i); } }}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-3 text-xs font-semibold transition",
                        isCurrent
                          ? "bg-primary/10 text-primary"
                          : completed
                            ? "text-foreground hover:bg-accent/40"
                            : reachable
                              ? "text-muted hover:bg-accent/40"
                              : "cursor-default text-muted/45",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                          completed
                            ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
                            : isCurrent
                              ? "bg-primary text-white"
                              : "border border-border text-muted/60",
                        )}
                      >
                        {completed ? "✓" : pillPos + 1}
                      </span>
                      {step.label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* Step blurb */}
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            {LISTING_STEP_BLURBS[LISTING_FORM_STEPS[stepIndex]!.id]}
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 pb-6 sm:px-6">
          {/* Content FILLS the modal width (padding on the scroll container provides the
              margins). A max-width column here centered wide children and clipped them on
              both edges against the panel's overflow-hidden — do not reintroduce it. */}
          <div className="w-full min-w-0">
          {/* ── Step 0: Home ── */}
          {stepIndex === 0 ? (
          <FormSection
            id="edit-building"
            title="Tell us about your place"
            description="The essentials for your listing, grouped into a few short sections. You can change anything here later."
            compact
          >
            <ListingSubsection
              title="Address & property type"
              description="Where the place is and what kind of home it is. Choosing an address result fills in city, state, and ZIP for you."
            >
              <div className="grid gap-3 sm:grid-cols-2">
              <div data-wizard-field="listingPropertyTypeId" className={wizardSectionErrorClass(Boolean(stepFieldErrors.listingPropertyTypeId))}>
                <FieldLabel required>Property type</FieldLabel>
                <Select
                  aria-label="Property type"
                  className={wizardFieldErrorClass(Boolean(stepFieldErrors.listingPropertyTypeId), selectInputCls)}
                  value={sub.listingPropertyTypeId ?? ""}
                  onChange={(e) => {
                    clearListingFieldError("listingPropertyTypeId");
                    setSub((s) => ({ ...s, listingPropertyTypeId: e.target.value }));
                  }}
                >
                  <option value="">Select</option>
                  {LISTING_PROPERTY_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
                <StepFieldError msg={stepFieldErrors.listingPropertyTypeId} />
              </div>

              <div data-wizard-field="buildingName">
                <FieldLabel required>Property name</FieldLabel>
                <Input
                  value={sub.buildingName}
                  onChange={(e) => {
                    clearListingFieldError("buildingName");
                    setSub((s) => ({ ...s, buildingName: sanitizeBuildingNameInput(e.target.value) }));
                  }}
                  className={wizardFieldErrorClass(Boolean(stepFieldErrors.buildingName), listingTextInputCls)}
                  placeholder="e.g. Maple Court"
                />
                <StepFieldError msg={stepFieldErrors.buildingName} />
              </div>

              <div className="relative z-20 sm:col-span-2" data-wizard-field="address">
                <FieldLabel required hint="Start typing to search. Choosing a result fills in city, state, and ZIP below.">Street address</FieldLabel>
                <ListingAddressAutocomplete
                  value={sub.address}
                  className={wizardFieldErrorClass(Boolean(stepFieldErrors.address), listingTextInputCls)}
                  aria-invalid={Boolean(stepFieldErrors.address)}
                  onChange={(address) => {
                    clearListingFieldError("address");
                    setSub((s) => ({ ...s, address }));
                  }}
                  onSelect={(suggestion) => {
                    clearListingFieldError("address");
                    clearListingFieldError("zip");
                    clearListingFieldError("city");
                    clearListingFieldError("state");
                    setSub((s) => ({
                      ...s,
                      address: sanitizeStreetAddressInput(suggestion.address || suggestion.label),
                      zip: suggestion.zip ? sanitizeZipInput(suggestion.zip) : s.zip,
                      city: suggestion.city ? sanitizeCityInput(suggestion.city) : s.city,
                      state: suggestion.state ? sanitizeStateInput(suggestion.state) : s.state,
                    }));
                  }}
                />
                <StepFieldError msg={stepFieldErrors.address} />
              </div>

              <GridField>
                <FieldLabel required hint="Fills in from the address. Edit if it is off.">City</FieldLabel>
                <div data-wizard-field="city">
                  <Input
                    value={sub.city}
                    onChange={(e) => {
                      clearListingFieldError("city");
                      setSub((s) => ({ ...s, city: sanitizeCityInput(e.target.value) }));
                    }}
                    className={wizardFieldErrorClass(Boolean(stepFieldErrors.city), listingTextInputCls)}
                    placeholder="Autofilled"
                    autoComplete="address-level2"
                  />
                  <StepFieldError msg={stepFieldErrors.city} />
                </div>
              </GridField>
              <GridField>
                <FieldLabel required hint="2-letter code, e.g. WA or CA.">State</FieldLabel>
                <div data-wizard-field="state">
                  <Input
                    value={sub.state}
                    onChange={(e) => {
                      clearListingFieldError("state");
                      setSub((s) => ({ ...s, state: sanitizeStateInput(e.target.value) }));
                    }}
                    className={wizardFieldErrorClass(Boolean(stepFieldErrors.state), listingTextInputCls)}
                    placeholder="WA"
                    maxLength={2}
                    autoComplete="address-level1"
                  />
                  <StepFieldError msg={stepFieldErrors.state} />
                </div>
              </GridField>
              <GridField>
                <FieldLabel required hint="Fills in from the address. Edit if it is off.">ZIP</FieldLabel>
                <div data-wizard-field="zip">
                  <Input
                    value={sub.zip}
                    onChange={(e) => {
                      clearListingFieldError("zip");
                      setSub((s) => ({ ...s, zip: sanitizeZipInput(e.target.value) }));
                    }}
                    className={wizardFieldErrorClass(Boolean(stepFieldErrors.zip), listingTextInputCls)}
                    maxLength={10}
                    inputMode="numeric"
                    placeholder="Autofilled"
                    autoComplete="postal-code"
                  />
                  <StepFieldError msg={stepFieldErrors.zip} />
                </div>
              </GridField>
              </div>
            </ListingSubsection>

            <ListingSubsection
              title="Size & layout"
              description="How big the home is and how it is laid out."
            >
              <div className="grid gap-3 sm:grid-cols-2">
              <GridField>
                <FieldLabel required>Floors</FieldLabel>
                <div data-wizard-field="listingStoriesId">
                  <Select
                    aria-label="Number of floors"
                    className={wizardFieldErrorClass(Boolean(stepFieldErrors.listingStoriesId), selectInputCls)}
                    value={sub.listingStoriesId ?? ""}
                    onChange={(e) => {
                      clearListingFieldError("listingStoriesId");
                      setSub((s) => ({ ...s, listingStoriesId: e.target.value }));
                    }}
                  >
                    <option value="">Select</option>
                    {LISTING_STORIES_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <StepFieldError msg={stepFieldErrors.listingStoriesId} />
                </div>
              </GridField>
              <GridField>
                <FieldLabel required>Bathrooms</FieldLabel>
                <div data-wizard-field="listingTotalBathroomsId">
                  <Select
                    aria-label="Total bathrooms"
                    className={wizardFieldErrorClass(Boolean(stepFieldErrors.listingTotalBathroomsId), selectInputCls)}
                    value={sub.listingTotalBathroomsId ?? ""}
                    onChange={(e) => {
                      clearListingFieldError("listingTotalBathroomsId");
                      setSub((s) => ({ ...s, listingTotalBathroomsId: e.target.value }));
                    }}
                  >
                    <option value="">Select</option>
                    {LISTING_TOTAL_BATH_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <StepFieldError msg={stepFieldErrors.listingTotalBathroomsId} />
                </div>
              </GridField>
              <GridField>
                <FieldLabel required>Bedrooms</FieldLabel>
                <div data-wizard-field="listingBedroomSlots">
                  <Select
                    aria-label="Bedrooms for rent"
                    className={wizardFieldErrorClass(Boolean(stepFieldErrors.listingBedroomSlots), selectInputCls)}
                    value={String(sub.listingBedroomSlots ?? sub.rooms.length)}
                    onChange={(e) => {
                      clearListingFieldError("listingBedroomSlots");
                      setSub((s) => ({ ...s, listingBedroomSlots: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }));
                    }}
                  >
                    {LISTING_BEDROOM_SLOT_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n} bedroom{n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </Select>
                  <StepFieldError msg={stepFieldErrors.listingBedroomSlots} />
                </div>
              </GridField>
              <div className="flex items-end pb-2.5">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={sub.petFriendly}
                    onChange={(e) => setSub((s) => ({ ...s, petFriendly: e.target.checked }))}
                    className="h-4 w-4 shrink-0 rounded border-border"
                  />
                  Pet-friendly
                </label>
              </div>
              </div>
            </ListingSubsection>

            <ListingSubsection
              title="Description & move-in"
              description="What a renter reads on the listing, plus how they get in on move-in day."
            >
              <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <FieldLabel optional>Listing tagline</FieldLabel>
                <Input
                  value={sub.tagline}
                  onChange={(e) => setSub((s) => ({ ...s, tagline: e.target.value }))}
                  className={listingTextInputCls}
                  placeholder="Short headline for search cards"
                />
              </div>
              <div className="sm:col-span-2">
                <FieldLabel optional>House overview</FieldLabel>
                <Textarea
                  rows={3}
                  value={sub.houseOverview}
                  onChange={(e) => setSub((s) => ({ ...s, houseOverview: e.target.value }))}
                  className={listingTextInputCls}
                  placeholder="Describe the home and who it’s good for."
                />
              </div>
              <div className="sm:col-span-2">
                <FieldLabel optional hint="Only if the layout is unusual.">Extra layout note</FieldLabel>
                <Input
                  value={sub.homeStructureNote}
                  onChange={(e) => setSub((s) => ({ ...s, homeStructureNote: e.target.value }))}
                  className={listingTextInputCls}
                  placeholder="e.g. Garden ADU with private entrance"
                />
              </div>
              <div className="sm:col-span-2">
                <FieldLabel optional hint="Keys, parking, access, what to bring.">Move-in instructions</FieldLabel>
                <Textarea
                  rows={4}
                  value={sub.houseMoveInInstructions ?? ""}
                  onChange={(e) => setSub((s) => ({ ...s, houseMoveInInstructions: e.target.value }))}
                  className={listingTextInputCls}
                  placeholder="Where to pick up keys, parking spot, gate codes, move-in window…"
                />
              </div>
              </div>
            </ListingSubsection>

            <ListingSubsection
              title="Full-house photos & video"
              description="Up to 12 photos for the public listing gallery."
            >
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div
                  className={`flex min-h-[8.5rem] flex-col ${mediaDropZoneClass(activeDropZone === "house-photos")}`}
                  onDragOver={(e) => handleDragOver(e, "house-photos")}
                  onDragEnter={(e) => handleDragOver(e, "house-photos")}
                  onDragLeave={(e) => handleDragLeave(e, "house-photos")}
                  onDrop={onDropHousePhotos}
                >
                  <FieldLabel>Full-house photos</FieldLabel>
                  <MediaPickTrigger accept="image/*" multiple onFiles={(files) => { void onPickHousePhotos(files); }}>
                    Add house photos
                  </MediaPickTrigger>
                  <p className="mt-2 text-xs text-muted">Drag and drop, or use the button.</p>
                  {(sub.housePhotoDataUrls?.length ?? 0) > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(sub.housePhotoDataUrls ?? []).map((url, pi) => (
                        <div key={`house-p-${pi}`} className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-accent/30">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt="" className="h-full w-full object-cover" />
                          <button type="button" className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded-bl bg-black/55 text-sm font-bold text-white hover:bg-black/70" onClick={() => removeHousePhoto(pi)} aria-label="Remove photo">×</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-auto pt-2 text-[11px] text-muted">Optional for draft — recommended before you go live.</p>
                  )}
                </div>
                <div
                  className={`flex min-h-[8.5rem] flex-col ${mediaDropZoneClass(activeDropZone === "house-video")}`}
                  onDragOver={(e) => handleDragOver(e, "house-video")}
                  onDragEnter={(e) => handleDragOver(e, "house-video")}
                  onDragLeave={(e) => handleDragLeave(e, "house-video")}
                  onDrop={onDropHouseVideo}
                >
                  <FieldLabel hint="Optional walkthrough (~14 MB max).">Full-house video</FieldLabel>
                  <MediaPickTrigger accept="video/*" disabled={videoUploadingKeys.has("house")} onFiles={(files) => { void onPickHouseVideo(files?.[0] ?? null); }}>
                    {videoUploadingKeys.has("house") ? "Uploading…" : sub.houseVideoDataUrl ? "Replace video" : "Add house video"}
                  </MediaPickTrigger>
                  {!sub.houseVideoDataUrl && !videoUploadingKeys.has("house") ? (
                    <p className="mt-2 text-xs text-muted">Drop one video here or use the button.</p>
                  ) : null}
                  {sub.houseVideoDataUrl ? (
                    <div className="mt-3 space-y-2">
                      <video src={videoPreviewUrls.house ?? sub.houseVideoDataUrl} controls className="max-h-48 w-full rounded-xl border border-border bg-black object-contain" />
                      <button type="button" onClick={clearHouseVideo} className="text-xs font-medium text-rose-600 hover:text-rose-800">Remove video</button>
                    </div>
                  ) : (
                    <p className="mt-auto pt-2 text-[11px] text-muted">Optional — MP4, MOV, or WebM.</p>
                  )}
                </div>
              </div>
            </ListingSubsection>

            <ListingSubsection
              title="Building & neighborhood amenities"
              description="What shows in the main amenities table on the listing. Kitchen gear, shared desks, and TV belong under Shared spaces; bathroom finishes under Bathrooms."
            >
              <div>
                <FieldLabel>Common amenities</FieldLabel>
                <PresetCheckboxGroup
                  key="house-amenities"
                  presets={dedupedPresets.houseWide}
                  value={sub.amenitiesText}
                  onChange={(v) => setSub((s) => ({ ...s, amenitiesText: v }))}
                  otherForcedOpen={otherAmenitiesOpenRooms.has("house")}
                  onOtherForcedOpenChange={(open) => toggleOtherAmenitiesOpen("house", open)}
                  otherPlaceholder="Other amenities, comma-separated"
                />
              </div>
            </ListingSubsection>
          </FormSection>
          ) : null}

          {/* ── Step 4: Pricing ── */}
          {stepIndex === 4 ? (
          <FormSection id="edit-lease" title="Pricing">
            <div className="space-y-5">
              <ListingSubsection title="Leasing">
                <div className="space-y-3">
                  <div data-wizard-field="allowedLeaseTerms" className={wizardSectionErrorClass(Boolean(stepFieldErrors.allowedLeaseTerms))}>
                    <FieldLabel required>Lease lengths</FieldLabel>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {/* Standard lengths, then Short-term (a listing-wide toggle, not a lease
                        term), then Custom last — Short-term sits with the other lease-length
                        choices instead of a separate titled block. */}
                    {/*
                      LEASE_TERM_CHOICES, not LEASE_TERM_OPTIONS: a manager now
                      offers Long-term rather than picking among 3/6/9/12-Month
                      (AXI-143). A listing that still carries a legacy length
                      keeps it — normalization accepts the whole option set —
                      it just is not offered again here.
                    */}
                    {[...LEASE_TERM_CHOICES.filter((t) => t !== CUSTOM_LEASE_TERM), "__short_term__", "__airbnb__", CUSTOM_LEASE_TERM].map((term) => {
                      if (term === "__short_term__") {
                        const on = Boolean(sub.shortTermRentalsAllowed);
                        return (
                          <label
                            key="__short_term__"
                            className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-3 text-sm shadow-sm transition-colors ${
                              on ? "border-foreground/25 bg-accent/40" : "border-border bg-card"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={on}
                              onChange={(e) => {
                                clearListingFieldError("allowedLeaseTerms");
                                const enabled = e.target.checked;
                                setSub((s) => {
                                  const standard = resolveAllowedLeaseTerms(s).filter(
                                    (t) => t !== SHORT_TERM_LEASE_TERM && t !== AIRBNB_LEASE_TERM,
                                  );
                                  const next = syncShortTermLeaseTermInAllowed(standard, enabled);
                                  const bundles = enabled
                                    ? s.bundles
                                    : (s.bundles ?? []).map((b) => ({ ...b, shortTermEnabled: false, shortTermNightlyRent: "" }));
                                  return syncPropertyLeaseTemplatesFromListing({
                                    ...s,
                                    shortTermRentalsAllowed: enabled,
                                    allowedLeaseTerms: next,
                                    leaseTermsBody: formatLeaseTermsBodyFromAllowed(next),
                                    bundles,
                                  });
                                });
                              }}
                            />
                            <span className="font-medium text-foreground">Short-term</span>
                          </label>
                        );
                      }
                      if (term === "__airbnb__") {
                        const on = Boolean(sub.airbnbRentalsAllowed);
                        return (
                          <label
                            key="__airbnb__"
                            className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-3 text-sm shadow-sm transition-colors ${
                              on ? "border-foreground/25 bg-accent/40" : "border-border bg-card"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={on}
                              onChange={(e) => {
                                clearListingFieldError("allowedLeaseTerms");
                                const enabled = e.target.checked;
                                setSub((s) => {
                                  const standard = resolveAllowedLeaseTerms(s).filter(
                                    (t) => t !== SHORT_TERM_LEASE_TERM && t !== AIRBNB_LEASE_TERM,
                                  );
                                  const withShort = syncShortTermLeaseTermInAllowed(
                                    standard,
                                    Boolean(s.shortTermRentalsAllowed),
                                  );
                                  const next = syncAirbnbLeaseTermInAllowed(withShort, enabled);
                                  return syncPropertyLeaseTemplatesFromListing({
                                    ...s,
                                    airbnbRentalsAllowed: enabled,
                                    allowedLeaseTerms: next,
                                    leaseTermsBody: formatLeaseTermsBodyFromAllowed(next),
                                  });
                                });
                              }}
                            />
                            <span className="font-medium text-foreground">Airbnb</span>
                          </label>
                        );
                      }
                      const selected = resolveAllowedLeaseTerms(sub).includes(term);
                      return (
                        <label
                          key={term}
                          className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-3 text-sm shadow-sm transition-colors ${
                            selected ? "border-foreground/25 bg-accent/40" : "border-border bg-card"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border"
                            checked={selected}
                            onChange={(e) => {
                              clearListingFieldError("allowedLeaseTerms");
                              const on = e.target.checked;
                              setSub((s) => {
                                const current = resolveAllowedLeaseTerms(s).filter(
                                  (t) => t !== SHORT_TERM_LEASE_TERM && t !== AIRBNB_LEASE_TERM,
                                );
                                const nextStandard = on
                                  ? [...new Set([...current, term])]
                                  : current.filter((t) => t !== term);
                                const withShort = syncShortTermLeaseTermInAllowed(
                                  nextStandard,
                                  Boolean(s.shortTermRentalsAllowed),
                                );
                                const next = syncAirbnbLeaseTermInAllowed(withShort, Boolean(s.airbnbRentalsAllowed));
                                return syncPropertyLeaseTemplatesFromListing({
                                  ...s,
                                  allowedLeaseTerms: next,
                                  leaseTermsBody: formatLeaseTermsBodyFromAllowed(next),
                                });
                              });
                            }}
                          />
                          <span className="font-medium text-foreground">{term}</span>
                        </label>
                      );
                    })}
                  </div>
                  <StepFieldError msg={stepFieldErrors.allowedLeaseTerms} />
                  </div>
                </div>
              </ListingSubsection>

              <ListingSubsection title="Rent">
                <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border"
                    checked={rentByRoom}
                    onChange={(e) => handleRentByRoomToggle(e.target.checked)}
                  />
                  Rent by room
                  <span className="text-xs font-normal text-muted">— a rent row per room; off = one rent for the whole place</span>
                </label>
                <div data-wizard-field="monthlyRent">
                <ListingUnifiedFeesTable
                  expandableSections={feeExpandableSections}
                  showShortTerm={Boolean(sub.shortTermRentalsAllowed)}
                  sub={sub}
                  isEntireHome={isEntireHome}
                  stFeeToggles={stFeeToggles}
                  ltFeeToggles={ltFeeToggles}
                  onStToggle={handleStFeeToggle}
                  onLtToggle={handleLtFeeToggle}
                  onStAmount={handleStFeeAmount}
                  onLtAmount={handleLtFeeAmount}
                  onLtAmountForRow={handleLtFeeAmountForRow}
                  hiddenRowIds={hiddenStandardFeeRows}
                  removedRowIds={removedFeeRows}
                  onRemoveStandardRow={handleRemoveStandardRow}
                  onAddStandardRow={handleAddStandardRow}
                  stepFieldErrors={stepFieldErrors}
                  customFees={sub.customFees ?? []}
                  onAddCustomFee={addCustomFee}
                  onRemoveCustomFee={removeCustomFee}
                  onCustomFeeChange={(i, patch) => {
                    if (patch.label !== undefined) {
                      setCustomFee(i, { label: sanitizePlaceNameInput(patch.label) });
                      return;
                    }
                    setCustomFee(i, patch);
                  }}
                  onPresetCadenceChange={(presetId, next) => {
                    // A new listing has no materialized fee rows yet, so the first
                    // cadence change creates the preset's row rather than silently
                    // doing nothing.
                    setSub((s) => {
                      const rows = [...(s.customFees ?? [])];
                      const existing = rows.findIndex(
                        (f) => (f as { presetId?: string }).presetId === presetId,
                      );
                      if (existing >= 0) {
                        rows[existing] = { ...rows[existing]!, frequency: next };
                        return { ...s, customFees: rows };
                      }
                      const preset = LISTING_FEE_PRESETS.find((pr) => pr.presetId === presetId);
                      rows.push({
                        id: `fee-${presetId}`,
                        label: preset?.defaultLabel ?? presetId,
                        amount: "",
                        frequency: next,
                        presetId,
                      } as (typeof rows)[number]);
                      return { ...s, customFees: rows };
                    });
                  }}
                />
                </div>

                <div className="mt-4 space-y-2 border-t border-border pt-4">
                  <FieldLabel optional>Application fee waive code</FieldLabel>
                  <Input
                    aria-label="Application fee waive code"
                    value={sub.applicationFeeWaiverCode ?? ""}
                    onChange={(e) =>
                      setSub((s) => ({
                        ...s,
                        applicationFeeWaiverCode: e.target.value.toUpperCase(),
                      }))
                    }
                    placeholder="E.G. WELCOME50"
                    data-attr="listing-application-fee-waiver-code"
                    className="w-full font-mono uppercase"
                  />
                  <p className="text-xs text-muted">
                    Applicants entering this code apply for free on this listing. Leave empty to turn it off.
                  </p>
                </div>

                <div className="mt-4 space-y-3 border-t border-border pt-4">
                  <FieldLabel optional>Payment at signing</FieldLabel>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {PAYMENT_AT_SIGNING_OPTIONS.map((opt) => (
                      <label key={opt.id} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={sub.paymentAtSigningIncludes.includes(opt.id)}
                          onChange={(e) =>
                            // Writes the checkbox list AND the matching fee row,
                            // which are two stores of one fact — see
                            // applyPaymentAtSigningSelection.
                            setSub((s) => applyPaymentAtSigningSelection(s, opt.id, e.target.checked))
                          }
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                  {/* The signing-total and other-fees recaps were removed: every
                      figure in them is already stated by the checkboxes above and
                      by each room row, so they only restated the form back to the
                      manager. */}
                </div>

                <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                  <GridField>
                    <FieldLabel>Monthly due date</FieldLabel>
                    <Select
                      value={sub.rentDueDayMode ?? "first_of_month"}
                      onChange={(e) =>
                        setSub((s) => ({
                          ...s,
                          rentDueDayMode: e.target.value === "last_of_month" ? "last_of_month" : "first_of_month",
                        }))
                      }
                    >
                      <option value="first_of_month">1st of the month</option>
                      <option value="last_of_month">Last day of the month</option>
                    </Select>
                  </GridField>
                  <GridField>
                    <FieldLabel>Processing fee paid by</FieldLabel>
                    <Select
                      value={serviceFeePayerUi}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const next: ServiceFeePayer =
                          raw === "proplane" || raw === "manager" || raw === "resident" ? raw : "resident";
                        if (next === "manager" && !canSelectManagerAbsorbFee) return;
                        setSub((s) => ({
                          ...s,
                          serviceFeePayer: next,
                          serviceFeeWaiverCode: next === "proplane" ? s.serviceFeeWaiverCode : undefined,
                        }));
                      }}
                    >
                      <option value="resident">Resident pays</option>
                      <option value="manager" disabled={!canSelectManagerAbsorbFee}>
                        Manager pays{canSelectManagerAbsorbFee ? "" : " (needs paid plan)"}
                      </option>
                      <option value="proplane">PropLane absorbs</option>
                    </Select>
                  </GridField>
                  {showProcessingFeeWaiveCode ? (
                    <div className="space-y-2 sm:col-span-2">
                      <FieldLabel optional={!proplaneAbsorbNeedsWaiverCode}>Processing fee waive code</FieldLabel>
                      <Input
                        value={sub.serviceFeeWaiverCode ?? ""}
                        onChange={(e) =>
                          setSub((s) => ({
                            ...s,
                            serviceFeePayer: "proplane",
                            serviceFeeWaiverCode: normalizeListingPaymentWaiverCode(e.target.value),
                          }))
                        }
                        placeholder="FREE100"
                        aria-label="Processing fee waive code"
                        autoComplete="off"
                        data-attr="listing-service-fee-waiver-code"
                        className="w-full font-mono uppercase sm:max-w-xs"
                        aria-invalid={Boolean(stepFieldErrors.serviceFeeWaiverCode)}
                        aria-describedby={
                          stepFieldErrors.serviceFeeWaiverCode ? "listing-service-fee-waiver-error" : undefined
                        }
                      />
                      {proplaneAbsorbNeedsWaiverCode ? (
                        <p className="text-xs text-muted">
                          Required — enter FREE100 so PropLane can absorb processing fees on this listing.
                        </p>
                      ) : null}
                      {stepFieldErrors.serviceFeeWaiverCode ? (
                        <p id="listing-service-fee-waiver-error" className="text-xs text-destructive">
                          {stepFieldErrors.serviceFeeWaiverCode}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <GridField>
                    <FieldLabel>Late fee grace (days)</FieldLabel>
                    <Input
                      inputMode="numeric"
                      min={0}
                      max={30}
                      value={String(sub.lateFeeGraceDays ?? 5)}
                      onChange={(e) =>
                        setSub((s) => ({
                          ...s,
                          lateFeeGraceDays: Math.max(0, Math.min(30, parseSanitizedInteger(e.target.value, 5))),
                        }))
                      }
                    />
                  </GridField>
                  <GridField>
                    <FieldLabel>Late fee amount</FieldLabel>
                    <MoneyInput
                      value={(sub.lateFeeAmount ?? "50").replace(/^\$/, "").trim()}
                      onChange={(e) => setSub((s) => ({ ...s, lateFeeAmount: sanitizeMoneyInput(e.target.value) }))}
                      placeholder="50"
                      ariaLabel="Late fee amount"
                    />
                  </GridField>
                  <GridField>
                    <FieldLabel>Automatic late fees</FieldLabel>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border"
                        checked={sub.lateFeeEnabled !== false}
                        onChange={(e) => setSub((s) => ({ ...s, lateFeeEnabled: e.target.checked }))}
                      />
                      Auto-charge & notify
                    </label>
                  </GridField>
                </div>

                <p className="mt-4 border-t border-border pt-4 text-xs text-muted">
                  Payment methods: configure in{" "}
                  <span className="font-medium text-foreground">Payments → Payment setup</span>.
                </p>
              </ListingSubsection>
            </div>
          </FormSection>
          ) : null}

          {/* ── Step 1: Rooms ── */}
          {stepIndex === 1 ? (
          <FormSection
            id="edit-rooms"
            title="Rooms"
            description={
              isEntireHome
                ? "List each bedroom — name, floor, furnishing, amenities, and optional photos or video. Rent and utilities are set on Pricing. House move-in instructions are on Home."
                : "Name, floor, furnishing, amenities, photos, video, and per-room move-in notes. Rent is set on Pricing."
            }
          >
            <div
              className={`space-y-3 ${wizardSectionErrorClass(Boolean(stepFieldErrors.rooms))}`}
              data-wizard-field="rooms"
            >
              {stepFieldErrors.rooms ? (
                <p className="text-xs font-medium text-red-600">{stepFieldErrors.rooms}</p>
              ) : null}
              {sortRoomIndicesByFloor(sub.rooms).map((i) => {
                const room = sub.rooms[i]!;
                const furnished = roomIsFurnished(room);
                const checkedFurniture = parseFurnitureSet(room.furnishing);
                const roomNameKey = listingRoomNameKey(room.id);
                const roomRentKey = listingRoomRentKey(room.id);
                const roomDailyRentKey = listingRoomDailyRentKey(room.id);
                const roomWeeklyRentKey = listingRoomWeeklyRentKey(room.id);
                const roomNameErr = stepFieldErrors[roomNameKey];
                const roomRentErr = stepFieldErrors[roomRentKey];
                const roomDailyRentErr = stepFieldErrors[roomDailyRentKey];
                const roomWeeklyRentErr = stepFieldErrors[roomWeeklyRentKey];
                const roomHasErr = Boolean(roomNameErr || roomRentErr || roomDailyRentErr || roomWeeklyRentErr);
                // The facts a manager compares rooms on, on the row itself
                // (PRP-137): where it is, how big, whether it is furnished.
                // Furnishing used to print the whole item list here, which
                // pushed the rest of the line off the end.
                const roomSubtitle = [
                  room.floor.trim() || null,
                  room.sizeSqft != null && room.sizeSqft > 0 ? `${room.sizeSqft} sq ft` : null,
                  room.furnishing.trim() ? "Furnished" : null,
                  room.photoDataUrls.length > 0 ? `${room.photoDataUrls.length} photo${room.photoDataUrls.length === 1 ? "" : "s"}` : null,
                  room.videoDataUrl?.trim() ? "Video" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Tap to add floor, size, and amenities";
                const roomMediaScore = scoreRoomMedia(room);
                const roomKey = listingItemKey("room", room.id);
                return (
                  <ListingWizardCollapsibleCard
                    key={room.id}
                    expanded={isListingItemExpanded(roomKey)}
                    onToggle={() => toggleListingItem(roomKey)}
                    title={room.name.trim() || `Room ${i + 1}`}
                    subtitle={roomSubtitle}
                    meta={
                      room.monthlyRent > 0 ? (
                        <ListingWizardRowMeta value={`$${room.monthlyRent} / mo`} />
                      ) : (
                        <ListingWizardRowMeta value="Rent not set" muted />
                      )
                    }
                    hasError={roomHasErr}
                    bodyClassName="grid gap-3 sm:grid-cols-2"
                    toggleDataAttr={`listing-room-toggle-${room.id}`}
                    headerActions={
                      <>
                        <RoomMediaTierBadge score={roomMediaScore} />
                        <Button
                          type="button"
                          variant="outline"
                          className={LISTING_WIZARD_ACTION_BTN}
                          onClick={() => duplicateRoom(i)}
                          disabled={sub.rooms.length >= 20}
                        >
                          Duplicate
                        </Button>
                        {sub.rooms.length > 1 ? (
                          <Button
                            type="button"
                            variant="outline"
                            className={LISTING_WIZARD_REMOVE_BTN}
                            onClick={() => removeRoom(i)}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </>
                    }
                  >
                      <GridField>
                        <FieldLabel hint="Autofilled — edit anytime.">Room name</FieldLabel>
                        <div data-wizard-field={roomNameKey}>
                          <Input
                            value={room.name}
                            className={wizardFieldErrorClass(Boolean(roomNameErr))}
                            onChange={(e) => {
                              clearListingFieldError(roomNameKey);
                              clearListingFieldError("rooms");
                              setRoom(i, { name: sanitizePlaceNameInput(e.target.value) });
                            }}
                            placeholder="Room 12A"
                          />
                          <StepFieldError msg={roomNameErr} />
                        </div>
                      </GridField>
                      <GridField>
                        <FieldLabel>Floor</FieldLabel>
                        <Select
                          aria-label={`Floor for ${room.name || `room ${i + 1}`}`}
                          className={selectInputCls}
                          value={room.floor}
                          onChange={(e) => setRoom(i, { floor: e.target.value })}
                        >
                          <option value="">Select floor</option>
                          {floorLevelSelectOptions(sub.listingStoriesId, room.floor).map((label) => (
                            <option key={label} value={label}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      </GridField>
                      <GridField>
                        <FieldLabel hint="Each resident signs their own lease and pays this room's full rent.">
                          Beds (residents)
                        </FieldLabel>
                        <Select
                          aria-label={`Number of residents for ${room.name || `room ${i + 1}`}`}
                          className={selectInputCls}
                          data-attr="listing-room-occupancy-capacity"
                          value={String(normalizeRoomOccupancyCapacity(room.occupancyCapacity))}
                          // The select can only emit 1..20, so normalizing here is a
                          // backstop rather than the gate; junk cannot be typed in.
                          onChange={(e) =>
                            setRoom(i, { occupancyCapacity: normalizeRoomOccupancyCapacity(e.target.value) })
                          }
                        >
                          {LISTING_BEDROOM_SLOT_OPTIONS.map((n) => (
                            <option key={n} value={n}>
                              {n === 1 ? "1 resident" : `${n} residents`}
                            </option>
                          ))}
                        </Select>
                      </GridField>
                      <GridField>
                        <FieldLabel hint="Flexible pricing agrees a price with each resident. Any range you give is guidance shown to prospects — it is never billed.">
                          Pricing
                        </FieldLabel>
                        <Select
                          aria-label={`Pricing mode for ${room.name || `room ${i + 1}`}`}
                          className={selectInputCls}
                          data-attr="listing-room-pricing-mode"
                          value={room.pricingMode === "flexible" ? "flexible" : "fixed"}
                          onChange={(e) =>
                            setRoom(i, {
                              pricingMode: e.target.value === "flexible" ? "flexible" : "fixed",
                              // Switching back to a fixed price DROPS the advertised range
                              // rather than leaving it stored and invisible, so it can never
                              // reappear later as a quote the manager believes they removed.
                              ...(e.target.value === "flexible"
                                ? {}
                                : { flexibleRentMin: undefined, flexibleRentMax: undefined }),
                            })
                          }
                        >
                          <option value="fixed">Fixed price</option>
                          <option value="flexible">Flexible pricing</option>
                        </Select>
                        {room.pricingMode !== "flexible" ? (
                          <div className="mt-3 space-y-3">
                            <p className="text-xs text-muted">
                              Quote the rates you actually offer. A weekly or daily rate is a
                              real price, not the monthly one divided up — leave a row blank if
                              you do not offer that length.
                            </p>
                            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                              <GridField>
                                <FieldLabel>Rent / week</FieldLabel>
                                <MoneyInput
                                  ariaLabel={`Weekly rent for ${room.name || `room ${i + 1}`}`}
                                  data-attr="listing-room-weekly-rent"
                                  invalid={Boolean(roomWeeklyRentErr)}
                                  value={room.weeklyRentPrice === undefined ? "" : String(room.weeklyRentPrice)}
                                  onChange={(e) => {
                                    const n = parseFloat(sanitizeMoneyInput(e.target.value));
                                    clearListingFieldError(roomWeeklyRentKey);
                                    setRoom(i, { weeklyRentPrice: Number.isFinite(n) && n > 0 ? n : undefined });
                                  }}
                                  placeholder="Weekly rate"
                                />
                                <StepFieldError msg={roomWeeklyRentErr} />
                              </GridField>
                              <GridField>
                                <FieldLabel>Rent / day</FieldLabel>
                                <MoneyInput
                                  ariaLabel={`Daily rent for ${room.name || `room ${i + 1}`}`}
                                  data-attr="listing-room-daily-rent-basis"
                                  invalid={Boolean(roomDailyRentErr)}
                                  value={room.dailyRentPrice === undefined ? "" : String(room.dailyRentPrice)}
                                  onChange={(e) => {
                                    const n = parseFloat(sanitizeMoneyInput(e.target.value));
                                    clearListingFieldError(roomDailyRentKey);
                                    setRoom(i, { dailyRentPrice: Number.isFinite(n) && n > 0 ? n : undefined });
                                  }}
                                  placeholder="Daily rate"
                                />
                                <StepFieldError msg={roomDailyRentErr} />
                              </GridField>
                              <GridField>
                                <FieldLabel hint="Which rate leads the listing and drives billing.">
                                  Billed by
                                </FieldLabel>
                                <Select
                                  aria-label={`Billing basis for ${room.name || `room ${i + 1}`}`}
                                  className={selectInputCls}
                                  data-attr="listing-room-rent-basis"
                                  value={room.rentBasis ?? "monthly"}
                                  onChange={(e) =>
                                    setRoom(i, { rentBasis: e.target.value as "monthly" | "weekly" | "daily" })
                                  }
                                >
                                  <option value="monthly">Month</option>
                                  <option value="weekly">Week</option>
                                  <option value="daily">Day</option>
                                </Select>
                              </GridField>
                            </div>
                            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                              <GridField>
                                <FieldLabel hint="Extra monthly rent on a short tenancy. Folded into the rent, not billed as a separate fee.">
                                  Short-lease surcharge / mo
                                </FieldLabel>
                                <MoneyInput
                                  ariaLabel={`Short-lease surcharge for ${room.name || `room ${i + 1}`}`}
                                  data-attr="listing-room-short-lease-surcharge"
                                  value={(room.shortLeaseSurchargeMonthly ?? "").replace(/^\$/, "").trim()}
                                  onChange={(e) =>
                                    setRoom(i, { shortLeaseSurchargeMonthly: sanitizeMoneyInput(e.target.value) })
                                  }
                                  placeholder="Extra per month"
                                />
                              </GridField>
                              <GridField>
                                <FieldLabel>Short lease is up to</FieldLabel>
                                <Input
                                  inputMode="numeric"
                                  aria-label={`Short lease threshold in months for ${room.name || `room ${i + 1}`}`}
                                  data-attr="listing-room-short-lease-months"
                                  placeholder="Months"
                                  value={room.shortLeaseMaxMonths === undefined ? "" : String(room.shortLeaseMaxMonths)}
                                  onChange={(e) =>
                                    setRoom(i, { shortLeaseMaxMonths: normalizeShortLeaseMaxMonths(e.target.value) })
                                  }
                                />
                              </GridField>
                            </div>
                            {(room.shortLeaseSurchargeMonthly ?? "").trim() &&
                            room.shortLeaseMaxMonths === undefined ? (
                              <p className="text-xs text-danger" role="alert">
                                Set how many months counts as a short lease, or this surcharge
                                will not apply to anyone.
                              </p>
                            ) : null}
                            {room.monthlyRent > 0 &&
                            room.shortLeaseMaxMonths !== undefined &&
                            (room.shortLeaseSurchargeMonthly ?? "").trim() ? (
                              <p className="text-xs text-muted" data-attr="listing-room-short-lease-preview">
                                A short lease is quoted as{" "}
                                <strong>
                                  ${(room.monthlyRent + roomShortLeaseSurcharge(room)).toLocaleString("en-US")}
                                </strong>{" "}
                                / month on a lease of {room.shortLeaseMaxMonths}{" "}
                                {room.shortLeaseMaxMonths === 1 ? "month" : "months"} or less —{" "}
                                ${room.monthlyRent.toLocaleString("en-US")} rent plus the surcharge.
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                        {room.pricingMode === "flexible" ? (
                          <div className="mt-3 space-y-2">
                            <p className="text-xs text-muted">
                              Agree a price with each resident. Leave both boxes empty to show no
                              numbers at all.
                            </p>
                            <div className="flex items-center gap-2">
                              <Input
                                inputMode="decimal"
                                aria-label={`Advertised minimum rent for ${room.name || `room ${i + 1}`}`}
                                data-attr="listing-room-flexible-min"
                                placeholder="Min (optional)"
                                value={room.flexibleRentMin ?? ""}
                                onChange={(e) =>
                                  setRoom(i, { flexibleRentMin: normalizeFlexibleRentBound(e.target.value) })
                                }
                              />
                              <span className="text-xs text-muted">to</span>
                              <Input
                                inputMode="decimal"
                                aria-label={`Advertised maximum rent for ${room.name || `room ${i + 1}`}`}
                                data-attr="listing-room-flexible-max"
                                placeholder="Max (optional)"
                                value={room.flexibleRentMax ?? ""}
                                onChange={(e) =>
                                  setRoom(i, { flexibleRentMax: normalizeFlexibleRentBound(e.target.value) })
                                }
                              />
                            </div>
                            {room.flexibleRentMin !== undefined &&
                            room.flexibleRentMax !== undefined &&
                            room.flexibleRentMax < room.flexibleRentMin ? (
                              <p className="text-xs text-danger" role="alert">
                                The maximum is below the minimum, so no range will be shown.
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </GridField>
                      <GridField>
                        <FieldLabel>Room inspections</FieldLabel>
                        <div className="space-y-3 py-2">
                          {(["moveIn", "moveOut"] as const).map(kind => <label key={kind} className="flex items-center gap-3 text-sm">
                            <input type="checkbox" className="h-4 w-4 accent-primary" checked={room[`${kind}InspectionRequired`] === true}
                              data-attr={`listing-room-${kind === "moveIn" ? "move-in" : "move-out"}-inspection-required`}
                              onChange={e => setRoom(i, { [`${kind}InspectionRequired`]: e.target.checked })} />
                            Require {kind === "moveIn" ? "move-in" : "move-out"} inspection
                          </label>)}
                        </div>
                      </GridField>
                      <GridField>
                        <FieldLabel optional hint="Shown beside the rent so a prospect can see why one room costs more.">
                          Size (sq ft)
                        </FieldLabel>
                        <Input
                          inputMode="numeric"
                          aria-label={`Size in square feet for ${room.name || `room ${i + 1}`}`}
                          className={listingTextInputCls}
                          value={room.sizeSqft != null ? String(room.sizeSqft) : ""}
                          placeholder="120"
                          onChange={(e) =>
                            // Blank clears it back to "not stated" rather than 0 —
                            // a 0 would render as "0 sq ft" on the listing.
                            setRoom(i, { sizeSqft: normalizeRoomSizeSqft(e.target.value) })
                          }
                        />
                      </GridField>
                      <div className="sm:col-span-2">
                        <FieldLabel hint="Check Furnished to list included items.">Furnishing</FieldLabel>
                        <div className="mt-2 rounded-xl border border-border bg-card p-3">
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={furnished}
                              onChange={(e) => setRoomFurnished(i, room, e.target.checked)}
                            />
                            <span className="font-semibold text-foreground">Furnished</span>
                            <span className="text-xs text-muted">— default is unfurnished</span>
                          </label>
                          {furnished ? (
                            <>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                {dedupedPresets.furniture.map((p) => {
                                  const on = checkedFurniture.has(p.label);
                                  return (
                                    <label key={p.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${on ? "border-primary/30 bg-primary/[0.05]" : "border-border bg-card"}`}>
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border-border"
                                        checked={on}
                                        onChange={(e) => setRoom(i, { furnishing: mergeFurnitureToggle(room.furnishing, p.label, e.target.checked) })}
                                      />
                                      <span className="font-medium text-foreground">{p.label}</span>
                                    </label>
                                  );
                                })}
                              </div>
                              {(() => {
                                const otherOn =
                                  otherFurnishingOpenRooms.has(room.id) || room.detail.trim() !== "";
                                return (
                                  <>
                                    <label
                                      className={`mt-2 flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition sm:w-auto ${otherOn ? "border-primary/30 bg-primary/[0.05]" : "border-border bg-card"}`}
                                    >
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border-border"
                                        checked={otherOn}
                                        data-attr={`listing-room-furnishing-other-${room.id}`}
                                        onChange={(e) => {
                                          toggleOtherFurnishingOpen(room.id, e.target.checked);
                                          // Unticking clears the note, or the box
                                          // would re-open itself on the next render.
                                          if (!e.target.checked && room.detail.trim()) {
                                            setRoom(i, { detail: "" });
                                          }
                                        }}
                                      />
                                      <span className="font-medium text-foreground">Other</span>
                                    </label>
                                    {otherOn ? (
                                      <Input
                                        className="mt-2 h-9 text-sm"
                                        value={room.detail}
                                        onChange={(e) => setRoom(i, { detail: e.target.value })}
                                        onKeyDown={(e) => e.stopPropagation()}
                                        placeholder="Other furnishing, comma-separated"
                                      />
                                    ) : null}
                                  </>
                                );
                              })()}
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="sm:col-span-2">
                        <FieldLabel>Room amenities</FieldLabel>
                        <PresetCheckboxGroup
                          key={`room-amenities-${room.id}`}
                          presets={dedupedPresets.room}
                          value={room.roomAmenitiesText}
                          onChange={(v) => setRoom(i, { roomAmenitiesText: v })}
                          otherForcedOpen={otherAmenitiesOpenRooms.has(room.id)}
                          onOtherForcedOpenChange={(open) => toggleOtherAmenitiesOpen(room.id, open)}
                          otherPlaceholder="Other amenities, comma-separated"
                        />
                      </div>

                      <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
                        <div>
                          <FieldLabel hint="Up to 8 images, auto-compressed.">Photos</FieldLabel>
                          <div
                            className={`mt-2 ${mediaDropZoneClass(activeDropZone === `room-photos-${room.id}`)}`}
                            onDragOver={(e) => handleDragOver(e, `room-photos-${room.id}`)}
                            onDragEnter={(e) => handleDragOver(e, `room-photos-${room.id}`)}
                            onDragLeave={(e) => handleDragLeave(e, `room-photos-${room.id}`)}
                            onDrop={(e) => onDropRoomPhotos(i, room.id, e)}
                          >
                            <MediaPickTrigger
                              accept="image/*"
                              multiple
                              onFiles={(files) => { void onPickRoomPhotos(i, files); }}
                            >
                              Add photos
                            </MediaPickTrigger>
                            <p className="mt-2 text-xs text-muted">Drop photos here or use the button.</p>
                            {room.photoDataUrls.length > 0 ? (
                              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {room.photoDataUrls.map((url, pi) => (
                                  <div key={`${room.id}-p-${pi}`} className="group relative overflow-hidden rounded-lg border border-border bg-accent/30">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={url} alt="" className="h-28 w-full object-cover" />
                                    <button
                                      type="button"
                                      className="absolute right-1 top-1 rounded-full bg-card px-2 py-0.5 text-[11px] font-semibold text-rose-600 shadow-sm opacity-0 transition group-hover:opacity-100"
                                      onClick={() => removeRoomPhoto(i, pi)}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div>
                          <FieldLabel hint="One short clip, ~14 MB max.">Video</FieldLabel>
                          <div
                            className={`mt-2 ${mediaDropZoneClass(activeDropZone === `room-video-${room.id}`)}`}
                            onDragOver={(e) => handleDragOver(e, `room-video-${room.id}`)}
                            onDragEnter={(e) => handleDragOver(e, `room-video-${room.id}`)}
                            onDragLeave={(e) => handleDragLeave(e, `room-video-${room.id}`)}
                            onDrop={(e) => onDropRoomVideo(i, room.id, e)}
                          >
                            <MediaPickTrigger
                              accept="video/*"
                              disabled={videoUploadingKeys.has(`room-${room.id}`)}
                              onFiles={(files) => { void onPickRoomVideo(i, files?.[0] ?? null); }}
                            >
                              {videoUploadingKeys.has(`room-${room.id}`) ? "Uploading…" : room.videoDataUrl ? "Replace video" : "Add video"}
                            </MediaPickTrigger>
                            {videoUploadingKeys.has(`room-${room.id}`) ? (
                              <p className="mt-2 text-xs text-primary">Uploading…</p>
                            ) : (
                              <p className="mt-2 text-xs text-muted">Drop one video here or use the button.</p>
                            )}
                            {room.videoDataUrl ? (
                              <div className="mt-4 space-y-2">
                                <video
                                  src={videoPreviewUrls[`room-${room.id}`] ?? room.videoDataUrl}
                                  controls
                                  playsInline
                                  className="max-h-52 w-full rounded-lg border border-border bg-black object-contain"
                                />
                                <button
                                  type="button"
                                  className="text-xs font-semibold text-rose-600 hover:underline"
                                  onClick={() => clearRoomVideo(i)}
                                >
                                  Remove video
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {!isEntireHome ? (
                        <div className="sm:col-span-2">
                          <FieldLabel hint="Keys, parking, access, what to bring for this room.">
                            Move-in instructions
                          </FieldLabel>
                          <Textarea
                            rows={4}
                            value={room.moveInInstructions}
                            onChange={(e) => setRoom(i, { moveInInstructions: e.target.value })}
                            className={listingTextInputCls}
                            placeholder="Room-specific access, parking, and move-in details…"
                          />
                        </div>
                      ) : null}
                  </ListingWizardCollapsibleCard>
                );
              })}
            </div>

            <ListingWizardListAddRow
              label="Add room"
              ariaLabel="Add room"
              icon={DoorOpen}
              onClick={addRoom}
              dataAttr="listing-add-room"
              inline={sub.rooms.length > 0}
            />

            {/* The "Room media readiness" panel was removed at the captain's request. The
                underlying summarizePropertyMediaReadiness still backs the publish-time
                warning (shouldWarnOnPublish) below, which is a separate safety gate. */}

            {/* Floor plans section removed from the wizard at the captain's request ("for
                now" — may return). The stored images are intentionally KEPT: the submission
                still carries propertyFloorPlanDataUrl + floorPlanByLabel, and the public
                listing / resident detail continues to display them. Only this upload UI is
                gone. Re-add this ListingSubsection to bring the editor back. */}
          </FormSection>
          ) : null}

          {stepIndex === 2 ? (
          <FormSection
            id="edit-bath"
            title="Bathrooms"
            description="Name, location, and amenities for each bathroom on the public listing."
          >
              {/* Answer the type in one tap; the fixtures it presets stay
                  editable inside each row (PRP-138). */}
              <div className="mb-4 grid gap-2 sm:grid-cols-3">
                {(
                  [
                    { id: "full", icon: "🛁", label: "Full bath", detail: "Shower · toilet · sink" },
                    { id: "half", icon: "🚽", label: "Half bath", detail: "Toilet · sink" },
                    { id: "ensuite", icon: "🚪", label: "En-suite", detail: "Attached to a room" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    data-attr={`listing-add-bathroom-${option.id}`}
                    disabled={sub.bathrooms.length >= 12}
                    onClick={(e) => {
                      if (ignoreMultiClick(e)) return;
                      addBathroomOfType(option.id);
                    }}
                    onDoubleClick={(e) => e.preventDefault()}
                    className="touch-manipulation select-none rounded-xl border border-border bg-card px-3 py-3 text-center transition hover:border-primary/35 hover:bg-primary/[0.04] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="block text-xl leading-none" aria-hidden>
                      {option.icon}
                    </span>
                    <span className="mt-1.5 block text-sm font-semibold text-foreground">{option.label}</span>
                    <span className="mt-0.5 block text-xs text-muted">{option.detail}</span>
                  </button>
                ))}
              </div>

              <div
                className={`space-y-3 ${wizardSectionErrorClass(Boolean(stepFieldErrors.bathrooms))}`}
                data-wizard-field="bathrooms"
              >
                {stepFieldErrors.bathrooms ? (
                  <p className="text-xs font-medium text-red-600">{stepFieldErrors.bathrooms}</p>
                ) : null}
                {sub.bathrooms.map((b, i) => {
                  const bathNameKey = listingBathroomNameKey(b.id);
                  const bathNameErr = stepFieldErrors[bathNameKey];
                  const fixtures = [
                    b.shower && "Shower",
                    b.toilet && "Toilet",
                    b.bathtub && "Tub",
                    b.sink && "Sink",
                    b.mirror && "Mirror",
                  ]
                    .filter(Boolean)
                    .join(", ");
                  const bathSubtitle = [
                    b.location?.trim() || null,
                    fixtures || null,
                    `${(b.assignedRoomIds ?? []).length} room(s)`,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const bathKey = listingItemKey("bathroom", b.id);
                  return (
                  <ListingWizardCollapsibleCard
                    key={b.id}
                    expanded={isListingItemExpanded(bathKey)}
                    onToggle={() => toggleListingItem(bathKey)}
                    title={b.name.trim() || `Bathroom ${i + 1}`}
                    subtitle={bathSubtitle || "Tap to set name, location, and fixtures"}
                    hasError={Boolean(bathNameErr)}
                    bodyClassName="grid gap-3 sm:grid-cols-2"
                    toggleDataAttr={`listing-bathroom-toggle-${b.id}`}
                    headerActions={
                      sub.bathrooms.length > 1 ? (
                        <Button
                          type="button"
                          variant="outline"
                          className={LISTING_WIZARD_REMOVE_BTN}
                          onClick={() => removeBathroom(i)}
                        >
                          Remove
                        </Button>
                      ) : null
                    }
                  >
                      <div className="sm:col-span-2" data-wizard-field={bathNameKey}>
                        <FieldLabel hint="Autofilled — edit anytime.">Name</FieldLabel>
                        <Input
                          value={b.name}
                          className={wizardFieldErrorClass(Boolean(bathNameErr))}
                          onChange={(e) => {
                            clearListingFieldError(bathNameKey);
                            clearListingFieldError("bathrooms");
                            setBath(i, { name: sanitizePlaceNameInput(e.target.value) });
                          }}
                          placeholder="Hall bathroom"
                        />
                        <StepFieldError msg={bathNameErr} />
                      </div>
                      <div className="sm:col-span-2">
                        <FieldLabel>Floor</FieldLabel>
                        <Select
                          aria-label={`Bathroom ${i + 1} floor`}
                          className={selectInputCls}
                          value={b.location ?? ""}
                          onChange={(e) => setBath(i, { location: e.target.value })}
                        >
                          <option value="">Select floor</option>
                          {floorLevelSelectOptions(sub.listingStoriesId, b.location ?? "").map((label) => (
                            <option key={label} value={label}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="sm:col-span-2">
                        <FieldLabel>Fixtures</FieldLabel>
                        <div className="mt-1 flex flex-wrap gap-x-6 gap-y-2">
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" className="h-4 w-4 rounded border-border" checked={b.shower} onChange={(e) => setBath(i, { shower: e.target.checked })} />
                            Shower
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" className="h-4 w-4 rounded border-border" checked={b.toilet} onChange={(e) => setBath(i, { toilet: e.target.checked })} />
                            Toilet
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" className="h-4 w-4 rounded border-border" checked={b.bathtub} onChange={(e) => setBath(i, { bathtub: e.target.checked })} />
                            Bathtub
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" className="h-4 w-4 rounded border-border" checked={b.sink} onChange={(e) => setBath(i, { sink: e.target.checked })} />
                            Sink
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" className="h-4 w-4 rounded border-border" checked={b.mirror} onChange={(e) => setBath(i, { mirror: e.target.checked })} />
                            Mirror
                          </label>
                        </div>
                      </div>
                      {sub.rooms.length > 0 ? (
                        <div className="sm:col-span-2">
                          <FieldLabel>Used by rooms</FieldLabel>
                          <div className="mt-1 grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                            <SelectAllCheckbox
                              allChecked={sub.rooms.every((room) => (b.assignedRoomIds ?? []).includes(room.id))}
                              someChecked={
                                (b.assignedRoomIds ?? []).length > 0 &&
                                !sub.rooms.every((room) => (b.assignedRoomIds ?? []).includes(room.id))
                              }
                              onToggle={(checkAll) =>
                                setBath(i, { assignedRoomIds: checkAll ? sub.rooms.map((room) => room.id) : [] })
                              }
                              label="All rooms"
                            />
                            {sub.rooms.map((room) => {
                              const checked = (b.assignedRoomIds ?? []).includes(room.id);
                              return (
                                <div key={`${b.id}-${room.id}`} className="min-w-0">
                                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                                    <input
                                      type="checkbox"
                                      className="h-4 w-4 shrink-0 rounded border-border"
                                      checked={checked}
                                      onChange={(e) => toggleBathroomRoom(i, room.id, e.target.checked)}
                                    />
                                    <span className="truncate font-medium text-foreground">{room.name.trim() || `Room (${room.id.slice(-6)})`}</span>
                                  </label>
                                  {checked ? (
                                    <Select
                                      aria-label={`Bathroom situation for ${room.name.trim() || "room"}`}
                                      className={`${selectInputCls} mt-1 h-8 text-xs`}
                                      value={b.accessKindByRoomId?.[room.id] ?? ""}
                                      onChange={(e) =>
                                        setBathRoomAccessKind(i, room.id, e.target.value as "" | ManagerBathroomRoomAccessKind)
                                      }
                                    >
                                      <option value="">Auto</option>
                                      <option value="ensuite">En suite</option>
                                      <option value="shared">Shared</option>
                                      <option value="hall">Hall</option>
                                    </Select>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                      <div className="sm:col-span-2">
                        <FieldLabel>Bathroom amenities</FieldLabel>
                        <PresetCheckboxGroup
                          key={`bath-amenities-${b.id}`}
                          presets={dedupedPresets.bathroom}
                          value={b.amenitiesText ?? ""}
                          onChange={(v) => setBath(i, { amenitiesText: v })}
                          otherForcedOpen={otherAmenitiesOpenRooms.has(`bath-${b.id}`)}
                          onOtherForcedOpenChange={(open) => toggleOtherAmenitiesOpen(`bath-${b.id}`, open)}
                          columns="sm:grid-cols-2"
                          otherPlaceholder="Other amenities, comma-separated"
                        />
                      </div>
                      <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
                      <div>
                        <FieldLabel hint="Up to 8 images, auto-compressed.">Photos</FieldLabel>
                        <div
                          className={`mt-2 ${mediaDropZoneClass(activeDropZone === `bath-photos-${b.id}`)}`}
                          onDragOver={(e) => handleDragOver(e, `bath-photos-${b.id}`)}
                          onDragEnter={(e) => handleDragOver(e, `bath-photos-${b.id}`)}
                          onDragLeave={(e) => handleDragLeave(e, `bath-photos-${b.id}`)}
                          onDrop={(e) => onDropBathroomPhotos(b.id, e)}
                        >
                          <MediaPickTrigger
                            accept="image/*"
                            multiple
                            onFiles={(files) => { void onPickBathroomPhotos(b.id, files); }}
                          >
                            Add photos
                          </MediaPickTrigger>
                          <p className="mt-2 text-xs text-muted">Drop photos here or use the button.</p>
                          {(b.photoDataUrls?.length ?? 0) > 0 ? (
                            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                              {b.photoDataUrls.map((src, pi) => (
                                <div key={`${b.id}-p-${pi}`} className="group relative overflow-hidden rounded-lg border border-border bg-accent/30">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={src} alt="Bathroom" className="h-28 w-full object-cover" />
                                  <button
                                    type="button"
                                    className="absolute right-1 top-1 rounded-full bg-card px-2 py-0.5 text-[11px] font-semibold text-rose-600 shadow-sm opacity-0 transition group-hover:opacity-100"
                                    onClick={() => removeBathroomPhoto(b.id, pi)}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div>
                        <FieldLabel hint="One short clip, ~14 MB max.">Video</FieldLabel>
                        <div
                          className={`mt-2 ${mediaDropZoneClass(activeDropZone === `bath-video-${b.id}`)}`}
                          onDragOver={(e) => handleDragOver(e, `bath-video-${b.id}`)}
                          onDragEnter={(e) => handleDragOver(e, `bath-video-${b.id}`)}
                          onDragLeave={(e) => handleDragLeave(e, `bath-video-${b.id}`)}
                          onDrop={(e) => onDropBathroomVideo(b.id, e)}
                        >
                          <MediaPickTrigger
                            accept="video/*"
                            disabled={videoUploadingKeys.has(`bath-${b.id}`)}
                            onFiles={(files) => { void onPickBathroomVideo(b.id, files?.[0] ?? null); }}
                          >
                            {videoUploadingKeys.has(`bath-${b.id}`) ? "Uploading…" : b.videoDataUrl ? "Replace video" : "Add video"}
                          </MediaPickTrigger>
                          {videoUploadingKeys.has(`bath-${b.id}`) ? (
                            <p className="mt-2 text-xs text-primary">Uploading…</p>
                          ) : (
                          <p className="mt-2 text-xs text-muted">Drop one video here or use the button.</p>
                          )}
                          {b.videoDataUrl ? (
                            <div className="mt-4 space-y-2">
                              <video
                                src={videoPreviewUrls[`bath-${b.id}`] ?? b.videoDataUrl}
                                controls
                                playsInline
                                className="max-h-52 w-full rounded-lg border border-border bg-black object-contain"
                              />
                              <button
                                type="button"
                                className="text-xs font-semibold text-rose-600 hover:underline"
                                onClick={() => clearBathroomVideo(b.id)}
                              >
                                Remove video
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      </div>
                  </ListingWizardCollapsibleCard>
                  );
                })}
                <ListingWizardListAddRow
                  label="Add bathroom"
                  ariaLabel="Add bathroom"
                  icon={Bath}
                  onClick={addBathroom}
                  disabled={sub.bathrooms.length >= 12}
                  dataAttr="listing-add-bathroom-blank"
                  inline={sub.bathrooms.length > 0}
                />
              </div>
          </FormSection>
          ) : null}

          {stepIndex === 3 ? (
          <FormSection
            id="edit-shared"
            title="Shared spaces"
            description="Name, location, and amenities for each shared area on the public listing."
          >
              <div className="mb-4 grid gap-2 sm:grid-cols-3">
                {SHARED_SPACE_TEMPLATES.map((template) => (
                  <button
                    key={template.label}
                    type="button"
                    data-attr={`listing-add-shared-${template.kind}`}
                    onClick={(e) => {
                      if (ignoreMultiClick(e)) return;
                      addSharedSpaceFromTemplate(template);
                    }}
                    onDoubleClick={(e) => e.preventDefault()}
                    disabled={sub.sharedSpaces.length >= 24}
                    className="touch-manipulation select-none rounded-xl border border-border bg-card px-3 py-3 text-center transition hover:border-primary/35 hover:bg-primary/[0.04] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="block text-xl leading-none" aria-hidden>
                      {SHARED_SPACE_KIND_ICONS[template.kind] ?? SHARED_SPACE_KIND_ICONS.other}
                    </span>
                    <span className="mt-1.5 block text-sm font-semibold text-foreground">{template.label}</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {template.amenities.slice(0, 2).join(" · ")}
                    </span>
                  </button>
                ))}
              </div>

              <div
                className={`space-y-3 ${wizardSectionErrorClass(Boolean(stepFieldErrors.sharedSpaces))}`}
                data-wizard-field="sharedSpaces"
              >
                {stepFieldErrors.sharedSpaces ? (
                  <p className="text-xs font-medium text-red-600">{stepFieldErrors.sharedSpaces}</p>
                ) : null}
                {sub.sharedSpaces.map((sp, i) => {
                    const spaceNameKey = listingSharedSpaceNameKey(sp.id);
                    const spaceNameErr = stepFieldErrors[spaceNameKey];
                    const spaceKind = normalizeSharedSpaceKind(sp.spaceKind, sp.name);
                    const kindPresets = sharedSpaceAmenityPresetsForKind(spaceKind, dedupedPresets.sharedSpace);
                    const spaceKindLabel =
                      SHARED_SPACE_KIND_OPTIONS.find((opt) => opt.id === spaceKind)?.label ?? "Shared space";

                    return (
                    <ListingWizardCollapsibleCard
                      key={sp.id}
                      expanded={isListingItemExpanded(listingItemKey("shared", sp.id))}
                      onToggle={() => toggleListingItem(listingItemKey("shared", sp.id))}
                      title={sp.name.trim() || `Shared space ${i + 1}`}
                      subtitle={`${spaceKindLabel} · ${roomAccessSummary(sp, sub.rooms)}`}
                      hasError={Boolean(spaceNameErr)}
                      bodyClassName="grid gap-4 sm:grid-cols-2"
                      toggleDataAttr={`listing-shared-toggle-${sp.id}`}
                      headerActions={
                        <>
                          <Button type="button" variant="outline" className={LISTING_WIZARD_REMOVE_BTN} onClick={() => removeSharedSpace(i)}>
                            Remove
                          </Button>
                        </>
                      }
                    >
                        <div data-wizard-field={spaceNameKey}>
                          <FieldLabel hint="Required only if you add this space.">Name</FieldLabel>
                          <Input
                            value={sp.name}
                            className={wizardFieldErrorClass(Boolean(spaceNameErr))}
                            onChange={(e) => {
                              clearListingFieldError(spaceNameKey);
                              clearListingFieldError("sharedSpaces");
                              setSharedSpace(i, { name: sanitizePlaceNameInput(e.target.value) });
                            }}
                            placeholder="e.g. Kitchen & dining, Laundry, Backyard"
                          />
                          <StepFieldError msg={spaceNameErr} />
                        </div>
                        <div>
                          <FieldLabel>Space type</FieldLabel>
                          <div className="relative">
                            <Select
                              aria-label={`Shared space ${i + 1} type`}
                              className={`${selectInputCls}`}
                              value={sp.spaceKind ?? "other"}
                              onChange={(e) => {
                                const kind = e.target.value as SharedSpaceKind;
                                setSharedSpace(i, {
                                  spaceKind: kind,
                                  amenitiesText: pruneSharedSpaceAmenitiesForKind(sp.amenitiesText ?? "", kind, dedupedPresets.sharedSpace),
                                });
                              }}
                            >
                              {SHARED_SPACE_KIND_OPTIONS.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.label}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel>Floor</FieldLabel>
                          <Select
                            aria-label={`Shared space ${i + 1} floor`}
                            className={selectInputCls}
                            value={sp.location ?? ""}
                            onChange={(e) => setSharedSpace(i, { location: e.target.value })}
                          >
                            <option value="">Select floor</option>
                            {floorLevelSelectOptions(sub.listingStoriesId, sp.location ?? "").map((label) => (
                              <option key={label} value={label}>
                                {label}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel>Amenities</FieldLabel>
                          <PresetCheckboxGroup
                            key={`space-amenities-${sp.id}`}
                            presets={kindPresets}
                            value={sp.amenitiesText ?? ""}
                            onChange={(v) => setSharedSpace(i, { amenitiesText: v })}
                            otherForcedOpen={otherAmenitiesOpenRooms.has(`space-${sp.id}`)}
                            onOtherForcedOpenChange={(open) => toggleOtherAmenitiesOpen(`space-${sp.id}`, open)}
                            otherPlaceholder="Other amenities, comma-separated"
                          />
                        </div>
                        <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
                        <div>
                          <FieldLabel hint="Up to 8 images.">Photos</FieldLabel>
                          <div
                            className={`mt-2 ${mediaDropZoneClass(activeDropZone === `shared-photos-${sp.id}`)}`}
                            onDragOver={(e) => handleDragOver(e, `shared-photos-${sp.id}`)}
                            onDragEnter={(e) => handleDragOver(e, `shared-photos-${sp.id}`)}
                            onDragLeave={(e) => handleDragLeave(e, `shared-photos-${sp.id}`)}
                            onDrop={(e) => onDropSharedSpacePhotos(sp.id, e)}
                          >
                            <MediaPickTrigger
                              accept="image/*"
                              multiple
                              onFiles={(files) => { void onPickSharedSpacePhotos(sp.id, files); }}
                            >
                              Add photos
                            </MediaPickTrigger>
                            <p className="mt-2 text-xs text-muted">Drop photos here or use the button.</p>
                            {(sp.photoDataUrls?.length ?? 0) > 0 ? (
                              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {sp.photoDataUrls.map((src, pi) => (
                                  <div key={`${sp.id}-p-${pi}`} className="group relative overflow-hidden rounded-lg border border-border bg-accent/30">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={src} alt="Shared space" className="h-28 w-full object-cover" />
                                    <button
                                      type="button"
                                      className="absolute right-1 top-1 rounded-full bg-card px-2 py-0.5 text-[11px] font-semibold text-rose-600 shadow-sm opacity-0 transition group-hover:opacity-100"
                                      onClick={() => removeSharedSpacePhoto(sp.id, pi)}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div>
                          <FieldLabel hint="One short clip, ~14 MB max.">Video</FieldLabel>
                          <div
                            className={`mt-2 ${mediaDropZoneClass(activeDropZone === `shared-video-${sp.id}`)}`}
                            onDragOver={(e) => handleDragOver(e, `shared-video-${sp.id}`)}
                            onDragEnter={(e) => handleDragOver(e, `shared-video-${sp.id}`)}
                            onDragLeave={(e) => handleDragLeave(e, `shared-video-${sp.id}`)}
                            onDrop={(e) => onDropSharedSpaceVideo(sp.id, e)}
                          >
                            <MediaPickTrigger
                              accept="video/*"
                              disabled={videoUploadingKeys.has(`space-${sp.id}`)}
                              onFiles={(files) => { void onPickSharedSpaceVideo(sp.id, files?.[0] ?? null); }}
                            >
                              {videoUploadingKeys.has(`space-${sp.id}`) ? "Uploading…" : sp.videoDataUrl ? "Replace video" : "Add video"}
                            </MediaPickTrigger>
                            {videoUploadingKeys.has(`space-${sp.id}`) ? (
                              <p className="mt-2 text-xs text-primary">Uploading…</p>
                            ) : (
                              <p className="mt-2 text-xs text-muted">Drop one video here or use the button.</p>
                            )}
                            {sp.videoDataUrl ? (
                              <div className="mt-4 space-y-2">
                                <video
                                  src={videoPreviewUrls[`space-${sp.id}`] ?? sp.videoDataUrl}
                                  controls
                                  playsInline
                                  className="max-h-52 w-full rounded-lg border border-border bg-black object-contain"
                                />
                                <button
                                  type="button"
                                  className="text-xs font-semibold text-rose-600 hover:underline"
                                  onClick={() => clearSharedSpaceVideo(sp.id)}
                                >
                                  Remove video
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel>Room access</FieldLabel>
                          <div className="mt-1 grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                            {sub.rooms.length > 0 ? (
                              <SelectAllCheckbox
                                allChecked={sub.rooms.every((room) => (sp.roomAccessIds ?? []).includes(room.id))}
                                someChecked={
                                  (sp.roomAccessIds ?? []).length > 0 &&
                                  !sub.rooms.every((room) => (sp.roomAccessIds ?? []).includes(room.id))
                                }
                                onToggle={(checkAll) => setSharedSpaceRoomAccess(i, checkAll ? "all" : "none")}
                                label="All rooms"
                              />
                            ) : null}
                            {sub.rooms.map((room) => (
                              <label key={`${sp.id}-acc-${room.id}`} className="flex cursor-pointer items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-border"
                                  checked={(sp.roomAccessIds ?? []).includes(room.id)}
                                  onChange={(e) => toggleSharedSpaceRoom(i, room.id, e.target.checked)}
                                />
                                <span className="font-medium text-foreground">{room.name.trim() || `Room (${room.id.slice(-6)})`}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                    </ListingWizardCollapsibleCard>
                  );
                  })}
                <ListingWizardListAddRow
                  label="Add shared space"
                  ariaLabel="Add a shared space"
                  icon={LayoutGrid}
                  onClick={addSharedSpace}
                  disabled={sub.sharedSpaces.length >= 24}
                  dataAttr="listing-add-shared-blank"
                  inline={sub.sharedSpaces.length > 0}
                />
              </div>
          </FormSection>
          ) : null}

          {/* ── Step 5: Highlights ── */}
          {stepIndex === 5 ? (
          <FormSection
            id="edit-highlights"
            title="Highlights & submit"
            description="Fine-tune the sidebar quick facts, then submit for review."
          >
            <div className="space-y-8">
              <ListingSubsection
                title="Quick facts (sidebar)"
                description="Optional. Rows here replace the auto-generated sidebar. Leave empty to use building, room count, floors, and pet policy from earlier steps."
              >
                <div className="space-y-3">
                  {(sub.quickFacts ?? []).map((qf, i) => (
                    <ListingWizardCollapsibleCard
                      key={qf.id}
                      expanded={isListingItemExpanded(listingItemKey("quickfact", qf.id))}
                      onToggle={() => toggleListingItem(listingItemKey("quickfact", qf.id))}
                      title={qf.label.trim() || `Quick fact ${i + 1}`}
                      subtitle={qf.value.trim() || "No value set"}
                      bodyClassName="grid gap-3 sm:grid-cols-2"
                      toggleDataAttr={`listing-quickfact-toggle-${qf.id}`}
                      headerActions={
                        <Button type="button" variant="outline" className={LISTING_WIZARD_REMOVE_BTN} onClick={() => removeQuickFact(i)}>
                          Remove
                        </Button>
                      }
                    >
                      <div>
                        <FieldLabel>Label</FieldLabel>
                        <Input value={qf.label} onChange={(e) => setQuickFact(i, { label: sanitizePlaceNameInput(e.target.value) })} placeholder="e.g. Neighborhood" />
                      </div>
                      <div>
                        <FieldLabel>Value</FieldLabel>
                        <Input value={qf.value} onChange={(e) => setQuickFact(i, { value: e.target.value })} placeholder="—" />
                      </div>
                    </ListingWizardCollapsibleCard>
                  ))}
                  <Button type="button" variant="outline" className={LISTING_WIZARD_ACTION_BTN} onClick={addQuickFact}>
                    + Add quick fact
                  </Button>
                </div>
              </ListingSubsection>

              <div className="border-t border-border pt-5">
                <p className="text-sm font-bold text-foreground">{isEditMode ? "Ready to submit changes?" : "Ready to submit this listing?"}</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  {isEditMode
                    ? "Review each step, then submit your changes when the listing is ready for review."
                    : isPreviewWizard
                      ? "Review each step, then save the preview when it reads the way you want."
                      : "Nothing is published until you click Submit listing below — then it goes live on Rent with PropLane right away. Your progress saves automatically to Drafts as you work."}
                </p>
              </div>
            </div>
          </FormSection>
          ) : null}
          </div>
        </div>

          <ModalAssistantStrip
            contextHint={listingAssistantContext}
            storageScopeKey={wizardTitlePrefix}
            triggerTarget={assistantTriggerTarget}
          />
        </div>

        <div className="modal-panel z-20 shrink-0 border-t border-border px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-5">
          <div className="w-full min-w-0">
          {draftSaveError ? (
            <p role="alert" data-testid="listing-wizard-draft-save-error" className="mb-3 text-xs font-medium text-red-600">
              {draftSaveError}
            </p>
          ) : (draftAutoSaveEligible || editAutoSaveEligible) && autosaveStatus !== "idle" ? (
            <p
              className="mb-3 text-xs text-muted"
              data-testid="listing-wizard-autosave-status"
              aria-live="polite"
            >
              {autosaveStatus === "saving"
                ? "Saving…"
                : autosaveStatus === "saved"
                  ? draftAutoSaveEligible
                    ? "Saved to Drafts"
                    : "Changes saved"
                  : autosaveStatus === "saved-without-photos"
                    ? draftAutoSaveEligible
                      ? "Saved to Drafts — photos not uploaded yet"
                      : "Changes saved — photos not uploaded yet"
                    : "Couldn't save — check your connection"}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {visibleStepPosition > 0 ? (
                <Button type="button" variant="outline" className="w-full min-h-[48px] sm:w-auto sm:min-w-[120px]" onClick={goPrev} disabled={busy}>
                  Back
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {!isFinalStep ? (
                <Button
                  type="button"
                  className="w-full min-h-[48px] sm:w-auto sm:min-w-[200px]"
                  data-attr="listing-wizard-continue"
                  onClick={goNext}
                  disabled={busy}
                >
                  {busy
                    ? "Saving…"
                    : visibleStepPosition === visibleStepCount - 2
                      ? isPreviewWizard
                        ? "Review & save →"
                        : "Review & submit →"
                      : "Continue"}
                </Button>
              ) : (
                <Button
                  type="button"
                  className="w-full min-h-[48px] sm:w-auto sm:min-w-[200px]"
                  data-attr="listing-wizard-submit"
                  onClick={() => submitListing()}
                  disabled={busy}
                >
                  {busy
                    ? isPreviewWizard
                      ? "Saving preview…"
                      : isEditMode
                        ? "Submitting changes…"
                        : "Submitting listing…"
                    : isPreviewWizard
                      ? "Save preview"
                      : isEditMode
                        ? "Submit changes"
                        : "Submit listing"}
                </Button>
              )}
            </div>
          </div>
          </div>
        </div>
      </div>
      </div>
      </div>
    </ModalShell>
  );
}
