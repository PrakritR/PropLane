"use client";

/**
 * "Add payment" — the one door for money going out. Three steps: Pay to · Payment · Review.
 *
 *  - A vendor with a PropLane login pays through the invoice flow: pick an approved invoice (the host
 *    opens its "Pay $x from <source>" step) or file a new bill. That path is one step; the invoice
 *    already carries the amount, category and property.
 *  - A teammate is recorded as an expense with the teammate as payee (PropLane moves no money to
 *    teammates).
 *  - Anyone else is a saved payee (mortgage lender, utility, insurer, tax office, HOA, owner...) with
 *    the details needed to pay them; a new payee is saved when the manager continues.
 *
 * The category follows the payee's type until the manager changes it. Plan: studio claude-2
 * `services-vendors-1004`, screen "Add payment".
 */

import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Textarea } from "@/components/ui/input";
import { SegmentedThree } from "@/components/ui/segmented-control";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WizardField, WizardLine, WizardRow, WizardSection, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import {
  collectLinkedPropertyIdsForModule,
  resolvePropertyLabelForId,
} from "@/lib/manager-portfolio-access";
import { readOwnActiveManagerVendorRows, syncManagerVendorsFromServer, MANAGER_VENDORS_EVENT } from "@/lib/manager-vendors-storage";
import { MANAGER_OUTGOING_PAYMENTS_EVENT, OUTGOING_PAYMENT_CATEGORY_CODES } from "@/lib/manager-outgoing-payments";
import {
  maskAccountReference,
  PAY_METHODS,
  PAY_METHOD_LABEL,
  PAYEE_TYPE_LABEL,
  payeeCategoryCode,
  payeeReferenceNoun,
  PICKABLE_PAYEE_TYPES,
  TEAMMATE_PAYMENT_REASONS,
  type ManagerPayee,
  type ManagerTeammate,
  type PayeeType,
  type PayMethod,
} from "@/lib/manager-payees";
import { fetchPayeeBook, savePayee, updatePayeeDetails } from "@/lib/manager-payees-client";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { isCategoryDeductible, SYSTEM_CHART_ACCOUNTS } from "@/lib/reports/categories";

function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

const CATEGORY_OPTIONS = OUTGOING_PAYMENT_CATEGORY_CODES.map((code) => {
  const account = SYSTEM_CHART_ACCOUNTS.find((row) => row.code === code);
  return { code, label: account?.name ?? code };
});

type PayKind = "vendor" | "teammate" | "other";
const NEW_PAYEE = "new";
const NEW_BILL = "new";

type VendorInvoiceChoice = {
  id: string;
  vendorUserId: string;
  vendorName: string;
  invoiceNumber?: string | null;
  serviceTitle?: string;
  totalCents: number;
};
type VendorServiceChoice = { id: string; title: string; vendorUserId: string };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** The fields a new payee is typed into. Saved as one `manager_payees` row. */
type NewPayeeFields = {
  name: string;
  type: PayeeType | "";
  account: string;
  method: PayMethod | "";
  phone: string;
  email: string;
  address: string;
  notes: string;
};
const EMPTY_PAYEE: NewPayeeFields = { name: "", type: "", account: "", method: "", phone: "", email: "", address: "", notes: "" };

