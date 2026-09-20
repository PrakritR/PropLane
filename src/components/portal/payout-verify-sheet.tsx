"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { AlertCircle, CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { StripeConnectEmbedded } from "@/components/stripe-connect-embedded";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

export type VerifyFieldType = "text" | "date" | "address" | "select" | "document" | "tel" | "email";

export type VerifyFieldSpec = {
  key: string;
  type: VerifyFieldType;
  label: string;
  sensitive?: boolean;
  options?: { value: string; label: string }[];
  requirementKeys: string[];
};

export type VerifyStatus = "verified" | "pending" | "needs_info" | "restricted";

export type VerifyRequirements = {
  status: VerifyStatus;
  fields: VerifyFieldSpec[];
  fallbackToEmbedded: boolean;
  currentlyDue: string[];
  disabledReason: string | null;
  isApplicationCollected: boolean;
};

const INDIVIDUAL_PREFIX = "individual.";
const COMPANY_PREFIX = "company.";
const ADDRESS_PARTS = ["line1", "line2", "city", "state", "postal_code"] as const;

function addressFromValues(values: Record<string, string>, prefix: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of ADDRESS_PARTS) {
    const v = values[`${prefix}.${part}`]?.trim();
    if (v) out[part] = v;
  }
  if (Object.keys(out).length === 0) return null;
  return { country: "US", ...out };
}

