import type { DemoApplicantRow } from "@/data/demo-portal";
import { resolveBundleFinancialTotals } from "@/lib/bundle-group/bundle-cost-split";
import {
  getBundleChoiceLabel,
  getPropertyById,
  getRoomChoiceLabel,
  getRoomOptionsForProperty,
  isEntireHomeProperty,
  isPropertyRentedByRoom,
  LISTING_ROOM_CHOICE_SEP,
  parseRoomChoiceValue,
} from "@/lib/rental-application/data";
import { resolvePlacementLeaseDates } from "@/lib/rental-application/lease-dates";
import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { listingPresetFeeAmount, resolvedShortTermPlacementDeposit } from "@/lib/listing-fees";
import { parseMoneyAmount } from "@/lib/parse-money";
import { utilitiesBillableMonthlyAmount } from "@/lib/listing-utilities-payment";
import { residentLeaseTermToApplicationFields } from "@/lib/resident-manual-lease-terms";
import { shortTermNightlyRate } from "@/lib/short-term-stay-pricing";

/**
 * Placement / dates / charges for a resident, auto-filled from the application and
 * the listing it references. Mirrors the resolution used by
 * `recordApprovedApplicationCharges` so the read-only manager view shows exactly the
 * amounts that will bill. Client-only: `getPropertyById` reads the manager's listing
 * catalog from local storage.
 */
export type ResolvedPlacementValues = {
  propertyId: string;
  propertyLabel: string;
  roomChoice: string;
  roomLabel: string;
  rentalType: "standard" | "short_term";
  leaseTerm: string;
  leaseStart: string;
  leaseEnd: string;
  signedMonthlyRent: number;
  utilities: number;
  securityDeposit: number;
  moveInFee: number;
  otherCostLabel: string;
  otherCostAmount: number;
  /** Critical field labels that could not be auto-filled from the application or its listing. */
  missing: string[];
};

type NormalizedSub = ReturnType<typeof normalizeManagerListingSubmissionV1>;

/** Mirrors `findRoomInSub` in household-charges so displayed values match billed values. */
function findRoom(sub: NormalizedSub, roomChoice: string, signedRent?: number | null) {
  const { listingRoomId } = parseRoomChoiceValue(roomChoice);
  if (listingRoomId) {
    const byId = sub.rooms.find((r) => r.id === listingRoomId);
    if (byId) return byId;
  }
  if (signedRent && signedRent > 0) {
    const byRent = sub.rooms.filter((r) => r.monthlyRent === signedRent);
    if (byRent.length === 1) return byRent[0]!;
  }
  if (sub.rooms.length === 1) return sub.rooms[0]!;
  return null;
}

