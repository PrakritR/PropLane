"use client";

import { useMemo } from "react";
import { resolveManualResidentAssignment } from "@/lib/rental-application/placement-values";
import { resolveResidentOnboardingStage } from "@/lib/resident-onboarding/resolve-onboarding-stage";
import { PreviewPanel, type CreatesItem } from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import { alsoCreates, formatMoney, monthKeyLabel, paymentSchedulePreview, type AddPersonForm } from "./state";

function moneyOr0(raw: string): number {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function ResidentSidePanel({
  form,
  derived,
  propertyLabel,
  mode = "person",
}: {
  form: AddPersonForm;
  derived: ResidentWizardDerived;
  propertyLabel: string | null;
  mode?: "person" | "tour" | "application";
}) {
  const prospect = form.kind === "prospect" && mode !== "application";
  const rent = moneyOr0(form.rent);
  const utilities = moneyOr0(form.utilities);
  const deposit = moneyOr0(form.securityDeposit);
  const moveInFee = moneyOr0(form.moveInFee);
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
  const quiet = form.message.channels.includes("none") || form.message.channels.length === 0 || (form.message.channels.length === 1 && form.message.channels[0] === "link");

  if (mode === "application") {
    const creates: CreatesItem[] = [
      { tone: "yes", text: "A pending application, started by you — no application fee" },
      { tone: "no", text: "No lease or charges until it is approved" },
      form.documents.length ? { tone: "yes", text: `${form.documents.length} ${form.documents.length === 1 ? "document" : "documents"} kept privately on the application` } : { tone: "no", text: "No documents attached" },
      quiet ? { tone: "no", text: "No message — it stays as you filled it" } : { tone: "warn", text: "Review-and-sign link previewed before it sends" },
    ];
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
        creates={creates}
      />
    );
  }

  if (prospect) {
    const creates: CreatesItem[] = [
      { tone: "yes", text: "A prospect row in Residents › Potential — no application yet, no fee" },
      form.tourFormat !== "none"
        ? { tone: form.tourDate && form.tourStart ? "yes" : "warn", text: form.tourDate && form.tourStart ? `A planned tour on Tours and your calendar, ${form.tourDate} at ${form.tourStart}` : "A planned tour once the date and time are set" }
        : { tone: "no", text: "No tour yet" },
      { tone: "no", text: "No lease, no charges, no documents" },
      quiet ? { tone: "no", text: "No message" } : { tone: "warn", text: "Confirmation previewed before it sends" },
    ];
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
        creates={creates}
      />
    );
  }

  const wantLease = alsoCreates(form, "lease");
  const wantPayments = alsoCreates(form, "payments");
  const wantDocs = alsoCreates(form, "documents");
  const leaseLine =
    form.leaseDocument === "signed"
      ? "A lease marked signed off-platform — resident only activates their account"
      : form.leaseDocument === "draft"
        ? "A draft lease filed for your review — resident signs it in PropLane before it is active"
        : "No lease yet — stays pending until you generate and send one";
  const creates: CreatesItem[] = [
    { tone: "yes", text: "An approved application, manually added — no application fee" },
    wantLease
      ? { tone: form.leaseDocument === "signed" ? "yes" : "warn", text: leaseLine }
      : { tone: "no", text: "No lease" },
  ];
  if (wantPayments) {
    creates.push(
      derived.isAirbnb
        ? { tone: "no", text: "Calendar-only stay — nothing billed" }
        : rent > 0 || utilities > 0
          ? { tone: "yes", text: `A recurring schedule: ${formatMoney(rent)} rent${utilities ? ` + ${formatMoney(utilities)} utilities` : ""} on the ${form.rentDueDay === "last" ? "last day" : form.rentDueDay === "15" ? "15th" : "1st"}${form.moveInDate ? `, from ${form.billingStart === "next_due" ? "the next due date" : form.moveInDate}` : ""}` }
          : { tone: "warn", text: "Rent not set — nothing recurs yet" },
      rows.length
        ? { tone: "yes", text: `${paid.map((r) => monthKeyLabel(r.monthKey).split(" ")[0]).join(" · ") || "No months"} recorded paid${due.length ? `; ${due.map((r) => monthKeyLabel(r.monthKey).split(" ")[0]).join(" · ")} open as due` : ""}` }
        : { tone: "no", text: form.billingStart === "next_due" ? "Nothing before the next due date" : "No past months to record" },
      deposit > 0 || moveInFee > 0
        ? { tone: "yes", text: `${deposit ? `Deposit ${formatMoney(deposit)} (${form.depositPaid ? "paid" : "due"})` : ""}${deposit && moveInFee ? " and " : ""}${moveInFee ? `move-in fee ${formatMoney(moveInFee)} (${form.moveInFeePaid ? "paid" : "due"})` : ""}` }
        : { tone: "no", text: "No one-time charges" },
    );
  } else {
    creates.push({ tone: "no", text: "No charges" });
  }
  creates.push(
    wantDocs && form.documents.length
      ? { tone: "yes", text: `${form.documents.length} ${form.documents.length === 1 ? "document" : "documents"} kept privately on their file` }
      : { tone: "no", text: "No documents attached" },
    quiet ? { tone: "no", text: "No message" } : { tone: "warn", text: "Message previewed before anything sends" },
  );
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
      creates={creates}
    />
  );
}
