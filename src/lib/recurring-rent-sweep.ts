/**
 * Pure decision logic for the monthly rent sweep: given active recurring rent
 * profiles, the charges that already exist and today, which charge rows are
 * missing for the current and next month. No IO, no browser state — the portal
 * hydrate path (household-charges.ts) and the daily cron
 * (/api/cron/sync-recurring-rent-charges) both call it, so they cannot drift.
 *
 * Invariants kept here: exactly-once via `chargeBusinessKey`; a month an
 * imported (`migrationSourceId`) row already covers is never billed again;
 * never before a profile's own start month; never after lease end.
 */
import {
  addMonthsToMonthKey,
  applyBundleGroupSplit,
  bundleSplitContextFromProfile,
  chargeBusinessKey,
  chargeKeyPart,
  currentRentMonth,
  effectiveDueDayForMonth,
  formatRecurringRentDueLabel,
  isStaleRecurringHouseholdCharge,
  moneyAmountLabel,
  monthKeyFromDate,
  monthsBetweenInclusive,
  recurringBasisMonthlyAddon,
  type HouseholdCharge,
  type RecurringRentProfile,
} from "@/lib/household-charges";
import { formatRoomPriceAmount, weeklyRentForBillableDays } from "@/lib/room-pricing";

export type RecurringRentSweepPlan = {
  newCharges: HouseholdCharge[];
  staleIds: Set<string>;
  /** `existing` minus the stale ids. */
  activeExisting: HouseholdCharge[];
};

