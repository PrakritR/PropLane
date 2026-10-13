"use client";

import { useMemo } from "react";
import { resolveManualResidentAssignment } from "@/lib/rental-application/placement-values";
import { resolveResidentOnboardingStage } from "@/lib/resident-onboarding/resolve-onboarding-stage";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import {
  type ResidentEditBaseline,
  type ResidentEditStage,
} from "@/lib/resident-edit-stage";
import type { ResidentWizardDerived } from "./derived";
import { alsoCreates, formatMoney, paymentSchedulePreview, type AddPersonForm } from "./state";

function moneyOr0(raw: string): number {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function ResidentSidePanel({
  form,
  derived,
  propertyLabel,
  mode = "person",
  editStage,
  editBaseline,
}: {
  form: AddPersonForm;
  derived: ResidentWizardDerived;
  propertyLabel: string | null;
  mode?: "person" | "tour" | "application" | "edit";
  editStage?: ResidentEditStage;
  editBaseline?: ResidentEditBaseline;
}) {
  const prospect = form.kind === "prospect" && mode !== "application";
  const rent = moneyOr0(form.rent);
  const stage = useMemo(() => {
    if (prospect) return null;
    const placement = form.propertyId ? resolveManualResidentAssignment({ propertyId: form.propertyId, roomId: form.roomId, bundleId: form.bundleId }) : null;
    const hasPdf = Boolean(form.leaseDataUrl.trim());
    return resolveResidentOnboardingStage({
      name: form.name,
      email: form.email,
      propertyId: form.propertyId,
      roomChoice: placement?.assignedRoomChoice,
      monthlyRent: rent || null,
      leaseFiling: hasPdf ? (form.leaseDocument === "draft" ? "draft" : form.leaseDocument === "signed" ? "signed" : "none") : "none",
    });
  }, [prospect, form.propertyId, form.roomId, form.bundleId, form.leaseDataUrl, form.leaseDocument, form.name, form.email, rent]);
  const rows = useMemo(() => (prospect || form.billingStart === "next_due" ? [] : paymentSchedulePreview(form)), [form, prospect]);
  const paid = rows.filter((r) => (form.paymentMarks[r.monthKey]?.status ?? (r.isCurrent ? "due" : "paid")) === "paid");
  const due = rows.filter((r) => !paid.includes(r));

  if (mode === "application") {
    return (
      <PreviewPanel
        title="Application preview"
        name={form.name.trim() || "New applicant"}
        sub={form.email.trim() || "email not set"}
        facts={[
          { label: "Property", value: propertyLabel ?? "Not set", warn: !propertyLabel },
          { label: "Lands in", value: "Application › Pending" },
          { label: "Fee", value: "None (manager-added)" },
          { label: "Screening", value: "Available once saved" },
        ]}
      />
    );
  }

  if (mode === "edit" && editStage && editBaseline) {
    const unpaid = due.reduce((n, r) => n + r.total, 0);
    return (
      <PreviewPanel
        title="Resident preview"
        name={form.name.trim() || "Resident"}
        sub={[form.email.trim(), form.phone.trim()].filter(Boolean).join(" · ") || "email not set"}
        facts={[
          { label: "Property", value: propertyLabel ?? "—" },
          { label: "Rent", value: rent ? `${formatMoney(rent)} / ${derived.isShortTerm ? "night" : "mo"}` : "—" },
          { label: "Move-in", value: form.moveInDate || "—" },
          { label: "Move-out", value: form.moveOutDate || "—" },
          { label: "Stage", value: editStage.replace(/_/g, " ") },
          { label: "Balance", value: unpaid ? formatMoney(unpaid) : formatMoney(0) },
        ]}
      />
    );
  }

  if (prospect) {
    return (
      <PreviewPanel
        title="Prospect preview"
        name={form.name.trim() || "New prospect"}
        sub={[form.email.trim(), form.phone.trim()].filter(Boolean).join(" · ") || "no contact yet"}
        facts={[
          { label: "Interested in", value: propertyLabel ? `${propertyLabel}${derived.listingSays ? ` · ${derived.listingSays.split(" · ")[0]}` : ""}` : "Not set", warn: !propertyLabel },
          { label: "Tour", value: form.tourFormat === "none" ? "None yet" : form.tourDate ? `${form.tourDate} ${form.tourStart}` : "Not set", warn: form.tourFormat !== "none" && !form.tourDate },
          { label: "Wants", value: [form.wantedMoveIn, form.budget ? `≤ $${form.budget}` : null].filter(Boolean).join(" · ") || "—" },
          { label: "Lands in", value: "Potential" },
        ]}
      />
    );
  }

  const wantLease = alsoCreates(form, "lease");
  return (
    <PreviewPanel
      title="Resident preview"
      name={form.name.trim() || "New resident"}
      sub={[form.email.trim() || "email not set", derived.listingSays?.split(" · ")[0]].filter(Boolean).join(" · ")}
      facts={[
        { label: "Property", value: propertyLabel ?? "Not set", warn: !propertyLabel },
        { label: "Rent", value: !wantLease || derived.isAirbnb ? "—" : rent ? `${formatMoney(rent)} / ${derived.isShortTerm ? "night" : "mo"}` : "Not set", warn: wantLease && !derived.isAirbnb && !rent },
        { label: "Move-in", value: wantLease ? form.moveInDate || "Not set" : "—", warn: wantLease && !form.moveInDate },
        { label: "Lands in", value: stage ? (stage.bucket === "approved" ? (form.leaseDocument === "signed" ? "Current" : "Current · lease pending") : "Potential") : "—" },
      ]}
    />
  );
}
