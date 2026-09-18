"use client";

import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  PreviewPanel,
  ReviewCard,
  WizardSection,
  WizardSelect,
  WIZARD_LABEL_CLASS,
} from "@/components/portal/add-workspace/parts";
import { Input, Textarea } from "@/components/ui/input";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { parseMoneyAmount } from "@/lib/household-charges";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { upsertWorkOrderBid } from "@/lib/work-order-bids-storage";
import { useAppUi } from "@/components/providers/app-ui-provider";

export type VendorAddDoor = "quote" | "invoice" | "visit";

type LinkedManagerOption = { managerUserId: string; label: string };

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toDatetimeLocalValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromDatetimeLocalValue(s: string): string | null {
  if (!s.trim()) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function VendorQuoteWizard({
  open,
  door,
  jobs,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  door: VendorAddDoor;
  jobs: DemoManagerWorkOrderRow[];
  onClose: () => void;
  onSubmitted?: () => void;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [step, setStep] = useState(0);
  const [jobId, setJobId] = useState("");
  const [when, setWhen] = useState("");
  const [labor, setLabor] = useState("");
  const [materials, setMaterials] = useState("");
  const [note, setNote] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkedManagers, setLinkedManagers] = useState<LinkedManagerOption[]>([]);
  const [managerUserId, setManagerUserId] = useState("");
  const [billError, setBillError] = useState<string | null>(null);

  const job = jobs.find((row) => row.id === jobId) ?? null;
  const showManagerPicker = door === "invoice" && linkedManagers.length > 1;

  useEffect(() => {
    if (!open || door !== "invoice") return;
    let cancelled = false;
    void fetch("/api/vendor/invoices", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          linkedManagers?: LinkedManagerOption[];
          managers?: { managerUserId: string; name: string }[];
        };
        const next =
          body.linkedManagers ??
          (body.managers ?? []).map((manager) => ({
            managerUserId: manager.managerUserId,
            label: manager.name,
          }));
        if (!cancelled) setLinkedManagers(next);
      })
      .catch(() => {
        if (!cancelled) setLinkedManagers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [door, open]);

  useEffect(() => {
    if (linkedManagers.length === 1) {
      setManagerUserId(linkedManagers[0]!.managerUserId);
      return;
    }
    const ownerId = job?.managerUserId?.trim();
    if (ownerId && linkedManagers.some((manager) => manager.managerUserId === ownerId)) {
      setManagerUserId(ownerId);
    }
  }, [job, linkedManagers]);

  const quoteSteps = useMemo((): AddWorkspaceStep[] => {
    if (door === "invoice") {
      return [
        { id: "job", label: "Service", incomplete: false },
        { id: "quote", label: "Invoice", incomplete: !labor.trim() },
        { id: "review", label: "Review" },
      ];
    }
    if (door === "visit") {
      return [
        { id: "job", label: "Service", incomplete: !job },
        { id: "house", label: "House", incomplete: !job },
        { id: "when", label: "When", incomplete: !when.trim() },
        { id: "review", label: "Review" },
      ];
    }
    return [
      { id: "job", label: "Service", incomplete: !job },
      { id: "house", label: "House", incomplete: !job },
      { id: "when", label: "When", incomplete: !when.trim() },
      { id: "quote", label: "Quote", incomplete: !labor.trim() },
      { id: "review", label: "Review" },
    ];
  }, [door, job, labor, when]);

  const currentId = quoteSteps[step]?.id ?? "job";
  const title = door === "invoice" ? "Request payment" : door === "visit" ? "Log visit" : "Add quote";

  if (!open) return null;

  const resetAndClose = () => {
    setStep(0);
    setJobId("");
    setWhen("");
    setLabor("");
    setMaterials("");
    setNote("");
    setInvoiceNumber("");
    setManagerUserId("");
    setBillError(null);
    onClose();
  };

  const finish = async () => {
    if (door !== "invoice" && !job) {
      showToast("Pick a service.");
      return;
    }
    setBusy(true);
    setBillError(null);
    try {
      if (door === "invoice") {
        if (showManagerPicker && !managerUserId.trim()) {
          setBillError("Choose which manager to bill.");
          const invoiceStep = quoteSteps.findIndex((step) => step.id === "quote");
          if (invoiceStep >= 0) setStep(invoiceStep);
          setBusy(false);
          return;
        }
        const amountCents = Math.round(parseMoneyAmount(labor) * 100);
        if (!Number.isFinite(amountCents) || amountCents <= 0) {
          showToast("Enter a valid amount.");
          return;
        }
        if (demo) {
          showToast("Payment requested.");
          onSubmitted?.();
          resetAndClose();
          return;
        }
        const res = await fetch("/api/vendor/invoices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            invoiceNumber: invoiceNumber.trim() || undefined,
            workOrderId: job?.id,
            managerUserId: managerUserId.trim() || undefined,
            memo: note.trim() || undefined,
            lineItems: [{ description: job?.title || "Service", quantity: 1, unitAmountCents: amountCents }],
          }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not submit invoice.");
        showToast("Payment requested.");
        onSubmitted?.();
        resetAndClose();
        return;
      }

      const proposedTimeIso = fromDatetimeLocalValue(when);
      if (!proposedTimeIso) {
        showToast("Choose a date and time.");
        return;
      }

      if (door === "visit") {
        if (demo) {
          upsertWorkOrderBid({
            workOrderId: job.id,
            vendorUserId: "demo-vendor-1",
            vendorDirectoryId: job.vendorId ?? "demo-vendor-1",
            quoteMode: "after_consultation",
            amountCents: null,
            materialsCents: 0,
            proposedTime: null,
            consultationVisitAt: proposedTimeIso,
            note: note.trim() || null,
            status: "submitted",
          });
          showToast("Visit logged.");
          onSubmitted?.();
          resetAndClose();
          return;
        }
        const res = await fetch("/api/portal/work-order-bids", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            action: "schedule_consultation",
            workOrderId: job.id,
            consultationVisitAt: proposedTimeIso,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not log visit.");
        showToast("Visit logged.");
        onSubmitted?.();
        resetAndClose();
        return;
      }

      const amountCents = Math.round(parseMoneyAmount(labor) * 100);
      const materialsCents = materials.trim() ? Math.round(parseMoneyAmount(materials) * 100) : 0;
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        showToast("Enter a valid labor cost.");
        return;
      }
      if (demo) {
        upsertWorkOrderBid({
          workOrderId: job.id,
          vendorUserId: "demo-vendor-1",
          vendorDirectoryId: job.vendorId ?? "demo-vendor-1",
          quoteMode: "upfront",
          amountCents,
          materialsCents,
          proposedTime: proposedTimeIso,
          note: note.trim() || null,
          status: "submitted",
        });
        showToast("Quote submitted.");
        onSubmitted?.();
        resetAndClose();
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "submit",
          workOrderId: job.id,
          amountCents,
          materialsCents,
          proposedTime: proposedTimeIso,
          note,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not submit quote.");
      showToast("Quote submitted.");
      onSubmitted?.();
      resetAndClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const jobOptions = jobs.map((row) => ({
    value: row.id,
    label: `${row.title} · ${propertyLabel(row)}`,
  }));

  return (
    <AddWorkspace
      title={title}
      steps={quoteSteps}
      current={step}
      onJump={setStep}
      onClose={resetAndClose}
      dirty={Boolean(jobId || when || labor || materials || note)}
      discardTitle="Discard this?"
      discardBody="Nothing has been saved yet. Close and lose what you typed?"
      assistantContext="Helping a vendor quote or log a service visit."
      assistantScopeKey={`vendor-add-${door}`}
      lastLabel={door === "invoice" ? "Request payment" : door === "visit" ? "Log visit" : "Submit quote"}
      lastDisabled={door === "invoice" ? !labor.trim() : !job}
      nextDisabled={door !== "invoice" && currentId === "job" && !job}
      busy={busy}
      onFinish={() => void finish()}
      dataAttrPrefix="vendor-quote-wizard"
      finishDataAttr={door === "invoice" ? "vendor-invoice-submit" : undefined}
      sidePanel={
        <PreviewPanel
          title="Service preview"
          name={job?.title ?? (door === "invoice" ? "No service yet" : "No service yet")}
          sub={job ? propertyLabel(job) : door === "invoice" ? "No house" : "Pick a service"}
          facts={[
            { label: "House", value: job ? propertyLabel(job) : "Not set", warn: door !== "invoice" && !job },
            ...(door === "invoice"
              ? []
              : [{ label: "When", value: when ? toDatetimeLocalValue(fromDatetimeLocalValue(when) ?? undefined) || when : "Not set", warn: !when }]),
            { label: door === "invoice" ? "Invoice" : "Quote", value: labor.trim() ? `$${labor}` : "Not set", warn: door !== "visit" && !labor.trim() },
          ]}
          creates={[
            { tone: job || door === "invoice" ? "yes" : "warn", text: door === "invoice" ? "An invoice for the manager" : door === "visit" ? "A site visit on the calendar" : "A quote the manager can accept" },
          ]}
        />
      }
    >
      {currentId === "job" ? (
        <WizardSection title="The service">
          {jobOptions.length === 0 ? (
            <p className="text-sm font-semibold text-foreground">
              {door === "invoice" ? "No services yet." : "No services to quote yet."}
            </p>
          ) : (
            <WizardSelect
              label="Service"
              value={jobId}
              onChange={setJobId}
              options={jobOptions}
              dataAttr="vendor-quote-job"
            />
          )}
        </WizardSection>
      ) : null}
      {currentId === "house" ? (
        <WizardSection title="House">
          <p className="text-sm font-semibold text-foreground">{job ? propertyLabel(job) : "Pick a service first"}</p>
        </WizardSection>
      ) : null}
      {currentId === "when" ? (
        <WizardSection title="When">
          <label className={WIZARD_LABEL_CLASS} htmlFor="vendor-quote-when">
            Date and time
          </label>
          <Input
            id="vendor-quote-when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            data-attr="vendor-quote-when"
          />
        </WizardSection>
      ) : null}
      {currentId === "quote" ? (
        <WizardSection title={door === "invoice" ? "Invoice" : "Quote"}>
          {door === "invoice" ? (
            <>
              <label className={WIZARD_LABEL_CLASS} htmlFor="vendor-invoice-number">
                Invoice number
              </label>
              <Input
                id="vendor-invoice-number"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                data-attr="vendor-invoice-number"
              />
              {showManagerPicker ? (
                <div className="mt-3">
                  <WizardSelect
                    label="Bill to"
                    value={managerUserId}
                    onChange={(value) => {
                      setManagerUserId(value);
                      setBillError(null);
                    }}
                    options={linkedManagers.map((manager) => ({
                      value: manager.managerUserId,
                      label: manager.label,
                    }))}
                    dataAttr="vendor-invoice-manager"
                  />
                </div>
              ) : null}
              {billError ? <p className="mt-2 text-sm font-semibold text-danger">{billError}</p> : null}
            </>
          ) : null}
          <label className={`${WIZARD_LABEL_CLASS} ${door === "invoice" ? "mt-3" : ""}`} htmlFor="vendor-quote-labor">
            {door === "invoice" ? "Amount" : "Labor"}
          </label>
          <Input
            id="vendor-quote-labor"
            inputMode="decimal"
            value={labor}
            onChange={(e) => setLabor(e.target.value)}
            data-attr="vendor-quote-labor"
          />
          {door === "quote" ? (
            <>
              <label className={`${WIZARD_LABEL_CLASS} mt-3`} htmlFor="vendor-quote-materials">
                Materials
              </label>
              <Input
                id="vendor-quote-materials"
                inputMode="decimal"
                value={materials}
                onChange={(e) => setMaterials(e.target.value)}
                data-attr="vendor-quote-materials"
              />
            </>
          ) : null}
          <label className={`${WIZARD_LABEL_CLASS} mt-3`} htmlFor="vendor-quote-note">
            Note
          </label>
          <Textarea
            id="vendor-quote-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-attr="vendor-quote-note"
          />
        </WizardSection>
      ) : null}
      {currentId === "review" ? (
        <div>
          <ReviewCard
            title="Service"
            status={job ? "complete" : "incomplete"}
            onEdit={() => setStep(0)}
            facts={[
              { label: "Title", value: job?.title ?? (door === "invoice" ? "None" : "Not set") },
              { label: "House", value: job ? propertyLabel(job) : door === "invoice" ? "None" : "Not set" },
              ...(door === "invoice" && showManagerPicker
                ? [
                    {
                      label: "Bill to",
                      value: linkedManagers.find((manager) => manager.managerUserId === managerUserId)?.label ?? "Not set",
                    },
                  ]
                : []),
            ]}
          />
          {door !== "invoice" ? (
            <ReviewCard
              title="When"
              status={when ? "complete" : "incomplete"}
              onEdit={() => setStep(quoteSteps.findIndex((s) => s.id === "when"))}
              facts={[{ label: "Visit", value: when || "Not set" }]}
            />
          ) : null}
          {door !== "visit" ? (
            <ReviewCard
              title={door === "invoice" ? "Invoice" : "Quote"}
              status={labor.trim() ? "complete" : "incomplete"}
              onEdit={() => setStep(quoteSteps.findIndex((s) => s.id === "quote"))}
              facts={[
                { label: door === "invoice" ? "Amount" : "Labor", value: labor.trim() ? `$${labor}` : "Not set" },
                ...(door === "quote" ? [{ label: "Materials", value: materials.trim() ? `$${materials}` : "None" }] : []),
              ]}
            />
          ) : null}
          {billError ? <p className="mt-2 text-sm font-semibold text-danger">{billError}</p> : null}
        </div>
      ) : null}
    </AddWorkspace>
  );
}
