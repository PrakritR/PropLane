import {
  normalizeManagerListingSubmissionV1,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

function matchByNameOrIndex<T extends { name: string }>(
  sourceItems: T[],
  targetName: string,
  index: number,
): T | undefined {
  const trimmed = targetName.trim().toLowerCase();
  if (trimmed) {
    const byName = sourceItems.find((item) => item.name.trim().toLowerCase() === trimmed);
    if (byName) return byName;
  }
  return sourceItems[index];
}

function mapRoomIdsByName(
  sourceIds: string[] | undefined,
  sourceRooms: ManagerRoomSubmission[],
  targetRooms: ManagerRoomSubmission[],
): string[] | undefined {
  if (!sourceIds?.length) return sourceIds;
  const mapped = sourceIds
    .map((sourceId) => {
      const sourceRoom = sourceRooms.find((room) => room.id === sourceId);
      if (!sourceRoom) return null;
      const byName = targetRooms.find(
        (room) => room.name.trim().toLowerCase() === sourceRoom.name.trim().toLowerCase(),
      );
      if (byName) return byName.id;
      const sourceIndex = sourceRooms.findIndex((room) => room.id === sourceId);
      return sourceIndex >= 0 ? targetRooms[sourceIndex]?.id ?? null : null;
    })
    .filter((id): id is string => Boolean(id));
  return mapped.length ? [...new Set(mapped)] : undefined;
}

function copyRoomPricingFields(
  target: ManagerRoomSubmission,
  source: ManagerRoomSubmission,
): ManagerRoomSubmission {
  return {
    ...target,
    monthlyRent: source.monthlyRent,
    shortTermRent: source.shortTermRent,
    shortTermMoveInFee: source.shortTermMoveInFee,
    shortTermDeposit: source.shortTermDeposit,
    securityDeposit: source.securityDeposit,
    moveInFee: source.moveInFee,
    utilitiesEstimate: source.utilitiesEstimate,
    utilitiesPaymentModel: source.utilitiesPaymentModel,
    prorateMethod: source.prorateMethod,
    dailyRentRate: source.dailyRentRate,
    dailyUtilitiesRate: source.dailyUtilitiesRate,
    rentBasis: source.rentBasis,
    dailyRentPrice: source.dailyRentPrice,
  };
}

function copyBundlePricingFields(
  target: ManagerBundleRow,
  source: ManagerBundleRow,
  sourceRooms: ManagerRoomSubmission[],
  targetRooms: ManagerRoomSubmission[],
): ManagerBundleRow {
  return {
    ...target,
    label: source.label,
    price: source.price,
    strikethrough: source.strikethrough,
    promo: source.promo,
    roomsLine: source.roomsLine,
    includedRoomIds: mapRoomIdsByName(source.includedRoomIds, sourceRooms, targetRooms) ?? target.includedRoomIds,
    shortTermEnabled: source.shortTermEnabled,
    shortTermNightlyRent: source.shortTermNightlyRent,
    shortTermMoveInFee: source.shortTermMoveInFee,
    shortTermDeposit: source.shortTermDeposit,
    securityDeposit: source.securityDeposit,
    moveInFee: source.moveInFee,
    utilitiesPaymentModel: source.utilitiesPaymentModel,
    utilitiesEstimate: source.utilitiesEstimate,
  };
}

export type ListingPricingCopySummary = {
  roomsUpdated: number;
  bundlesUpdated: number;
  bundlesAdded: number;
  copiedListingFees: boolean;
  copiedShortTermListingFees: boolean;
};

/**
 * Copy pricing configuration from one listing submission onto another without
 * changing media, move-in copy, room ids, or marketing text.
 */
export function copyListingPricingBetweenSubmissions(
  source: ManagerListingSubmissionV1,
  target: ManagerListingSubmissionV1,
): { submission: ManagerListingSubmissionV1; summary: ListingPricingCopySummary } {
  const src = normalizeManagerListingSubmissionV1(source);
  const next = normalizeManagerListingSubmissionV1(target);

  next.shortTermRentalsAllowed = src.shortTermRentalsAllowed;
  next.shortTermRequirements = src.shortTermRequirements;
  next.shortTermDailyCost = src.shortTermDailyCost;
  next.shortTermDeposit = src.shortTermDeposit;
  next.shortTermMoveInFee = src.shortTermMoveInFee;
  next.shortTermHoldingDeposit = src.shortTermHoldingDeposit;
  next.shortTermParkingMonthly = src.shortTermParkingMonthly;
  next.shortTermHoaMonthly = src.shortTermHoaMonthly;
  next.shortTermOtherMonthlyFees = src.shortTermOtherMonthlyFees;
  next.shortTermMonthToMonthSurcharge = src.shortTermMonthToMonthSurcharge;
  next.applicationFee = src.applicationFee;
  next.shortTermApplicationFee = src.shortTermApplicationFee;
  next.holdingDeposit = src.holdingDeposit;
  next.securityDeposit = src.securityDeposit;
  next.moveInFee = src.moveInFee;
  next.parkingMonthly = src.parkingMonthly;
  next.hoaMonthly = src.hoaMonthly;
  next.otherMonthlyFees = src.otherMonthlyFees;
  next.monthToMonthSurcharge = src.monthToMonthSurcharge;
  next.customLeaseSurcharge = src.customLeaseSurcharge;
  next.customFees = src.customFees?.map((fee) => ({ ...fee }));
  next.removedStandardListingFeeRows = src.removedStandardListingFeeRows
    ? [...src.removedStandardListingFeeRows]
    : undefined;
  next.paymentAtSigningIncludes = [...src.paymentAtSigningIncludes];
  next.houseCostsDetail = src.houseCostsDetail;

  next.entireHomeMonthlyRent = src.entireHomeMonthlyRent;
  next.entireHomeUtilitiesEstimate = src.entireHomeUtilitiesEstimate;
  next.entireHomeUtilitiesPaymentModel = src.entireHomeUtilitiesPaymentModel;
  next.entireHomeProrateMethod = src.entireHomeProrateMethod;
  next.entireHomeDailyRentRate = src.entireHomeDailyRentRate;
  next.entireHomeDailyUtilitiesRate = src.entireHomeDailyUtilitiesRate;

  let roomsUpdated = 0;
  next.rooms = next.rooms.map((room, index) => {
    const srcRoom = matchByNameOrIndex(src.rooms, room.name, index);
    if (!srcRoom) return room;
    roomsUpdated += 1;
    return copyRoomPricingFields(room, srcRoom);
  });

  const nextBundles = [...next.bundles];
  let bundlesUpdated = 0;
  let bundlesAdded = 0;
  for (let index = 0; index < src.bundles.length; index += 1) {
    const srcBundle = src.bundles[index]!;
    const byLabel = nextBundles.findIndex(
      (bundle) => bundle.label.trim().toLowerCase() === srcBundle.label.trim().toLowerCase(),
    );
    if (byLabel >= 0) {
      nextBundles[byLabel] = copyBundlePricingFields(
        nextBundles[byLabel]!,
        srcBundle,
        src.rooms,
        next.rooms,
      );
      bundlesUpdated += 1;
      continue;
    }
    if (index < nextBundles.length) {
      nextBundles[index] = copyBundlePricingFields(nextBundles[index]!, srcBundle, src.rooms, next.rooms);
      bundlesUpdated += 1;
      continue;
    }
    nextBundles.push(
      copyBundlePricingFields(
        {
          id: srcBundle.id,
          label: srcBundle.label,
          price: srcBundle.price,
          strikethrough: srcBundle.strikethrough,
          promo: srcBundle.promo,
          roomsLine: srcBundle.roomsLine,
        },
        srcBundle,
        src.rooms,
        next.rooms,
      ),
    );
    bundlesAdded += 1;
  }
  next.bundles = nextBundles;

  return {
    submission: normalizeManagerListingSubmissionV1(next),
    summary: {
      roomsUpdated,
      bundlesUpdated,
      bundlesAdded,
      copiedListingFees: true,
      copiedShortTermListingFees: true,
    },
  };
}

export function pricingFingerprint(sub: ManagerListingSubmissionV1 | null): string {
  if (!sub) return "no-submission";
  const roomBits = sub.rooms
    .map(
      (r) =>
        `${r.name}:m${r.monthlyRent}:st${r.shortTermRent ?? ""}:u${r.utilitiesEstimate}:d${r.dailyRentPrice ?? ""}`,
    )
    .join("|");
  const bundleBits = sub.bundles.map((b) => `${b.label}:${b.price}`).join("|");
  return [
    `app=${sub.applicationFee}`,
    `hold=${sub.holdingDeposit ?? ""}`,
    `mtm=${sub.monthToMonthSurcharge ?? ""}`,
    `cls=${sub.customLeaseSurcharge ?? ""}`,
    `fees=${sub.customFees?.length ?? 0}`,
    `rooms=[${roomBits}]`,
    `bundles=[${bundleBits}]`,
  ].join(" ");
}
