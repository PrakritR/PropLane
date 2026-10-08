import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
type WorkspacePaymentPublic = {
  serviceFeePayer?: "resident" | "manager" | "proplane" | null;
};

export type PaymentSettingsField =
  | "serviceFeePayer"
  | "serviceFeeWaiverCode"
  | "rentDueDayMode"
  | "lateFeeEnabled"
  | "lateFeeAmount"
  | "lateFeeGraceDays";

export type PaymentSettingsScope = "workspace" | "own";

export type PropertyPaymentSettingsScope = Partial<Record<PaymentSettingsField, PaymentSettingsScope>>;

/** What the field holds when it is the workspace's, not this property's own. */
function workspaceValue(field: PaymentSettingsField, ws: WorkspacePaymentPublic | null | undefined): unknown {
  switch (field) {
    case "serviceFeePayer":
      return ws?.serviceFeePayer ?? "resident";
    // A workspace has no coverage code: one typed here is always this property's own.
    case "serviceFeeWaiverCode":
      return null;
    case "rentDueDayMode":
      return "first_of_month";
    case "lateFeeEnabled":
      return true;
    case "lateFeeAmount":
      return 50;
    case "lateFeeGraceDays":
      return 5;
  }
}

/** What the field holds on this property right now, in the same shape `workspaceValue` returns. */
function currentValue(sub: ManagerListingSubmissionV1, field: PaymentSettingsField): unknown {
  switch (field) {
    // What the row SHOWS when nothing is stored is "Resident pays", not the
    // workspace's answer, so that is what the scope is measured against.
    case "serviceFeePayer":
      return sub.serviceFeePayer ?? "resident";
    case "serviceFeeWaiverCode":
      return (sub.serviceFeeWaiverCode ?? "").trim() || null;
    case "rentDueDayMode":
      return sub.rentDueDayMode ?? "first_of_month";
    case "lateFeeEnabled":
      return sub.lateFeeEnabled !== false;
    case "lateFeeAmount": {
      const n = Number(String(sub.lateFeeAmount ?? "50").replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? n : 0;
    }
    case "lateFeeGraceDays":
      return sub.lateFeeGraceDays ?? 5;
  }
}

/**
 * Whether a payment row is still the workspace default or this property's own.
 *
 * A recorded scope wins (an edit stamps `own`, a reset clears the stamp); with
 * nothing recorded the answer is derived from the value itself, so a property
 * nobody has touched reads "Workspace default" and offers no reset.
 */
export function paymentSettingsFieldScope(
  sub: ManagerListingSubmissionV1,
  field: PaymentSettingsField,
  ws?: WorkspacePaymentPublic | null,
): PaymentSettingsScope {
  const explicit = sub.paymentSettingsScope?.[field];
  if (explicit === "own" || explicit === "workspace") return explicit;
  return currentValue(sub, field) === workspaceValue(field, ws) ? "workspace" : "own";
}

export function paymentSettingsScopeLabel(scope: PaymentSettingsScope): string {
  return scope === "workspace" ? "Workspace default" : "This property";
}

export function markPaymentFieldOwn(
  sub: ManagerListingSubmissionV1,
  field: PaymentSettingsField,
): ManagerListingSubmissionV1 {
  return {
    ...sub,
    paymentSettingsScope: { ...(sub.paymentSettingsScope ?? {}), [field]: "own" },
  };
}

export function resetPaymentFieldToWorkspace(
  sub: ManagerListingSubmissionV1,
  field: PaymentSettingsField,
  ws: WorkspacePaymentPublic | null | undefined,
): ManagerListingSubmissionV1 {
  const scope = { ...(sub.paymentSettingsScope ?? {}) };
  delete scope[field];
  const next: ManagerListingSubmissionV1 = { ...sub, paymentSettingsScope: scope };
  switch (field) {
    case "serviceFeePayer":
      return { ...next, serviceFeePayer: ws?.serviceFeePayer ?? "resident" };
    case "serviceFeeWaiverCode":
      return { ...next, serviceFeeWaiverCode: undefined };
    case "rentDueDayMode":
      return { ...next, rentDueDayMode: "first_of_month" };
    case "lateFeeEnabled":
      return { ...next, lateFeeEnabled: true };
    case "lateFeeAmount":
      return { ...next, lateFeeAmount: "50" };
    case "lateFeeGraceDays":
      return { ...next, lateFeeGraceDays: 5 };
  }
}

/**
 * Just the payment answers and their scope stamps, so a host can keep an
 * in-flight edit of THESE fields without carrying a whole stale submission
 * (rooms and prices included) back to the server on the next save.
 */
export function pickPaymentSettings(sub: ManagerListingSubmissionV1): Partial<ManagerListingSubmissionV1> {
  return {
    serviceFeePayer: sub.serviceFeePayer,
    serviceFeeWaiverCode: sub.serviceFeeWaiverCode,
    rentDueDayMode: sub.rentDueDayMode,
    lateFeeEnabled: sub.lateFeeEnabled,
    lateFeeAmount: sub.lateFeeAmount,
    lateFeeGraceDays: sub.lateFeeGraceDays,
    paymentSettingsScope: sub.paymentSettingsScope,
  };
}
