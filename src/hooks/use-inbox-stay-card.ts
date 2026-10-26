"use client";

import { useEffect, useMemo, useState } from "react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { useLeasePipelineRows } from "@/hooks/use-lease-pipeline-rows";
import {
  HOUSEHOLD_CHARGES_EVENT,
  householdChargeDueDate,
  isUnpaidHouseholdCharge,
  readHouseholdCharges,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import {
  deriveStayCard,
  stayCardLeaseFromRow,
  type StayCard,
  type StayCardApplication,
  type StayCardCharge,
  type StayCardLease,
  type StayCardViewer,
} from "@/lib/inbox-stay-card";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function homeLabelOf(raw: string | null | undefined): string {
  return String(raw ?? "").trim().split(" · ")[0]!.replace(/\s*·\s*[^·]*::[^·]*$/i, "").trim();
}

function roomLabelOf(choice: string | null | undefined): string {
  const value = String(choice ?? "").trim();
  return value ? (getRoomChoiceLabel(value).split(" · ")[0]?.trim() ?? "") : "";
}

/** The first REAL photo of a home (the listing's house photos, else a room's), or null. Never a stock image. */
function homePhotoFor(propertyId: string | null | undefined): string | null {
  const id = String(propertyId ?? "").trim();
  if (!id) return null;
  const submission = getPropertyById(id)?.listingSubmission;
  if (!submission || submission.v !== 1) return null;
  const sub = normalizeManagerListingSubmissionV1(submission);
  const house = (sub.housePhotoDataUrls ?? []).find((url) => url?.trim());
  if (house) return house;
  for (const room of sub.rooms) {
    const photo = (room.photoDataUrls ?? []).find((url) => url?.trim());
    if (photo) return photo;
  }
  return null;
}

/** Does a lease belong to the home this conversation names? No home named = every lease of the person. */
function matchesHome(unit: string, homeLabel: string | null | undefined): boolean {
  const home = norm(homeLabel);
  if (!home) return true;
  const label = norm(unit);
  return !label || label.includes(home) || home.includes(label);
}

/**
 * The stay card of the person a one-on-one conversation is with, derived on read from the stores the portal
 * already keeps (leases, approved applications, charges). Nothing is stored. `enabled` is false for a
 * conversation that is not with one person (team, assistant, house chat); the card is then always null.
 *
 * Manager: `personEmail` is the resident's address and `managerUserId` the signed-in manager.
 * Resident: `personEmail` is the viewer's own address and `homeLabel` the home the conversation names.
 */
export function useInboxStayCard(input: {
  viewer: StayCardViewer;
  enabled: boolean;
  managerUserId: string | null;
  personEmail: string | null | undefined;
  homeLabel?: string | null;
}): StayCard | null {
  const { viewer, enabled, managerUserId, personEmail, homeLabel } = input;
  const email = norm(personEmail);
  const active = enabled && email.includes("@") && (viewer === "resident" || Boolean(managerUserId));
  const { rows: leaseRows } = useLeasePipelineRows(viewer === "manager" ? managerUserId : null, { enabled: active });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const bump = () => {
      if (!cancelled) setTick((n) => n + 1);
    };
    void syncManagerApplicationsFromServer().then(bump).catch(() => undefined);
    void syncHouseholdChargesFromServer(false, { skipReconcile: viewer === "resident" }).then(bump).catch(() => undefined);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, bump);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    return () => {
      cancelled = true;
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, bump);
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    };
  }, [active, viewer]);

  return useMemo(() => {
    void tick;
    if (!active) return null;
    const leases = leaseRows
      .filter((row) => norm(row.residentEmail) === email && matchesHome(row.unit, homeLabel))
      .sort((a, b) => Date.parse(b.updatedAtIso || "") - Date.parse(a.updatedAtIso || ""))
      .map((row) => {
        const choice = row.roomChoice ?? row.application?.roomChoice1 ?? "";
        return stayCardLeaseFromRow(row, roomLabelOf(choice), homePhotoFor(row.propertyId));
      })
      .filter((lease): lease is StayCardLease => Boolean(lease));
    const applications: StayCardApplication[] = readManagerApplicationRows()
      .filter(
        (row: DemoApplicantRow) =>
          norm(row.email) === email &&
          row.bucket === "approved" &&
          !row.withdrawnAt &&
          (viewer === "resident" || applicationVisibleToPortalUser(row, managerUserId)) &&
          matchesHome(row.property ?? "", homeLabel),
      )
      .map((row) => ({
        id: String(row.id),
        homeLabel: homeLabelOf(row.property),
        roomLabel: roomLabelOf(row.assignedRoomChoice || row.application?.roomChoice1),
        approved: true,
        photoUrl: homePhotoFor(row.assignedPropertyId || row.propertyId || row.application?.propertyId),
      }));
    const charges: StayCardCharge[] = readHouseholdCharges()
      .filter((charge) => norm(charge.residentEmail) === email)
      .map((charge) => ({ unpaid: isUnpaidHouseholdCharge(charge), dueMs: householdChargeDueDate(charge)?.getTime() ?? null }));
    return deriveStayCard({ viewer, leases, applications, charges });
  }, [active, leaseRows, email, homeLabel, viewer, managerUserId, tick]);
}