export function resolvePlacementValuesForRow(
  row: Pick<
    DemoApplicantRow,
    "application" | "assignedPropertyId" | "assignedRoomChoice" | "propertyId" | "property" | "signedMonthlyRent"
  >,
): ResolvedPlacementValues {
  const app = row.application;
  const propertyId =
    row.assignedPropertyId?.trim() || row.propertyId?.trim() || app?.propertyId?.trim() || "";
  const roomChoice = row.assignedRoomChoice?.trim() || app?.roomChoice1?.trim() || "";

  const prop = getPropertyById(propertyId);
  const sub =
    prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  const room = sub ? findRoom(sub, roomChoice, row.signedMonthlyRent) : null;

  const dates = resolvePlacementLeaseDates({
    leaseTerm: app?.leaseTerm,
    leaseStart: app?.leaseStart,
    leaseEnd: app?.leaseEnd,
    rentalType: app?.rentalType,
  });
  const rentalType: "standard" | "short_term" = app?.rentalType === "short_term" ? "short_term" : "standard";

  // Rent: manager override → signed rent → listing room / entire-home rent.
  const rentOverride = parseMoneyAmount(app?.managerRentOverride ?? "");
  const signedRent = Number(row.signedMonthlyRent ?? 0);
  let signedMonthlyRent = rentOverride > 0 ? rentOverride : signedRent > 0 ? signedRent : 0;
  if (signedMonthlyRent <= 0 && sub) {
    if (isEntireHomeListing(sub)) signedMonthlyRent = entireHomeMonthlyRentAmount(sub);
    else if (room?.monthlyRent && room.monthlyRent > 0) signedMonthlyRent = room.monthlyRent;
  }

  const utilOverride = app?.managerUtilitiesOverride?.trim();
  const utilities = utilOverride
    ? parseMoneyAmount(utilOverride)
    : utilitiesBillableMonthlyAmount(sub ?? undefined, room);

  // Room-first precedence, identical to recordApprovedApplicationCharges — a room's own
  // deposit/move-in wins over the listing amount (a set "0" means the room genuinely has
  // none). This preview must show exactly what will bill, not the shared listing value.
  const roomSecurityDeposit = room?.securityDeposit?.trim() ? room.securityDeposit : undefined;
  const depOverride = app?.managerSecurityDepositOverride?.trim();
  const securityDeposit = depOverride
    ? parseMoneyAmount(depOverride)
    : roomSecurityDeposit != null
      ? parseMoneyAmount(roomSecurityDeposit)
      : sub
        ? listingPresetFeeAmount(sub, "security_deposit") || parseMoneyAmount(sub.securityDeposit ?? "")
        : 0;

  const roomMoveInFee = room?.moveInFee?.trim() ? room.moveInFee : undefined;
  const moveOverride = app?.managerMoveInFeeOverride?.trim();
  const moveInFee = moveOverride
    ? parseMoneyAmount(moveOverride)
    : roomMoveInFee != null
      ? parseMoneyAmount(roomMoveInFee)
      : sub
        ? listingPresetFeeAmount(sub, "move_in_fee") || parseMoneyAmount(sub.moveInFee ?? "")
        : 0;

  const otherCostLabel = app?.managerOtherCostLabel?.trim() || "";
  const otherCostAmount = parseMoneyAmount(app?.managerOtherCostAmount ?? "");

  const propertyLabel = prop?.title?.trim() || row.property?.trim() || "";
  const roomLabel = getRoomChoiceLabel(roomChoice) || "";

  const missing: string[] = [];
  if (!propertyId) missing.push("House");
  if (!roomChoice) missing.push("Room");
  if (!(signedMonthlyRent > 0)) missing.push("Signed monthly rent");
  if (!dates.leaseTerm) missing.push("Stay type");
  if (!dates.leaseStart) missing.push("Move-in date");
  if (dates.leaseTerm && dates.leaseTerm !== "Month-to-Month" && !dates.leaseEnd) missing.push("Lease end");

  return {
    propertyId,
    propertyLabel,
    roomChoice,
    roomLabel,
    rentalType,
    leaseTerm: dates.leaseTerm,
    leaseStart: dates.leaseStart,
    leaseEnd: dates.leaseEnd,
    signedMonthlyRent,
    utilities,
    securityDeposit,
    moveInFee,
    otherCostLabel,
    otherCostAmount,
    missing,
  };
}

export type ManualResidentPricing = {
  rentalType: "standard" | "short_term" | "airbnb";
  rent: string;
  utilities: string;
  moveInFee: string;
  securityDeposit: string;
};

function manualResidentMoneyField(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return "0";
  if (amount === 0) return "0";
  return amount % 1 === 0 ? String(amount) : amount.toFixed(2);
}

function resolveManualResidentRoom(sub: NormalizedSub, roomId: string) {
  const id = roomId.trim();
  if (id) {
    const byId = sub.rooms.find((r) => r.id === id);
    if (byId) return byId;
  }
  if (sub.rooms.length === 1) return sub.rooms[0]!;
  return null;
}

export type ManualResidentAssignment = {
  assignedRoomChoice?: string;
  bundleId?: string;
  placementLabel?: string;
};

/** Room choice + bundle for manual add/edit resident — mirrors the rental application wizard. */
export function resolveManualResidentAssignment(input: {
  propertyId: string;
  roomId: string;
  bundleId: string;
}): ManualResidentAssignment {
  const propertyId = input.propertyId.trim();
  if (!propertyId) return {};

  const bundleId = input.bundleId.trim();
  if (bundleId) {
    return {
      bundleId,
      placementLabel: getBundleChoiceLabel(propertyId, bundleId) || undefined,
    };
  }

  if (isEntireHomeProperty(propertyId)) {
    return { assignedRoomChoice: propertyId };
  }

  if (!isPropertyRentedByRoom(propertyId)) {
    const unitOpts = getRoomOptionsForProperty(propertyId, { includeUnavailable: true }).filter(
      (o) => o.value !== "",
    );
    const roomId = input.roomId.trim();
    const assignedRoomChoice =
      roomId.length > 0
        ? `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`
        : unitOpts.length <= 1
          ? (unitOpts[0]?.value ?? propertyId)
          : propertyId;
    const placementLabel = assignedRoomChoice
      ? getRoomChoiceLabel(assignedRoomChoice).split(" · ")[0]?.trim() || undefined
      : undefined;
    return { assignedRoomChoice, placementLabel };
  }

  const roomId = input.roomId.trim();
  if (!roomId) return {};
  const assignedRoomChoice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return {
    assignedRoomChoice,
    placementLabel: getRoomChoiceLabel(assignedRoomChoice).split(" · ")[0]?.trim() || undefined,
  };
}

