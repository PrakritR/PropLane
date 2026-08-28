import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** How the applicant pays the application fee. `stripe` is a legacy alias for `ach`. */
export type ApplicationFeePayChannel = "ach" | "zelle" | "venmo" | "other" | "stripe";

export function listingApplicationFeeChannels(
  sub: ManagerListingSubmissionV1 | undefined,
  managerOther?: { enabled: boolean; instructions: string },
): {
  ach: boolean;
  /** @deprecated Use `ach` — kept for older saved form state. */
  stripe: boolean;
  zelle: boolean;
  venmo: boolean;
  other: boolean;
} {
  const ach = sub?.axisPaymentsEnabled !== false;
  const zelle = Boolean(sub?.zellePaymentsEnabled && sub?.zelleContact?.trim());
  const venmo = Boolean(sub?.venmoPaymentsEnabled && sub?.venmoContact?.trim());
  const listingOther = Boolean(
    sub?.applicationFeeOtherEnabled && sub?.applicationFeeOtherInstructions?.trim(),
  );
  const managerOtherActive = Boolean(
    managerOther?.enabled && managerOther.instructions.trim(),
  );
  const other = listingOther || managerOtherActive;
  return { ach, stripe: ach, zelle, venmo, other };
}

export function resolveApplicationFeeOtherInstructions(
  sub: ManagerListingSubmissionV1 | undefined,
  managerOther?: { enabled: boolean; instructions: string },
): string {
  const listing = sub?.applicationFeeOtherEnabled ? sub.applicationFeeOtherInstructions?.trim() ?? "" : "";
  if (listing) return listing;
  if (managerOther?.enabled) return managerOther.instructions.trim();
  return "";
}

export function resolveApplicationFeePayChannel(
  sub: ManagerListingSubmissionV1 | undefined,
  preference: ApplicationFeePayChannel | undefined,
  managerOther?: { enabled: boolean; instructions: string },
): ApplicationFeePayChannel {
  const channels = listingApplicationFeeChannels(sub, managerOther);
  const pref = preference === "stripe" ? "ach" : preference;
  if (pref === "ach" && channels.ach) return "ach";
  if (pref === "zelle" && channels.zelle) return "zelle";
  if (pref === "venmo" && channels.venmo) return "venmo";
  if (pref === "other" && channels.other) return "other";
  if (channels.ach) return "ach";
  if (channels.zelle) return "zelle";
  if (channels.venmo) return "venmo";
  if (channels.other) return "other";
  return "ach";
}

export function isAchApplicationFeeChannel(channel: ApplicationFeePayChannel): boolean {
  return channel === "ach" || channel === "stripe";
}