function statusMeta(status: VerifyStatus, fields: VerifyFieldSpec[]): { icon: ReactNode; label: string; tone: string } {
  if (status === "verified") {
    return { icon: <CheckCircle2 className="size-4" aria-hidden />, label: "Verified", tone: "text-success" };
  }
  if (status === "pending") {
    return { icon: <Clock className="size-4" aria-hidden />, label: "Pending review", tone: "text-muted" };
  }
  if (status === "restricted") {
    return { icon: <ShieldAlert className="size-4" aria-hidden />, label: "Restricted — contact support", tone: "text-danger" };
  }
  const names = fields.map((f) => f.label).join(", ");
  return {
    icon: <AlertCircle className="size-4" aria-hidden />,
    label: names ? `Needs: ${names}` : "Needs more information",
    tone: "text-danger",
  };
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: VerifyFieldSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === "select") {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-attr={`verify-field-${field.key}`}
        className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
      >
        <option value="" disabled>
          Select…
        </option>
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "date") {
    return (
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-attr={`verify-field-${field.key}`}
        className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
      />
    );
  }
  return (
    <input
      type={field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text"}
      inputMode={field.key.endsWith("ssn_last_4") ? "numeric" : undefined}
      maxLength={field.key.endsWith("ssn_last_4") ? 4 : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-attr={`verify-field-${field.key}`}
      className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
    />
  );
}

function AddressControl({
  prefix,
  values,
  onChange,
}: {
  prefix: string;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <input
        value={values[`${prefix}.line1`] ?? ""}
        onChange={(e) => onChange(`${prefix}.line1`, e.target.value)}
        placeholder="Street address"
        aria-label="Street address"
        data-attr={`verify-field-${prefix}-line1`}
        className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
      />
      <div className="grid grid-cols-3 gap-2">
        <input
          value={values[`${prefix}.city`] ?? ""}
          onChange={(e) => onChange(`${prefix}.city`, e.target.value)}
          placeholder="City"
          aria-label="City"
          data-attr={`verify-field-${prefix}-city`}
          className="col-span-1 min-w-0 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
        />
        <input
          value={values[`${prefix}.state`] ?? ""}
          onChange={(e) => onChange(`${prefix}.state`, e.target.value)}
          placeholder="State"
          aria-label="State"
          data-attr={`verify-field-${prefix}-state`}
          className="col-span-1 min-w-0 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
        />
        <input
          value={values[`${prefix}.postal_code`] ?? ""}
          onChange={(e) => onChange(`${prefix}.postal_code`, e.target.value)}
          placeholder="ZIP"
          aria-label="ZIP code"
          data-attr={`verify-field-${prefix}-postal-code`}
          className="col-span-1 min-w-0 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
        />
      </div>
    </div>
  );
}

/**
 * PropLane's own Verify-identity form, driven by whatever Stripe's
 * `requirements.currently_due` currently asks for (PLAN-0920-1500, Part C).
 * Legal name / DOB / address / phone / email / SSN / photo ID are collected
 * here, but SSN and ID number are tokenized in the browser
 * (`stripe.createToken('account'/'person', …)`) before Submit ever fires —
 * this component never sends those digits to PropLane's own server, only the
 * resulting token id.
 *
 * A legacy `stripe_dashboard.type: "express"` account, or any requirement key
 * this module does not know how to draw a field for, mounts Stripe's embedded
 * `account_onboarding` component in this same sheet instead (Decide 2 of the
 * plan) — never a half-drawn form.
 */
export function PayoutVerifySheet({
  open,
  onClose,
  connectBase,
  onVerified,
}: {
  open: boolean;
  onClose: () => void;
  /** `/api/stripe/connect` for a manager, `/api/vendor/stripe-connect` for a vendor. */
  connectBase: string;
  onVerified?: (status: VerifyStatus) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [requirements, setRequirements] = useState<VerifyRequirements | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [documentFileId, setDocumentFileId] = useState<string | null>(null);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${connectBase}/identity`, { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as Partial<VerifyRequirements> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not load identity requirements.");
      setRequirements(body as VerifyRequirements);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load identity requirements.");
    } finally {
      setLoading(false);
    }
  }, [connectBase]);

  useEffect(() => {
    if (!open) return;
    setValues({});
    setDocumentFileId(null);
    setError(null);
    void load();
  }, [open, load]);

  function setValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function uploadDocument(file: File) {
    setUploadingDocument(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${connectBase}/identity/document`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as { fileId?: string; error?: string };
      if (!res.ok || !body.fileId) throw new Error(body.error ?? "Could not upload document.");
      setDocumentFileId(body.fileId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload document.");
    } finally {
      setUploadingDocument(false);
    }
  }

  async function submit() {
    if (!requirements) return;
    setError(null);
    const stripe = await stripePromise;
    if (!stripe) {
      setError("Could not start Stripe.");
      return;
    }

    try {
      const plainFields: Record<string, string> = {};
      let accountToken: string | undefined;

      const businessTypeValue = values["business_type"];
      const companyFields = requirements.fields.filter((f) => f.key.startsWith(COMPANY_PREFIX));
      const individualFields = requirements.fields.filter((f) => f.key.startsWith(INDIVIDUAL_PREFIX));
      const isCompany = businessTypeValue === "company" || companyFields.some((f) => values[f.key]?.trim());

      if (isCompany && companyFields.length > 0) {
        const company: Record<string, unknown> = {};
        if (values["company.name"]?.trim()) company.name = values["company.name"].trim();
        if (values["company.phone"]?.trim()) company.phone = values["company.phone"].trim();
        if (values["company.tax_id"]?.trim()) company.tax_id = values["company.tax_id"].trim();
        const address = addressFromValues(values, "company.address");
        if (address) company.address = address;

        if (Object.keys(company).length > 0) {
          const { token, error: tokenError } = await stripe.createToken("account", {
            business_type: "company",
            company,
            tos_shown_and_accepted: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
          if (tokenError || !token) {
            setError(tokenError?.message ?? "Could not verify company details.");
            return;
          }
          accountToken = token.id;
        }
      } else if (individualFields.length > 0) {
        const individual: Record<string, unknown> = {};
        const legalName = values["individual.legal_name"]?.trim();
        if (legalName) {
          const [firstName, ...rest] = legalName.split(/\s+/);
          individual.first_name = firstName;
          if (rest.length > 0) individual.last_name = rest.join(" ");
        }
        const dob = values["individual.dob"];
        if (dob) {
          const [year, month, day] = dob.split("-").map((n) => Number.parseInt(n, 10));
          if (year && month && day) individual.dob = { year, month, day };
        }
        const address = addressFromValues(values, "individual.address");
        if (address) individual.address = address;
        if (values["individual.ssn_last_4"]?.trim()) individual.ssn_last_4 = values["individual.ssn_last_4"].trim();
        if (values["individual.id_number"]?.trim()) individual.id_number = values["individual.id_number"].trim();
        if (values["individual.phone"]?.trim()) individual.phone = values["individual.phone"].trim();
        if (values["individual.email"]?.trim()) individual.email = values["individual.email"].trim();

        if (Object.keys(individual).length > 0) {
          const { token, error: tokenError } = await stripe.createToken("account", {
            business_type: "individual",
            individual,
            tos_shown_and_accepted: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
          if (tokenError || !token) {
            setError(tokenError?.message ?? "Could not verify identity details.");
            return;
          }
          accountToken = token.id;
        }
      }

      if (businessTypeValue) plainFields.business_type = businessTypeValue;
      for (const field of requirements.fields) {
        if (field.sensitive) continue; // never leaves this component as a plain value
        if (field.key.startsWith(INDIVIDUAL_PREFIX) || field.key.startsWith(COMPANY_PREFIX)) continue; // bundled into the token above
        const value = values[field.key];
        if (value?.trim()) plainFields[field.key] = value.trim();
      }

      const res = await fetch(`${connectBase}/identity`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountToken,
          fields: Object.keys(plainFields).length > 0 ? plainFields : undefined,
          documents: documentFileId ? { front: documentFileId } : undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: VerifyStatus; error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not submit identity verification.");
        return;
      }
      onVerified?.(body.status ?? "pending");
      await load();
    } catch {
      setError("Could not submit identity verification.");
    }
  }

  const useEmbedded = requirements ? !requirements.isApplicationCollected || requirements.fallbackToEmbedded : false;
  const meta = requirements ? statusMeta(requirements.status, requirements.fields) : null;
  const needsDocument = requirements?.fields.some((f) => f.type === "document") ?? false;

  return (
    <Modal
      open={open}
      title="Verify identity"
      onClose={onClose}
      panelClassName="max-w-md"
      footer={
        !loading && requirements && !useEmbedded && requirements.status !== "verified" ? (
          <ModalFooter>
            <Button type="button" onClick={submit} disabled={uploadingDocument} data-attr="verify-submit">
              Submit
            </Button>
          </ModalFooter>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {loading ? <div role="status" aria-label="Loading" className="h-32 animate-pulse rounded-xl bg-accent/40" /> : null}

        {!loading && requirements && useEmbedded ? (
          <StripeConnectEmbedded
            connectBase={connectBase}
            component="account_onboarding"
            onExit={() => {
              void load();
            }}
          />
        ) : null}

        {!loading && requirements && !useEmbedded ? (
          <>
            {requirements.fields.map((field) => (
              <div key={field.key}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">{field.label}</p>
                {field.type === "address" ? (
                  <AddressControl prefix={field.key} values={values} onChange={setValue} />
                ) : field.type === "document" ? (
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadDocument(file);
                    }}
                    data-attr={`verify-field-${field.key}`}
                    className="w-full text-sm text-foreground"
                  />
                ) : (
                  <FieldControl field={field} value={values[field.key] ?? ""} onChange={(v) => setValue(field.key, v)} />
                )}
              </div>
            ))}
            {needsDocument && documentFileId ? (
              <p className="text-sm text-success" data-attr="verify-document-uploaded">
                Document uploaded
              </p>
            ) : null}
          </>
        ) : null}

        {!loading && meta ? (
          <div className={`flex items-center gap-2 text-sm ${meta.tone}`} data-attr="verify-status">
            {meta.icon}
            <span>{meta.label}</span>
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-danger" role="alert" data-attr="verify-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** Mounting point for the Settings → Payouts page to embed this sheet without importing its internals. */
export function renderVerifySheet(props: {
  open: boolean;
  onClose: () => void;
  connectBase: string;
  onVerified?: (status: VerifyStatus) => void;
}) {
  return <PayoutVerifySheet {...props} />;
}