/**
 * Pricing for the manual add-resident form from the property listing (and room when
 * selected). Mirrors `recordApprovedApplicationCharges` / placement preview precedence.
 */
export function resolveManualResidentPlacementValues(input: {
  propertyId: string;
  roomId: string;
  bundleId?: string;
  leaseTerm: string;
  leaseTermCustomMode: boolean;
}): ManualResidentPricing | null {
  const propertyId = input.propertyId.trim();
  const leaseTerm = input.leaseTerm.trim();
  if (!propertyId || !leaseTerm) return null;

  const prop = getPropertyById(propertyId);
  if (prop?.listingSubmission?.v !== 1) return null;
  const sub = normalizeManagerListingSubmissionV1(prop.listingSubmission);
  const room = resolveManualResidentRoom(sub, input.roomId);

  const appFields = residentLeaseTermToApplicationFields(leaseTerm, input.leaseTermCustomMode, propertyId);
  const rentalType = appFields.rentalType;

  if (rentalType === "airbnb") {
    return {
      rentalType,
      rent: "0",
      utilities: "0",
      moveInFee: "0",
      securityDeposit: "0",
    };
  }

  const bundleId = input.bundleId?.trim() ?? "";
  if (bundleId && rentalType !== "short_term") {
    const totals = resolveBundleFinancialTotals(sub, bundleId);
    if (totals) {
      return {
        rentalType,
        rent: manualResidentMoneyField(totals.monthlyRent),
        utilities: manualResidentMoneyField(totals.monthlyUtilities),
        moveInFee: manualResidentMoneyField(totals.moveInFee),
        securityDeposit: manualResidentMoneyField(totals.securityDeposit),
      };
    }
  }

  if (rentalType === "short_term") {
    const stRentRaw = (room?.shortTermRent ?? "").trim() || sub.shortTermDailyCost;
    const nightly = shortTermNightlyRate(stRentRaw);
    const securityDeposit = parseMoneyAmount(
      resolvedShortTermPlacementDeposit(sub, room),
    );
    const moveInFee =
      room?.shortTermMoveInFee?.trim()
        ? parseMoneyAmount(room.shortTermMoveInFee)
        : listingPresetFeeAmount(sub, "short_term_move_in") || parseMoneyAmount(sub.shortTermMoveInFee ?? "");
    return {
      rentalType,
      rent: manualResidentMoneyField(nightly),
      utilities: "0",
      moveInFee: manualResidentMoneyField(moveInFee),
      securityDeposit: manualResidentMoneyField(securityDeposit),
    };
  }

  let rent = 0;
  if (isEntireHomeListing(sub)) rent = entireHomeMonthlyRentAmount(sub);
  else if (room?.monthlyRent && room.monthlyRent > 0) rent = room.monthlyRent;

  const utilities = utilitiesBillableMonthlyAmount(sub, room ?? undefined);

  const roomSecurityDeposit = room?.securityDeposit?.trim() ? room.securityDeposit : undefined;
  const securityDeposit =
    roomSecurityDeposit != null
      ? parseMoneyAmount(roomSecurityDeposit)
      : listingPresetFeeAmount(sub, "security_deposit") || parseMoneyAmount(sub.securityDeposit ?? "");

  const roomMoveInFee = room?.moveInFee?.trim() ? room.moveInFee : undefined;
  const moveInFee =
    roomMoveInFee != null
      ? parseMoneyAmount(roomMoveInFee)
      : listingPresetFeeAmount(sub, "move_in_fee") || parseMoneyAmount(sub.moveInFee ?? "");

  return {
    rentalType,
    rent: manualResidentMoneyField(rent),
    utilities: manualResidentMoneyField(utilities),
    moveInFee: manualResidentMoneyField(moveInFee),
    securityDeposit: manualResidentMoneyField(securityDeposit),
  };
}