export function ManagerAddOutgoingPaymentModal({
  open,
  onClose,
  managerUserId,
  onSubmitted,
  initialPropertyId,
  initialVendorId,
  initialMemo,
  onPayVendorInvoice,
  basePath = "/portal",
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string | null;
  onSubmitted: () => void;
  /** Prefill from a service record: its property, its vendor, and what the payment is for. */
  initialPropertyId?: string;
  initialVendorId?: string;
  initialMemo?: string;
  /** Opens the host's "Pay $x from <source>" step for an approved invoice. Without it the Outgoing page opens it. */
  onPayVendorInvoice?: (invoiceId: string) => void;
  basePath?: string;
}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [propertyTick, setPropertyTick] = useState(0);
  const [vendorTick, setVendorTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);

  // Pay to
  const [payKind, setPayKind] = useState<PayKind>("vendor");
  const [vendorKey, setVendorKey] = useState("");
  const [vendorFor, setVendorFor] = useState("");
  const [billServiceId, setBillServiceId] = useState("");
  const [billTitle, setBillTitle] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [teammateUserId, setTeammateUserId] = useState("");
  const [teammateReason, setTeammateReason] = useState<string>(TEAMMATE_PAYMENT_REASONS[0]);
  const [payeeChoice, setPayeeChoice] = useState("");
  const [newPayee, setNewPayee] = useState<NewPayeeFields>(EMPTY_PAYEE);
  // The payee row made on Continue, so going back and forward never saves a second copy.
  const [createdPayeeId, setCreatedPayeeId] = useState("");

  // Payment
  const [categoryCode, setCategoryCode] = useState<string>("other_expense");
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [propertyId, setPropertyId] = useState("");
  const [memo, setMemo] = useState("");

  // Server lists
  const [payees, setPayees] = useState<ManagerPayee[]>([]);
  const [teammates, setTeammates] = useState<ManagerTeammate[]>([]);
  const [invoices, setInvoices] = useState<VendorInvoiceChoice[]>([]);
  const [services, setServices] = useState<VendorServiceChoice[]>([]);
  const demo = isDemoModeActive();

  const loadBook = () => {
    if (demo) return;
    void fetchPayeeBook()
      .then((book) => {
        setPayees(book.payees);
        setTeammates(book.teammates);
      })
      .catch(() => {});
    void fetch("/api/manager/vendor-invoices?status=approved,scheduled&outgoing=1", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { invoices: [] }))
      .then((data: { invoices?: VendorInvoiceChoice[] }) => setInvoices((data.invoices ?? []).filter((row) => (row as { status?: string }).status !== "paid")))
      .catch(() => {});
    void fetch("/api/manager/vendor-invoices?choices=1", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { services: [] }))
      .then((data: { services?: VendorServiceChoice[] }) => setServices(data.services ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
    void syncManagerVendorsFromServer();
    loadBook();
    const onVendors = () => setVendorTick((n) => n + 1);
    const onProperties = () => setPropertyTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    return () => {
      window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const vendors = useMemo(() => {
    void vendorTick;
    return readOwnActiveManagerVendorRows(managerUserId);
  }, [vendorTick, managerUserId]);

  /** Vendor choices: roster rows by login (`u:<userId>`) or record (`r:<id>`), plus any invoiced vendor not on the roster. */
  const vendorOptions = useMemo(() => {
    const out = new Map<string, { label: string; userId: string | null; rosterId: string | null }>();
    for (const vendor of vendors) {
      const userId = vendor.vendorUserId?.trim() || null;
      out.set(userId ? `u:${userId}` : `r:${vendor.id}`, { label: vendor.name, userId, rosterId: vendor.id });
    }
    for (const invoice of invoices) {
      if (!out.has(`u:${invoice.vendorUserId}`)) out.set(`u:${invoice.vendorUserId}`, { label: invoice.vendorName, userId: invoice.vendorUserId, rosterId: null });
    }
    return [...out.entries()].map(([value, option]) => ({ value, ...option }));
  }, [vendors, invoices]);

  const initialKey = useRef("");
  useEffect(() => {
    if (!open) return;
    setPayKind(initialVendorId?.trim() ? "vendor" : "other");
    setVendorKey("");
    setVendorFor("");
    setBillServiceId("");
    setBillTitle("");
    setBillAmount("");
    setTeammateUserId("");
    setTeammateReason(TEAMMATE_PAYMENT_REASONS[0]);
    setPayeeChoice("");
    setNewPayee(EMPTY_PAYEE);
    setCreatedPayeeId("");
    setCategoryCode("other_expense");
    setCategoryTouched(false);
    setAmount("");
    setExpenseDate(new Date().toISOString().slice(0, 10));
    setMemo(initialMemo?.trim() ?? "");
    setPropertyId(initialPropertyId?.trim() ?? "");
    setStepIdx(0);
    setStepError(null);
    initialKey.current = initialVendorId?.trim() ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A service record names its vendor by roster id: resolve it to a vendor choice once the roster is read.
  useEffect(() => {
    if (!open || !initialKey.current || vendorKey) return;
    const match = vendorOptions.find((option) => option.rosterId === initialKey.current);
    if (match) setVendorKey(match.value);
  }, [open, vendorOptions, vendorKey]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    if (!managerUserId) return [];
    const seen = new Map<string, string>();
    for (const property of [...readExtraListingsForUser(managerUserId), ...readPendingManagerPropertiesForUser(managerUserId)]) {
      const id = property.id.trim();
      if (!id || seen.has(id)) continue;
      const label = displayPropertyLabel(
        property.buildingName.trim() || ("title" in property ? property.title : ""),
      );
      if (!label) continue;
      seen.set(id, label);
    }
    // Linked listings live in the OWNER's bucket, not this viewer's (AXI-156).
    for (const linkedId of collectLinkedPropertyIdsForModule(managerUserId, "payments")) {
      if (!linkedId || seen.has(linkedId)) continue;
      const label = displayPropertyLabel(resolvePropertyLabelForId(linkedId));
      if (!label) continue;
      seen.set(linkedId, label);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [managerUserId, propertyTick]);

  const vendor = vendorOptions.find((option) => option.value === vendorKey) ?? null;
  const vendorHasLogin = Boolean(vendor?.userId);
  /** A vendor with a login pays by invoice (one step); every other path adds an expense (three steps). */
  const invoicePath = payKind === "vendor" && vendorHasLogin;
  const vendorInvoices = invoices.filter((row) => row.vendorUserId === vendor?.userId);
  const vendorServices = services.filter((row) => row.vendorUserId === vendor?.userId);
  const newBill = vendorFor === NEW_BILL;

  const savedOther = payees.filter((row) => row.kind === "other");
  const chosenSaved = savedOther.find((row) => row.id === payeeChoice) ?? null;
  const teammate = teammates.find((row) => row.userId === teammateUserId) ?? null;
  const creatingPayee = payKind === "other" && payeeChoice === NEW_PAYEE;

  /** The payee as it will read on the Review step. */
  const payeeCard = (() => {
    if (payKind === "teammate") {
      return { name: teammate?.name ?? "", type: "Teammate", account: "", method: "", phone: teammate?.email ?? "", address: "", notes: "", accountNoun: "Account" };
    }
    if (payKind === "vendor") {
      return { name: vendor?.label ?? "", type: "Vendor", account: "", method: "", phone: "", address: "", notes: "", accountNoun: "Account" };
    }
    if (creatingPayee) {
      return {
        name: newPayee.name.trim(),
        type: newPayee.type ? PAYEE_TYPE_LABEL[newPayee.type] : "",
        account: newPayee.account,
        method: newPayee.method ? PAY_METHOD_LABEL[newPayee.method] : "",
        phone: [newPayee.phone.trim(), newPayee.email.trim()].filter(Boolean).join(" · "),
        address: newPayee.address.trim(),
        notes: newPayee.notes.trim(),
        accountNoun: payeeReferenceNoun(newPayee.type || null),
      };
    }
    if (chosenSaved) {
      return {
        name: chosenSaved.name,
        type: chosenSaved.payeeType ? PAYEE_TYPE_LABEL[chosenSaved.payeeType] : "",
        account: chosenSaved.accountReference ?? "",
        method: chosenSaved.payMethod ? PAY_METHOD_LABEL[chosenSaved.payMethod] : "",
        phone: [chosenSaved.phone, chosenSaved.email].filter(Boolean).join(" · "),
        address: chosenSaved.address ?? "",
        notes: chosenSaved.notes ?? "",
        accountNoun: payeeReferenceNoun(chosenSaved.payeeType),
      };
    }
    return { name: "", type: "", account: "", method: "", phone: "", address: "", notes: "", accountNoun: "Account" };
  })();

  /** The payee type that drives the category suggestion. */
  const savedType = chosenSaved?.payeeType ?? null;
  const suggestedCategory = useMemo(() => {
    if (payKind === "teammate") return payeeCategoryCode("teammate", null);
    if (payKind === "vendor") return "maintenance";
    const type = creatingPayee ? (newPayee.type || null) : savedType;
    return payeeCategoryCode("other", type);
  }, [payKind, creatingPayee, newPayee.type, savedType]);

  useEffect(() => {
    if (!open || categoryTouched) return;
    setCategoryCode(suggestedCategory);
  }, [open, categoryTouched, suggestedCategory]);

  function parsedAmountCents() {
    return Math.round(Number.parseFloat(amount.replace(/[^0-9.]/g, "")) * 100);
  }

  const payToIncomplete = (() => {
    if (payKind === "vendor") {
      if (!vendor) return true;
      if (!vendorHasLogin) return false;
      if (!vendorFor) return true;
      if (newBill) return !billServiceId || !billTitle.trim() || !/^\d+(?:\.\d{1,2})?$/.test(billAmount);
      return false;
    }
    if (payKind === "teammate") return !teammate;
    if (!payeeChoice) return true;
    return creatingPayee ? !newPayee.name.trim() || !newPayee.type : !chosenSaved;
  })();

  function paymentFields() {
    const amountCents = parsedAmountCents();
    if (!(amountCents > 0)) return "Enter a valid amount.";
    if (!expenseDate) return "Enter the date.";
    return null;
  }

  /** Save the new payee (once) or return the one already saved. */
  async function ensurePayeeId(): Promise<string> {
    if (payKind === "teammate") {
      const existing = payees.find((row) => row.kind === "teammate" && row.teammateUserId === teammateUserId);
      if (existing) return existing.id;
      const created = await savePayee({ kind: "teammate", teammateUserId, name: teammate?.name ?? "Teammate", payeeType: "management" });
      setPayees((rows) => [...rows, created]);
      return created.id;
    }
    if (!creatingPayee) return chosenSaved?.id ?? "";
    const body = {
      kind: "other",
      payeeType: newPayee.type,
      name: newPayee.name,
      accountReference: newPayee.account,
      payMethod: newPayee.method,
      phone: newPayee.phone,
      email: newPayee.email,
      address: newPayee.address,
      notes: newPayee.notes,
    };
    const saved = createdPayeeId ? await updatePayeeDetails(createdPayeeId, body) : await savePayee(body);
    setCreatedPayeeId(saved.id);
    setPayees((rows) => [...rows.filter((row) => row.id !== saved.id), saved]);
    return saved.id;
  }

  /** Continue on step 1 for "Someone else / New payee": save the payee, then walk to the next step. */
  async function savePayeeThenAdvance(target: number) {
    setSaving(true);
    try {
      if (isDemoModeActive()) {
        setStepIdx(target);
        return;
      }
      const id = await ensurePayeeId();
      setPayeeChoice(id);
      setCreatedPayeeId("");
      setStepIdx(target);
    } catch (error) {
      setStepError(error instanceof Error ? error.message : "Could not save payee.");
    } finally {
      setSaving(false);
    }
  }

  async function finishVendorInvoicePath() {
    if (!newBill) {
      const invoice = vendorInvoices.find((row) => row.id === vendorFor);
      if (!invoice) return;
      workspaceDraft.clear();
      onClose();
      if (onPayVendorInvoice) onPayVendorInvoice(invoice.id);
      else navigate(`${basePath}/outgoing/to-pay?payInvoice=${encodeURIComponent(invoice.id)}`);
      return;
    }
    if (isDemoModeActive()) {
      showToast("Bill created (demo).");
      workspaceDraft.clear();
      onSubmitted();
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/manager/vendor-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: crypto.randomUUID(), workOrderId: billServiceId, title: billTitle.trim(), amountCents: Math.round(Number(billAmount) * 100) }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setStepError(data.error ?? "Could not create bill.");
        return;
      }
      showToast("Bill created.");
      workspaceDraft.clear();
      window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT));
      onSubmitted();
      onClose();
    } catch {
      setStepError("Could not create bill.");
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (invoicePath) {
      await finishVendorInvoicePath();
      return;
    }
    const problem = paymentFields();
    if (problem) {
      setStepError(problem);
      setStepIdx(1);
      return;
    }
    setStepError(null);
    const amountCents = parsedAmountCents();
    if (isDemoModeActive()) {
      showToast("Payment saved (demo).");
      workspaceDraft.clear();
      onSubmitted();
      onClose();
      return;
    }
    setSaving(true);
    try {
      const payeeId = payKind === "vendor" ? "" : await ensurePayeeId();
      const memoText = payKind === "teammate" ? [teammateReason, memo.trim()].filter(Boolean).join(" · ") : memo.trim();
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryCode,
          amountCents,
          expenseDate,
          memo: memoText || undefined,
          vendorId: payKind === "vendor" ? vendor?.rosterId ?? undefined : undefined,
          payeeId: payeeId || undefined,
          propertyId: propertyId || undefined,
          taxDeductible: isCategoryDeductible(categoryCode),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not save payment.");
        return;
      }
      showToast("Payment saved.");
      workspaceDraft.clear();
      window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT));
      onSubmitted();
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not save payment.");
    } finally {
      setSaving(false);
    }
  }

  const workspaceDraft = useWorkspaceDraft({
    scope: `outgoing-payment${initialMemo ? `:${initialMemo}` : ""}`,
    actor: managerUserId,
    open,
    value: { payKind, vendorKey, vendorFor, billServiceId, billTitle, billAmount, teammateUserId, teammateReason, payeeChoice, newPayee, createdPayeeId, categoryCode, categoryTouched, amount, expenseDate, memo, propertyId, stepIdx },
    // An older draft (the category-first modal) lacks the new keys: fall back to the defaults.
    restore: (saved) => {
      setPayKind(saved.payKind ?? "other");
      setVendorKey(saved.vendorKey ?? "");
      setVendorFor(saved.vendorFor ?? "");
      setBillServiceId(saved.billServiceId ?? "");
      setBillTitle(saved.billTitle ?? "");
      setBillAmount(saved.billAmount ?? "");
      setTeammateUserId(saved.teammateUserId ?? "");
      setTeammateReason(saved.teammateReason ?? TEAMMATE_PAYMENT_REASONS[0]);
      setPayeeChoice(saved.payeeChoice ?? "");
      setNewPayee({ ...EMPTY_PAYEE, ...(saved.newPayee ?? {}) });
      setCreatedPayeeId(saved.createdPayeeId ?? "");
      setCategoryCode(saved.categoryCode ?? "other_expense");
      setCategoryTouched(saved.categoryTouched ?? false);
      setAmount(saved.amount ?? "");
      setExpenseDate(saved.expenseDate ?? new Date().toISOString().slice(0, 10));
      setMemo(saved.memo ?? "");
      setPropertyId(saved.propertyId ?? "");
      setStepIdx(saved.stepIdx ?? 0);
    },
  });

  if (!open) return null;

  const categoryLabel = CATEGORY_OPTIONS.find((option) => option.code === categoryCode)?.label ?? categoryCode;
  const propertyLabel = propertyOptions.find((option) => option.id === propertyId)?.label ?? "Portfolio";
  const amountCents = parsedAmountCents();
  const amountLabel = amountCents > 0 ? money(amountCents) : "Not set";
  const paymentIncomplete = !(amountCents > 0);
  const payToSummary = payeeCard.name || (payKind === "vendor" ? "Choose a vendor" : "Choose who");

  const steps: AddWorkspaceStep[] = invoicePath
    ? [{ id: "payto", label: "Pay to", summary: payToSummary, incomplete: payToIncomplete }]
    : [
        { id: "payto", label: "Pay to", summary: payToSummary, incomplete: payToIncomplete },
        { id: "payment", label: "Payment", summary: paymentIncomplete ? "Amount" : `${categoryLabel} · ${amountLabel}`, incomplete: paymentIncomplete },
        { id: "review", label: "Review", summary: "Ready" },
      ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  const lastLabel = invoicePath ? (newBill ? "Create bill" : "Continue") : "Add payment";

  const setNew = (patch: Partial<NewPayeeFields>) => setNewPayee((row) => ({ ...row, ...patch }));
  const accountNoun = payeeCard.accountNoun;

  return (
    <AddWorkspace
      title="Add payment"
      steps={steps}
      current={current}
      onJump={(index) => {
        setStepError(null);
        // Leaving "Pay to" with a new payee typed in saves it first (Continue), then walks on.
        if (stepId === "payto" && index > 0 && creatingPayee && !payToIncomplete && !saving) {
          void savePayeeThenAdvance(index);
          return;
        }
        setStepIdx(index);
      }}
      onClose={() => { workspaceDraft.preserve(); (onClose)(); }}
      keepsDraft
      onDiscardDraft={workspaceDraft.clear}
      dirty={Boolean(amount.trim() || memo.trim() || propertyId || vendorKey || teammateUserId || payeeChoice || newPayee.name.trim())}
      discardTitle="Discard this payment?"
      assistantContext="Add a payment to a vendor, a teammate, or someone else such as a mortgage lender or utility."
      assistantScopeKey="Add outgoing payment"
      lastLabel={lastLabel}
      lastDisabled={saving || (stepId === "payto" && payToIncomplete)}
      nextDisabled={stepId === "payto" && payToIncomplete}
      onBeforeNext={() => {
        if (stepId === "payto" && payToIncomplete) {
          setStepError("Choose who you are paying.");
          return false;
        }
        if (stepId === "payment") {
          const problem = paymentFields();
          if (problem) {
            setStepError(problem);
            return false;
          }
        }
        setStepError(null);
        return true;
      }}
      busy={saving}
      onFinish={() => void save()}
      dataAttrPrefix="outgoing-payment"
      finishDataAttr="outgoing-payment-save"
      footerNote={stepError ? <span className="text-sm text-rose-600">{stepError}</span> : null}
    >
      {stepId === "payto" ? (
        <StepColumn>
          <StepHeading title="Pay to" />
          <SegmentedThree<PayKind>
            value={payKind}
            onChange={(next) => {
              setPayKind(next);
              setStepError(null);
            }}
            first={{ id: "vendor", label: "A vendor" }}
            second={{ id: "teammate", label: "A teammate" }}
            third={{ id: "other", label: "Someone else" }}
            className="mb-4"
          />
          {payKind === "vendor" ? (
            <>
              <WizardSelect
                label="Vendor"
                required
                value={vendorKey}
                onChange={(next) => { setVendorKey(next); setVendorFor(""); }}
                placeholder="Choose vendor"
                options={vendorOptions.map((option) => ({ value: option.value, label: option.label }))}
                dataAttr="outgoing-payment-vendor"
              />
              {vendor && vendorHasLogin ? (
                <WizardSelect
                  label="For"
                  required
                  value={vendorFor}
                  onChange={setVendorFor}
                  placeholder="Choose what you are paying"
                  options={[
                    ...vendorInvoices.map((row) => ({
                      value: row.id,
                      label: ["Approved invoice", row.invoiceNumber, row.serviceTitle, money(row.totalCents)].filter(Boolean).join(" · "),
                    })),
                    { value: NEW_BILL, label: "New bill" },
                  ]}
                  dataAttr="outgoing-payment-for"
                />
              ) : null}
              {vendor && vendorHasLogin && newBill ? (
                <>
                  <WizardSelect
                    label="Service"
                    required
                    value={billServiceId}
                    onChange={setBillServiceId}
                    placeholder="Choose service"
                    options={vendorServices.map((row) => ({ value: row.id, label: row.title }))}
                    dataAttr="outgoing-payment-service"
                  />
                  <WizardField label="Description" required>
                    <Input value={billTitle} onChange={(event) => setBillTitle(event.target.value)} data-attr="outgoing-payment-bill-title" />
                  </WizardField>
                  <WizardField label="Amount" required>
                    <Input inputMode="decimal" value={billAmount} onChange={(event) => setBillAmount(event.target.value)} placeholder="185" data-attr="outgoing-payment-bill-amount" />
                  </WizardField>
                </>
              ) : null}
            </>
          ) : null}
          {payKind === "teammate" ? (
            <>
              <WizardSelect
                label="Teammate"
                required
                value={teammateUserId}
                onChange={setTeammateUserId}
                placeholder="Choose teammate"
                options={teammates.map((row) => ({ value: row.userId, label: row.roleLabel ? `${row.name} · ${row.roleLabel}` : row.name }))}
                dataAttr="outgoing-payment-teammate"
              />
              <WizardSelect
                label="For"
                value={teammateReason}
                onChange={setTeammateReason}
                options={TEAMMATE_PAYMENT_REASONS.map((reason) => ({ value: reason, label: reason }))}
                dataAttr="outgoing-payment-teammate-reason"
              />
            </>
          ) : null}
          {payKind === "other" ? (
            <>
              <WizardSelect
                label="Payee"
                required
                value={payeeChoice}
                onChange={(next) => { setPayeeChoice(next); if (next !== NEW_PAYEE) setCreatedPayeeId(""); }}
                placeholder="Choose payee"
                options={[
                  ...savedOther.map((row) => ({ value: row.id, label: row.payeeType ? `${row.name} · ${PAYEE_TYPE_LABEL[row.payeeType]}` : row.name })),
                  { value: NEW_PAYEE, label: "New payee" },
                ]}
                dataAttr="outgoing-payment-payee"
              />
              {creatingPayee ? (
                <>
                  <WizardField label="Name" required>
                    <Input value={newPayee.name} onChange={(event) => setNew({ name: event.target.value })} placeholder="Chase Home Lending" maxLength={120} data-attr="outgoing-payment-payee-name" />
                  </WizardField>
                  <WizardRow>
                    <WizardSelect
                      label="Type"
                      required
                      value={newPayee.type}
                      onChange={(next) => setNew({ type: next as PayeeType })}
                      placeholder="Choose type"
                      options={PICKABLE_PAYEE_TYPES.map((type) => ({ value: type, label: PAYEE_TYPE_LABEL[type] }))}
                      dataAttr="outgoing-payment-payee-type"
                    />
                    <WizardField label="Account / loan number">
                      <Input value={newPayee.account} onChange={(event) => setNew({ account: event.target.value })} maxLength={64} autoComplete="off" data-attr="outgoing-payment-payee-account" />
                    </WizardField>
                  </WizardRow>
                  <WizardRow>
                    <WizardSelect
                      label="How you pay them"
                      value={newPayee.method}
                      onChange={(next) => setNew({ method: next as PayMethod })}
                      placeholder="Choose how"
                      options={PAY_METHODS.map((method) => ({ value: method, label: PAY_METHOD_LABEL[method] }))}
                      dataAttr="outgoing-payment-payee-method"
                    />
                    <WizardField label="Phone">
                      <Input type="tel" value={newPayee.phone} onChange={(event) => setNew({ phone: event.target.value })} maxLength={40} data-attr="outgoing-payment-payee-phone" />
                    </WizardField>
                  </WizardRow>
                  <WizardField label="Email">
                    <Input type="email" value={newPayee.email} onChange={(event) => setNew({ email: event.target.value })} maxLength={254} data-attr="outgoing-payment-payee-email" />
                  </WizardField>
                  <WizardField label="Address">
                    <Input value={newPayee.address} onChange={(event) => setNew({ address: event.target.value })} maxLength={300} data-attr="outgoing-payment-payee-address" />
                  </WizardField>
                  <WizardField label="Notes">
                    <Textarea value={newPayee.notes} onChange={(event) => setNew({ notes: event.target.value })} placeholder="e.g. pay by the 1st, autopay off" maxLength={1000} data-attr="outgoing-payment-payee-notes" />
                  </WizardField>
                </>
              ) : null}
            </>
          ) : null}
        </StepColumn>
      ) : null}
      {stepId === "payment" ? (
        <StepColumn>
          <StepHeading title="Payment" />
          <WizardRow>
            <WizardSelect
              label="Category"
              value={categoryCode}
              onChange={(next) => { setCategoryCode(next); setCategoryTouched(true); }}
              options={CATEGORY_OPTIONS.map((option) => ({ value: option.code, label: option.label }))}
              dataAttr="outgoing-payment-category"
            />
            <WizardField label="Amount" required>
              <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="185" data-attr="outgoing-payment-amount" />
            </WizardField>
          </WizardRow>
          <WizardRow>
            <WizardField label="Paid on" required>
              <Input type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} data-attr="outgoing-payment-date" />
            </WizardField>
            <WizardSelect
              label="Property"
              value={propertyId}
              onChange={setPropertyId}
              options={[{ value: "", label: "Portfolio" }, ...propertyOptions.map((option) => ({ value: option.id, label: option.label }))]}
              dataAttr="outgoing-payment-property"
            />
          </WizardRow>
          <WizardField label="Memo">
            <Input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="October payment" data-attr="outgoing-payment-memo" />
          </WizardField>
        </StepColumn>
      ) : null}
      {stepId === "review" ? (
        <StepColumn>
          <StepHeading title="Review" />
          <WizardSection title="Payment" dataAttr="outgoing-payment-review">
            <WizardLine label="Pay to" control={<span className="font-bold">{payeeCard.name || "—"}</span>} />
            {payeeCard.type ? <WizardLine label="Type" control={<span>{payeeCard.type}</span>} /> : null}
            {payeeCard.account ? <WizardLine label={`${accountNoun === "Loan" ? "Account / loan" : "Account"}`} control={<span>{maskAccountReference(payeeCard.account)}</span>} /> : null}
            {payeeCard.method ? <WizardLine label="How you pay them" control={<span>{payeeCard.method}</span>} /> : null}
            {payeeCard.phone || payeeCard.address ? <WizardLine label="Contact" control={<span className="text-right">{[payeeCard.phone, payeeCard.address].filter(Boolean).join(" · ")}</span>} /> : null}
            {payeeCard.notes ? <WizardLine label="Notes" control={<span className="text-right">{payeeCard.notes}</span>} /> : null}
            <WizardLine label="Category" control={<span>{categoryLabel}</span>} />
            <WizardLine label="Amount" control={<span className="font-bold">{amountLabel}</span>} />
            <WizardLine label="Paid on" control={<span>{expenseDate}</span>} />
            <WizardLine label="Property" control={<span>{propertyLabel}</span>} />
            {payKind === "teammate" ? <WizardLine label="For" control={<span>{teammateReason}</span>} /> : null}
            {memo.trim() ? <WizardLine label="Memo" control={<span className="text-right">{memo.trim()}</span>} /> : null}
          </WizardSection>
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
