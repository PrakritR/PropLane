"use client";

import { useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  PreviewPanel,
  ReviewCard,
  WizardSection,
  WizardSelect,
  WIZARD_LABEL_CLASS,
} from "@/components/portal/add-workspace/parts";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { parseMoneyAmount } from "@/lib/household-charges";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { upsertWorkOrderBid } from "@/lib/work-order-bids-storage";
import { useAppUi } from "@/components/providers/app-ui-provider";

export type VendorAddDoor = "quote" | "invoice" | "visit";

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

export function VendorAddChooser({
  open,
  onPick,
  onClose,
}: {
  open: boolean;
  onPick: (door: VendorAddDoor) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title="Add" dataAttr="vendor-add-chooser">
      <div className="grid gap-2 p-1">
        <Button type="button" variant="outline" data-attr="vendor-add-quote" onClick={() => onPick("quote")}>
          Add quote
        </Button>
        <Button type="button" variant="outline" data-attr="vendor-add-invoice" onClick={() => onPick("invoice")}>
          Submit invoice
        </Button>
        <Button type="button" variant="outline" data-attr="vendor-add-visit" onClick={() => onPick("visit")}>
          Log visit
        </Button>
      </div>
    </Modal>
  );
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

  const job = jobs.find((row) => row.id === jobId) ?? null;

  const quoteSteps = useMemo((): AddWorkspaceStep[] => {
    if (door === "invoice") {
      return [
        { id: "job", label: "Job", incomplete: !job },
        { id: "quote", label: "Invoice", incomplete: !labor.trim() },
        { id: "review", label: "Review" },
      ];
    }
    if (door === "visit") {
      return [
        { id: "job", label: "Job", incomplete: !job },
        { id: "house", label: "House", incomplete: !job },
        { id: "when", label: "When", incomplete: !when.trim() },
        { id: "review", label: "Review" },
      ];
    }
    return [
      { id: "job", label: "Job", incomplete: !job },
      { id: "house", label: "House", incomplete: !job },
      { id: "when", label: "When", incomplete: !when.trim() },
      { id: "quote", label: "Quote", incomplete: !labor.trim() },
      { id: "review", label: "Review" },
    ];
  }, [door, job, labor, when]);

  const currentId = quoteSteps[step]?.id ?? "job";
  const title = door === "invoice" ? "Submit invoice" : door === "visit" ? "Log visit" : "Add quote";

  if (!open) return null;

  const resetAndClose = () => {
    setStep(0);
    setJobId("");
    setWhen("");
    setLabor("");
    setMaterials("");
    setNote("");
    setInvoiceNumber("");
    onClose();
  };

  const finish = async () => {
    if (!job) {
      showToast("Pick a job.");
      return;
    }
    setBusy(true);
    try {
      if (door === "invoice") {
        const amountCents = Math.round(parseMoneyAmount(labor) * 100);
        if (!Number.isFinite(amountCents) || amountCents <= 0) {
          showToast("Enter a valid amount.");
          return;
        }
        if (demo) {
          showToast("Invoice submitted.");
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
            workOrderId: job.id,
            memo: note.trim() || undefined,
            lineItems: [{ description: job.title, quantity: 1, unitAmountCents: amountCents }],
          }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not submit invoice.");
        showToast("Invoice submitted.");
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
      assistantContext="Helping a vendor quote or log a job visit."
      assistantScopeKey={`vendor-add-${door}`}
      lastLabel={door === "invoice" ? "Submit invoice" : door === "visit" ? "Log visit" : "Submit quote"}
      lastDisabled={!job}
      nextDisabled={currentId === "job" && !job}
      busy={busy}
      onFinish={() => void finish()}
      dataAttrPrefix="vendor-quote-wizard"
      sidePanel={
        <PreviewPanel
          title="Job preview"
          name={job?.title ?? "No job yet"}
          sub={job ? propertyLabel(job) : "Pick a job to continue"}
          facts={[
            { label: "House", value: job ? propertyLabel(job) : "Not set", warn: !job },
            { label: "When", value: when ? toDatetimeLocalValue(fromDatetimeLocalValue(when) ?? undefined) || when : "Not set", warn: door !== "invoice" && !when },
            { label: door === "invoice" ? "Invoice" : "Quote", value: labor.trim() ? `$${labor}` : "Not set", warn: door !== "visit" && !labor.trim() },
          ]}
          creates={[
            { tone: job ? "yes" : "warn", text: door === "invoice" ? "An invoice for the manager" : door === "visit" ? "A site visit on the calendar" : "A quote the manager can accept" },
          ]}
        />
      }
    >
      {currentId === "job" ? (
        <WizardSection title="The job">
          {jobOptions.length === 0 ? (
            <p className="text-sm font-semibold text-foreground">No jobs to quote yet.</p>
          ) : (
            <WizardSelect
              label="Job"
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
          <p className="text-sm font-semibold text-foreground">{job ? propertyLabel(job) : "Pick a job first"}</p>
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
            title="Job"
            status={job ? "complete" : "incomplete"}
            onEdit={() => setStep(0)}
            facts={[
              { label: "Title", value: job?.title ?? "Not set" },
              { label: "House", value: job ? propertyLabel(job) : "Not set" },
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
        </div>
      ) : null}
    </AddWorkspace>
  );
}
