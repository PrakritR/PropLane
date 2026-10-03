import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
type WorkspacePaymentPublic = {
  serviceFeePayer?: "resident" | "manager" | "proplane" | null;
};

export type PaymentSettingsField =
  | "serviceFeePayer"
  | "rentDueDayMode"
  | "lateFeeEnabled"
  | "lateFeeAmount"
  | "lateFeeGraceDays";

export type PaymentSettingsScope = "workspace" | "own";

export type PropertyPaymentSettingsScope = Partial<Record<PaymentSettingsField, PaymentSettingsScope>>;

const FIELDS: PaymentSettingsField[] = [
  "serviceFeePayer",
  "rentDueDayMode",
  "lateFeeEnabled",
  "lateFeeAmount",
  "lateFeeGraceDays",
];

export function paymentSettingsFieldScope(
  sub: ManagerListingSubmissionV1,
  field: PaymentSettingsField,
  ws?: WorkspacePaymentPublic | null,
): PaymentSettingsScope {
  const explicit = sub.paymentSettingsScope?.[field];
  if (explicit === "own" || explicit === "workspace") return explicit;
  if (field === "serviceFeePayer" && ws?.serviceFeePayer != null) {
    return sub.serviceFeePayer === ws.serviceFeePayer ? "workspace" : "own";
  }
  return "own";
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
  if (field === "serviceFeePayer" && ws?.serviceFeePayer) {
    return { ...next, serviceFeePayer: ws.serviceFeePayer };
  }
  if (field === "rentDueDayMode") {
    return { ...next, rentDueDayMode: "first_of_month" };
  }
  if (field === "lateFeeEnabled") {
    return { ...next, lateFeeEnabled: true };
  }
  if (field === "lateFeeAmount") {
    return { ...next, lateFeeAmount: "50" };
  }
  if (field === "lateFeeGraceDays") {
    return { ...next, lateFeeGraceDays: 5 };
  }
  return next;
}

export function propertyOverridesPaymentSettings(sub: ManagerListingSubmissionV1): boolean {
  const scope = sub.paymentSettingsScope ?? {};
  return FIELDS.some((f) => scope[f] === "own");
}
