import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import {
  leaseIntakeFromApplication,
  mergeApplicationAutofillIntoLeaseApp,
} from "@/lib/leasing/lease-application-field-map";

export type ApplicationPersonalFields = Pick<
  RentalWizardFormState,
  "fullLegalName" | "email" | "phone" | "dateOfBirth"
>;

/** Resolve vital applicant identity fields from nested application answers and row-level fallbacks. */
export function resolveApplicationPersonalFields(
  row: Pick<DemoApplicantRow, "name" | "email" | "application">,
  fallback?: Partial<RentalWizardFormState>,
): ApplicationPersonalFields {
  const app = row.application;
  return {
    fullLegalName:
      app?.fullLegalName?.trim() ||
      row.name?.trim() ||
      fallback?.fullLegalName?.trim() ||
      "",
    email:
      app?.email?.trim() ||
      row.email?.trim() ||
      fallback?.email?.trim() ||
      "",
    phone: app?.phone?.trim() || fallback?.phone?.trim() || "",
    dateOfBirth: app?.dateOfBirth?.trim() || fallback?.dateOfBirth?.trim() || "",
  };
}

/**
 * Merge latest application answers into a lease snapshot.
 * Keeps amended lease dates from the pipeline row when they differ from the application record.
 * Shared identity/term/room fields flow through the allowlisted lease↔application map.
 */
export function enrichApplicationForLease(
  appRow: Pick<
    DemoApplicantRow,
    "name" | "email" | "application" | "assignedPropertyId" | "assignedRoomChoice" | "signedMonthlyRent"
  >,
  freshFromApplication: Partial<RentalWizardFormState> | undefined,
  existingLeaseApp?: Partial<RentalWizardFormState>,
): Partial<RentalWizardFormState> | undefined {
  if (!freshFromApplication && !existingLeaseApp) return undefined;
  if (!freshFromApplication) return existingLeaseApp;
  if (!existingLeaseApp) {
    const personal = resolveApplicationPersonalFields(appRow);
    return mergeApplicationAutofillIntoLeaseApp(
      { ...freshFromApplication, ...personal },
      freshFromApplication,
    );
  }

  const personal = resolveApplicationPersonalFields(appRow, existingLeaseApp);
  const amendedDates =
    Boolean(existingLeaseApp.leaseEnd?.trim()) && existingLeaseApp.leaseEnd !== freshFromApplication.leaseEnd;

  const mapped = mergeApplicationAutofillIntoLeaseApp(existingLeaseApp, {
    ...freshFromApplication,
    ...personal,
  });

  return {
    ...freshFromApplication,
    ...mapped,
    ...personal,
    leaseStart:
      amendedDates && existingLeaseApp.leaseStart?.trim()
        ? existingLeaseApp.leaseStart
        : freshFromApplication.leaseStart,
    leaseEnd:
      amendedDates && existingLeaseApp.leaseEnd?.trim()
        ? existingLeaseApp.leaseEnd
        : freshFromApplication.leaseEnd,
    leaseTerm:
      amendedDates && existingLeaseApp.leaseTerm?.trim()
        ? existingLeaseApp.leaseTerm
        : freshFromApplication.leaseTerm,
  };
}

/** Seed `leaseIntake` from an approved application when opening/generating a lease. */
export function leaseIntakeSeedFromApprovedApplication(
  application: Partial<RentalWizardFormState> | null | undefined,
): ReturnType<typeof leaseIntakeFromApplication> {
  return leaseIntakeFromApplication(application);
}
