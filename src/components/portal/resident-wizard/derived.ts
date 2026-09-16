"use client";

/**
 * Everything the steps derive from the form and the listing catalog — room and
 * bundle options, lease-term presets, stay type, and the property's own
 * application questions. One hook so the steps and the side panel agree.
 */

import { useEffect, useMemo } from "react";
import { getBundleOptionsForProperty, getPropertyById, isEntireHomeProperty, isPropertyRentedByRoom } from "@/lib/rental-application/data";
import { normalizeCustomApplicationFields, normalizeManagerListingSubmissionV1, type ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import {
  applicationConfigForVariant,
  isWizardFormFieldEnabled,
  resolveListingApplicationFields,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";
import { computeLeaseEndDate, shouldAutoComputeLeaseEnd } from "@/lib/rental-application/lease-dates";
import { resolveManualResidentPlacementValues } from "@/lib/rental-application/placement-values";
import {
  isResidentMonthToMonthLease,
  residentLeaseTermOptionsForProperty,
  residentLeaseTermToApplicationFields,
} from "@/lib/resident-manual-lease-terms";
import type { AddPersonForm } from "./state";

export type RoomOption = { id: string; name: string; monthlyRent?: number; shortTermRent?: string | number };

export type ResidentWizardDerived = {
  roomOptions: RoomOption[];
  bundleOptions: { value: string; label: string }[];
  leaseTermOptions: { value: string; label: string }[];
  leaseTermPresetValues: string[];
  rentedByRoom: boolean;
  entireHome: boolean;
  showBundleSelect: boolean;
  showRoomSelect: boolean;
  rentalType: "standard" | "short_term" | "airbnb";
  isShortTerm: boolean;
  isAirbnb: boolean;
  isMonthToMonth: boolean;
  /** The listing's application config for the stay type the manager picked. */
  applicationConfig: ApplicationConfigSlice | null;
  customQuestions: ManagerCustomApplicationField[];
  fieldEnabled: (formKey: string) => boolean;
  /** "Room 2 · $875/mo listed" — what the listing says about the pick. */
  listingSays: string | null;
};

export function useResidentWizardDerived(
  form: AddPersonForm,
  propertyTick: number,
  patch: (next: Partial<AddPersonForm>) => void,
): ResidentWizardDerived {
  const { propertyId, roomId, bundleId, leaseTerm, leaseTermCustomMode } = form;

  const listing = useMemo(() => {
    void propertyTick;
    return propertyId ? getPropertyById(propertyId) : null;
  }, [propertyId, propertyTick]);

  const submission = useMemo(() => {
    if (!listing?.listingSubmission) return null;
    try {
      return normalizeManagerListingSubmissionV1(listing.listingSubmission);
    } catch {
      return null;
    }
  }, [listing]);

  const roomOptions = useMemo<RoomOption[]>(
    () =>
      submission?.rooms.map((r) => ({ id: r.id, name: r.name || r.id, monthlyRent: r.monthlyRent, shortTermRent: r.shortTermRent })) ?? [],
    [submission],
  );

  const leaseTermOptions = useMemo(() => {
    void propertyTick;
    return residentLeaseTermOptionsForProperty(propertyId);
  }, [propertyId, propertyTick]);
  const leaseTermPresetValues = useMemo(() => leaseTermOptions.map((o) => o.value), [leaseTermOptions]);

  const leaseFields = useMemo(
    () => residentLeaseTermToApplicationFields(leaseTerm, leaseTermCustomMode, propertyId),
    [leaseTerm, leaseTermCustomMode, propertyId],
  );
  const isShortTerm = leaseFields.rentalType === "short_term";
  const isAirbnb = leaseFields.rentalType === "airbnb";

  const rentedByRoom = useMemo(() => {
    void propertyTick;
    return Boolean(propertyId.trim() && isPropertyRentedByRoom(propertyId));
  }, [propertyId, propertyTick]);
  const entireHome = useMemo(() => {
    void propertyTick;
    return Boolean(propertyId.trim() && isEntireHomeProperty(propertyId));
  }, [propertyId, propertyTick]);
  const bundleOptions = useMemo(() => {
    void propertyTick;
    return propertyId.trim() ? getBundleOptionsForProperty(propertyId, { rentalType: isShortTerm ? "short_term" : "standard" }) : [];
  }, [propertyId, isShortTerm, propertyTick]);

  // The listing's application, for the stay type. Short-term and Airbnb use the
  // short-term form exactly as the public application does.
  const applicationConfig = useMemo<ApplicationConfigSlice | null>(() => {
    if (!submission) return null;
    return applicationConfigForVariant(submission, isShortTerm || isAirbnb ? "short_term" : "standard");
  }, [submission, isShortTerm, isAirbnb]);
  const customQuestions = useMemo(
    () =>
      applicationConfig
        ? resolveListingApplicationFields(applicationConfig, normalizeCustomApplicationFields).filter((f) => !f.isStandard)
        : [],
    [applicationConfig],
  );
  const fieldEnabled = useMemo(() => (formKey: string) => isWizardFormFieldEnabled(applicationConfig, formKey), [applicationConfig]);

  // Pricing defaults follow the placement — the same effect the old modal ran.
  useEffect(() => {
    if (!propertyId.trim() || !leaseTerm.trim()) return;
    const pricing = resolveManualResidentPlacementValues({ propertyId, roomId, bundleId, leaseTerm, leaseTermCustomMode });
    if (!pricing) return;
    patch({ rent: pricing.rent, utilities: pricing.utilities, moveInFee: pricing.moveInFee, securityDeposit: pricing.securityDeposit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, roomId, bundleId, leaseTerm, leaseTermCustomMode, propertyTick]);

  useEffect(() => {
    if (isShortTerm && form.utilities !== "0") patch({ utilities: "0" });
    if (isAirbnb && (form.rent !== "0" || form.utilities !== "0" || form.moveInFee !== "0" || form.securityDeposit !== "0")) {
      patch({ rent: "0", utilities: "0", moveInFee: "0", securityDeposit: "0" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isShortTerm, isAirbnb]);

  useEffect(() => {
    if (!bundleId.trim()) return;
    if (bundleOptions.some((o) => o.value === bundleId)) return;
    patch({ bundleId: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId, bundleOptions]);

  useEffect(() => {
    if (isShortTerm) return;
    const term = leaseFields.leaseTerm;
    if (!form.moveInDate.trim() || !shouldAutoComputeLeaseEnd(term, leaseFields.rentalType)) return;
    const end = computeLeaseEndDate(form.moveInDate, term);
    if (end && end !== form.moveOutDate) patch({ moveOutDate: end });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.moveInDate, leaseTerm, leaseTermCustomMode, leaseFields.leaseTerm, leaseFields.rentalType]);

  const isMonthToMonth = isResidentMonthToMonthLease(leaseTerm, propertyId);
  useEffect(() => {
    if (isMonthToMonth && form.moveOutDate) patch({ moveOutDate: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMonthToMonth]);

  const listingSays = useMemo(() => {
    if (!propertyId) return null;
    const room = roomOptions.find((r) => r.id === roomId);
    const parts: string[] = [];
    if (room) parts.push(`${room.name}${room.monthlyRent ? ` · $${room.monthlyRent}/mo listed` : ""}`);
    return parts.length ? parts.join(" · ") : null;
  }, [propertyId, roomId, roomOptions]);

  const showBundleSelect = bundleOptions.length > 0;
  const showRoomSelect = rentedByRoom && !bundleId.trim() && roomOptions.length > 0;

  return {
    roomOptions,
    bundleOptions,
    leaseTermOptions,
    leaseTermPresetValues,
    rentedByRoom,
    entireHome,
    showBundleSelect,
    showRoomSelect,
    rentalType: leaseFields.rentalType,
    isShortTerm,
    isAirbnb,
    isMonthToMonth,
    applicationConfig,
    customQuestions,
    fieldEnabled,
    listingSays,
  };
}