export function planRecurringRentCharges(input: {
  profiles: RecurringRentProfile[];
  existing: HouseholdCharge[];
  now: Date;
}): RecurringRentSweepPlan {
  const { profiles, existing, now } = input;
  const newCharges: HouseholdCharge[] = [];

  const hasUpfrontProratedLastCharge = (
    residentEmail: string,
    propertyId: string,
    kind: "prorated_last_month_rent" | "prorated_last_month_utilities",
  ) => {
    const emailLower = residentEmail.trim().toLowerCase();
    return [...existing, ...newCharges].some(
      (c) => c.kind === kind && c.residentEmail.trim().toLowerCase() === emailLower && c.propertyId === propertyId,
    );
  };
  const hasUpfrontProratedLastFeeCharge = (residentEmail: string, propertyId: string, feeId: string) => {
    const emailLower = residentEmail.trim().toLowerCase();
    return [...existing, ...newCharges].some(
      (c) =>
        c.kind === "prorated_last_month_fee" &&
        c.customFeeId === feeId &&
        c.residentEmail.trim().toLowerCase() === emailLower &&
        c.propertyId === propertyId,
    );
  };

  // Build a map of profile id → profile for stale-charge cleanup
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const staleIds = new Set<string>();
  for (const c of existing) {
    if (isStaleRecurringHouseholdCharge(c, profileById, existing)) staleIds.add(c.id);
  }
  const activeExisting = staleIds.size > 0 ? existing.filter((c) => !staleIds.has(c.id)) : existing;

  for (const profile of profiles) {
    const dueDayMode = profile.dueDayMode ?? "first_of_month";
    const profileStartMonth = profile.startMonth?.trim() || currentRentMonth();

    // Parse lease end for last-month proration
    const leaseEndParts = profile.leaseEnd?.trim().split("-").map(Number) ?? [];
    const leaseEndYear = leaseEndParts[0] && Number.isFinite(leaseEndParts[0]) ? leaseEndParts[0] : null;
    const leaseEndMonthNum = leaseEndParts[1] && Number.isFinite(leaseEndParts[1]) ? leaseEndParts[1] : null;
    const leaseEndDay = leaseEndParts[2] && Number.isFinite(leaseEndParts[2]) ? leaseEndParts[2] : null;

    const currentMonth = monthKeyFromDate(now);
    const nextMonth = addMonthsToMonthKey(currentMonth, 1);
    const monthsToGenerate = new Set<string>(monthsBetweenInclusive(profileStartMonth, currentMonth));
    // Look one month ahead so next month's rent is visible early — but NEVER before the
    // profile's own start month. `startMonth` is deliberately the month AFTER move-in
    // (`firstRecurringMonthAfterLeaseStart`) because the move-in month is already billed by the
    // upfront first-month/prorated charges. Adding `nextMonth` unconditionally re-billed that
    // same month for any lease starting in the future, on top of the upfront charge.
    if (nextMonth >= profileStartMonth) monthsToGenerate.add(nextMonth);

    for (const rentMonth of [...monthsToGenerate].sort()) {
      const [candidateYear, candidateMonthNum] = rentMonth.split("-").map(Number);
      if (!candidateYear || !candidateMonthNum) continue;
      const dueDay = effectiveDueDayForMonth(profile.dueDay, dueDayMode, rentMonth);

      // Skip months after lease end
      if (leaseEndYear && leaseEndMonthNum) {
        const leaseEndMonth = `${leaseEndYear}-${String(leaseEndMonthNum).padStart(2, "0")}`;
        if (rentMonth > leaseEndMonth) continue;
      }

      const candidateDate = new Date(candidateYear, candidateMonthNum - 1, dueDay, 12, 0, 0, 0);
      const dueLabel = formatRecurringRentDueLabel(rentMonth, dueDay, dueDayMode);
      const monthLabel = candidateDate.toLocaleString("default", { month: "long", year: "numeric" });

      // Determine if this is a partial last month
      const isLastMonth = leaseEndYear !== null && leaseEndMonthNum !== null && leaseEndDay !== null
        && candidateYear === leaseEndYear && candidateMonthNum === leaseEndMonthNum;
      const daysInCandidateMonth = new Date(candidateYear, candidateMonthNum, 0).getDate();
      const isPartialLastMonth = isLastMonth && leaseEndDay! < daysInCandidateMonth;
      const proratedFactor = isPartialLastMonth ? leaseEndDay! / daysInCandidateMonth : 1;

      // When the last month is partial, recordApprovedApplicationCharges creates upfront prorated_last_month_rent
      // charges so residents can see them from approval time. Skip the recurring-generated version.
      const emailLower = profile.residentEmail.trim().toLowerCase();
      const hasUpfrontLastRent =
        isPartialLastMonth && hasUpfrontProratedLastCharge(profile.residentEmail, profile.propertyId, "prorated_last_month_rent");
      const hasUpfrontLastUtil =
        isPartialLastMonth && hasUpfrontProratedLastCharge(profile.residentEmail, profile.propertyId, "prorated_last_month_utilities");

      // A migrated month's imported row is all-in (rent + utilities combined), so a
      // migrated rent charge for this resident/property/month covers the generator for
      // BOTH rent and utilities that month. `chargeBusinessKey` deliberately makes a
      // migrated row's key unique per charge id, so it can never dedupe here — check
      // `migrationSourceId` directly against `activeExisting` instead.
      const hasMigratedRentMonth = activeExisting.some(
        (c) =>
          c.managerUserId === profile.managerUserId &&
          !!c.migrationSourceId &&
          c.kind === "rent" &&
          c.rentMonth === rentMonth &&
          c.propertyId === profile.propertyId &&
          c.residentEmail.trim().toLowerCase() === emailLower,
      );

      // Bundle-group members store the FULL household amounts on the profile, so
      // every amount below is divided the same way the move-in charges were.
      // Null for every ordinary profile, which leaves that path byte-identical.
      const splitCtx = bundleSplitContextFromProfile(profile);

      const profileDailyRate =
        typeof profile.dailyRentPrice === "number" && profile.dailyRentPrice > 0 ? profile.dailyRentPrice : 0;
      const profileWeeklyRate =
        typeof profile.weeklyRentPrice === "number" && profile.weeklyRentPrice > 0 ? profile.weeklyRentPrice : 0;
      if ((profile.monthlyRent > 0 || profileDailyRate > 0 || profileWeeklyRate > 0) && !hasUpfrontLastRent && !hasMigratedRentMonth) {
        const chargeKey = `rent|${emailLower}|${profile.propertyId}|${rentMonth}`;
        const alreadyExists =
          activeExisting.some((c) => chargeBusinessKey(c) === chargeKey) ||
          newCharges.some((c) => chargeBusinessKey(c) === chargeKey);
        if (!alreadyExists) {
          // Daily-priced rooms bill actual days-in-month × daily rate (partial last month
          // bills leaseEndDay × rate); monthly rooms keep the flat monthlyRent × factor.
          const daysBilled = isPartialLastMonth ? leaseEndDay! : daysInCandidateMonth;
          const monthlyAddon = recurringBasisMonthlyAddon(profile, proratedFactor);
          const householdAmount =
            profileDailyRate > 0
              ? Number((daysBilled * profileDailyRate).toFixed(2)) + monthlyAddon
              : profileWeeklyRate > 0
                ? weeklyRentForBillableDays(profileWeeklyRate, daysBilled) + monthlyAddon
                : Number((profile.monthlyRent * proratedFactor).toFixed(2));
          const rawTitlePrefix =
            profileDailyRate > 0
              ? `${isPartialLastMonth ? "Prorated rent" : "Rent"} (${daysBilled} days × ${formatRoomPriceAmount(profileDailyRate)}/day)`
              : profileWeeklyRate > 0
                ? `${isPartialLastMonth ? "Prorated rent" : "Rent"} (${Number((daysBilled / 7).toFixed(2))} weeks × ${formatRoomPriceAmount(profileWeeklyRate)}/week)`
                : isPartialLastMonth
                  ? "Prorated rent"
                  : "Rent";
          const rentSplit = applyBundleGroupSplit(householdAmount, rawTitlePrefix, splitCtx);
          const amount = rentSplit.amount;
          const titlePrefix = rentSplit.title;
          newCharges.push({
            ...(rentSplit.split ?? {}),
            id: `hc_rent_${chargeKeyPart(profile.residentEmail)}_${chargeKeyPart(profile.propertyId)}_${rentMonth}`,
            createdAt: new Date().toISOString(),
            residentEmail: profile.residentEmail,
            residentName: profile.residentName,
            residentUserId: profile.residentUserId,
            propertyId: profile.propertyId,
            propertyLabel: profile.propertyLabel,
            managerUserId: profile.managerUserId,
            kind: "rent",
            title: `${titlePrefix} — ${monthLabel}`,
            amountLabel: moneyAmountLabel(amount),
            balanceLabel: moneyAmountLabel(amount),
            status: "pending",
            recurringRentProfileId: profile.id,
            rentMonth,
            dueDay,
            dueDayMode,
            dueDateLabel: isPartialLastMonth
              ? `By ${new Date(leaseEndYear!, leaseEndMonthNum! - 1, leaseEndDay!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
              : dueLabel,
            blocksLeaseUntilPaid: false,
          });
        }
      }

      const utilAmt = profile.monthlyUtilities ?? 0;
      if (utilAmt > 0 && !hasUpfrontLastUtil && !hasMigratedRentMonth) {
        const utilKey = `utilities_recurring|${emailLower}|${profile.propertyId}|${rentMonth}`;
        const alreadyUtil =
          activeExisting.some((c) => chargeBusinessKey(c) === utilKey) ||
          newCharges.some((c) => chargeBusinessKey(c) === utilKey);
        if (!alreadyUtil) {
          const utilSplit = applyBundleGroupSplit(
            Number((utilAmt * proratedFactor).toFixed(2)),
            isPartialLastMonth ? "Prorated utilities" : "Utilities",
            splitCtx,
          );
          const amount = utilSplit.amount;
          const titlePrefix = utilSplit.title;
          newCharges.push({
            ...(utilSplit.split ?? {}),
            id: `hc_util_${chargeKeyPart(profile.residentEmail)}_${chargeKeyPart(profile.propertyId)}_${rentMonth}`,
            createdAt: new Date().toISOString(),
            residentEmail: profile.residentEmail,
            residentName: profile.residentName,
            residentUserId: profile.residentUserId,
            propertyId: profile.propertyId,
            propertyLabel: profile.propertyLabel,
            managerUserId: profile.managerUserId,
            kind: "utilities",
            title: `${titlePrefix} — ${monthLabel}`,
            amountLabel: moneyAmountLabel(amount),
            balanceLabel: moneyAmountLabel(amount),
            status: "pending",
            recurringRentProfileId: profile.id,
            rentMonth,
            dueDay,
            dueDayMode,
            dueDateLabel: isPartialLastMonth
              ? `By ${new Date(leaseEndYear!, leaseEndMonthNum! - 1, leaseEndDay!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
              : dueLabel,
            blocksLeaseUntilPaid: false,
          });
        }
      }

      // Monthly custom fees (parking, storage, …) bill their FULL amount each recurring
      // month — a flat monthly service, not prorated. Each fee's own business key
      // (custom_fee|…|feeId|month) makes emission exactly-once per month across repeated
      // syncs; an amount change only affects months not yet emitted.
      for (const fee of profile.monthlyFees ?? []) {
        if (!(fee.amount > 0)) continue;
        // A partial last month is billed up front by `prorated_last_month_fee` — never also
        // the flat month here.
        if (isPartialLastMonth && hasUpfrontProratedLastFeeCharge(profile.residentEmail, profile.propertyId, fee.id)) continue;
        const feeKey = `custom_fee|${emailLower}|${profile.propertyId}|${fee.id}|${rentMonth}`;
        const alreadyFee =
          activeExisting.some((c) => chargeBusinessKey(c) === feeKey) ||
          newCharges.some((c) => chargeBusinessKey(c) === feeKey);
        if (alreadyFee) continue;
        const feeSplit = applyBundleGroupSplit(fee.amount, fee.label, splitCtx);
        newCharges.push({
          ...(feeSplit.split ?? {}),
          id: `hc_cf_${chargeKeyPart(fee.id)}_${chargeKeyPart(profile.residentEmail)}_${chargeKeyPart(profile.propertyId)}_${rentMonth}`,
          createdAt: new Date().toISOString(),
          residentEmail: profile.residentEmail,
          residentName: profile.residentName,
          residentUserId: profile.residentUserId,
          propertyId: profile.propertyId,
          propertyLabel: profile.propertyLabel,
          managerUserId: profile.managerUserId,
          kind: "other_cost",
          customFeeId: fee.id,
          title: `${feeSplit.title} — ${monthLabel}`,
          amountLabel: moneyAmountLabel(feeSplit.amount),
          balanceLabel: moneyAmountLabel(feeSplit.amount),
          status: "pending",
          recurringRentProfileId: profile.id,
          rentMonth,
          dueDay,
          dueDayMode,
          dueDateLabel: dueLabel,
          blocksLeaseUntilPaid: false,
        });
      }
    }
  }
  return { newCharges, staleIds, activeExisting };
}

/** Residents with a placement and rent but no active profile for it (the pure core of auto-seeding). */
export function residentsMissingRentProfile<T extends { email: string; propertyId: string; monthlyRent: number }>(
  residents: T[],
  profiles: Pick<RecurringRentProfile, "residentEmail" | "propertyId" | "active">[],
): T[] {
  const keys = new Set(
    profiles.filter((p) => p.active).map((p) => `${p.residentEmail.trim().toLowerCase()}|${p.propertyId}`),
  );
  const seen = new Set<string>();
  return residents.filter((r) => {
    const email = r.email.trim().toLowerCase();
    if (!email || !Number.isFinite(r.monthlyRent) || r.monthlyRent <= 0) return false;
    const key = `${email}|${r.propertyId}`;
    if (keys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
