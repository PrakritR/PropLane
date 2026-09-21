import "server-only";

import type Stripe from "stripe";
import { isApplicationCollected } from "@/lib/stripe-connect";

/**
 * PropLane's own identity-verification form, driven entirely by what Stripe's
 * Accounts API says is currently due (PLAN-0920-1500, Part C). Nothing here
 * hard-codes "what Stripe asks for" — {@link getIdentityRequirements} reads
 * `account.requirements.currently_due`/`past_due` fresh every time and maps
 * only the keys this module knows how to draw a field for. A requirement key
 * it does not recognize never gets silently dropped: it flips
 * `fallbackToEmbedded`, and the sheet mounts Stripe's embedded
 * `account_onboarding` component instead (`stripe-connect-embedded.ts`)
 * rather than blocking the manager on a field nobody can fill in.
 *
 * SSN / ID number / tax ID are never accepted as plain values here — those
 * three keys are the only ones marked `sensitive`, and {@link submitIdentity}
 * drops them from `fields` even if a caller supplies them. They may only
 * arrive tokenized, inside `accountToken` (from the browser's
 * `stripe.createToken('account', …)`) or `personToken`
 * (`stripe.createToken('person', …)`) — this module forwards the token id to
 * Stripe and never logs or stores the token's contents.
 */

export type IdentityFieldType = "text" | "date" | "address" | "select" | "document" | "tel" | "email";

export type IdentityFieldOption = { value: string; label: string };

export type IdentityFieldSpec = {
  /** The logical key the client echoes back in `SubmitIdentityInput.fields` — never set for a `sensitive` spec, which only ever travels inside a token. */
  key: string;
  type: IdentityFieldType;
  label: string;
  sensitive?: boolean;
  options?: IdentityFieldOption[];
  /** The underlying `requirements.currently_due` keys this field answers. */
  requirementKeys: string[];
};

export type IdentityStatus = "verified" | "pending" | "needs_info" | "restricted";

export type IdentityRequirements = {
  status: IdentityStatus;
  fields: IdentityFieldSpec[];
  /** True when `currently_due` held a requirement key with no mapped field — the caller must fall back to Stripe's embedded component rather than silently omit it. */
  fallbackToEmbedded: boolean;
  currentlyDue: string[];
  disabledReason: string | null;
  /**
   * False for a legacy `stripe_dashboard.type: "express"` account (Decide 2 of
   * PLAN-0920-1500: "keep them"). The sheet should mount Stripe's embedded
   * `account_onboarding` component instead of this module's own form whenever
   * this is false, regardless of `fallbackToEmbedded`.
   */
  isApplicationCollected: boolean;
};

/** `external_account` is another worker's surface (bank/card linking); `tos_acceptance.*` is collected implicitly at every submit, never as a form field. */
const EXCLUDED_PREFIXES = ["external_account", "tos_acceptance"];

/** Never asked as a field — the platform sets this default at submit time (see `submitIdentity`). */
const AUTO_HANDLED_KEYS = new Set(["business_profile.mcc"]);

type FieldGroup = {
  key: string;
  type: IdentityFieldType;
  label: string;
  sensitive?: boolean;
  options?: IdentityFieldOption[];
  matches: (requirementKey: string) => boolean;
};

const FIELD_GROUPS: readonly FieldGroup[] = [
  {
    key: "individual.legal_name",
    type: "text",
    label: "Legal name",
    matches: (k) => k === "individual.first_name" || k === "individual.last_name",
  },
  {
    key: "individual.dob",
    type: "date",
    label: "Date of birth",
    matches: (k) => k.startsWith("individual.dob."),
  },
  {
    key: "individual.address",
    type: "address",
    label: "Home address",
    matches: (k) => k.startsWith("individual.address."),
  },
  {
    key: "individual.ssn_last_4",
    type: "text",
    label: "Last 4 of SSN",
    sensitive: true,
    matches: (k) => k === "individual.ssn_last_4",
  },
  {
    key: "individual.id_number",
    type: "text",
    label: "Full SSN or ID number",
    sensitive: true,
    matches: (k) => k === "individual.id_number" || k === "individual.id_number_secondary",
  },
  {
    key: "individual.phone",
    type: "tel",
    label: "Phone",
    matches: (k) => k === "individual.phone",
  },
  {
    key: "individual.email",
    type: "email",
    label: "Email",
    matches: (k) => k === "individual.email",
  },
  {
    key: "business_type",
    type: "select",
    label: "Business type",
    options: [
      { value: "individual", label: "Individual" },
      { value: "company", label: "Company" },
      { value: "llc", label: "LLC" },
      { value: "non_profit", label: "Non-profit" },
    ],
    matches: (k) => k === "business_type",
  },
  {
    key: "business_profile.url",
    type: "text",
    label: "Business website",
    matches: (k) => k === "business_profile.url" || k === "business_profile.product_description",
  },
  {
    key: "company.name",
    type: "text",
    label: "Company name",
    matches: (k) => k === "company.name",
  },
  {
    key: "company.address",
    type: "address",
    label: "Company address",
    matches: (k) => k.startsWith("company.address."),
  },
  {
    key: "company.phone",
    type: "tel",
    label: "Company phone",
    matches: (k) => k === "company.phone",
  },
  {
    key: "company.tax_id",
    type: "text",
    label: "Company tax ID (EIN)",
    sensitive: true,
    matches: (k) => k === "company.tax_id",
  },
  {
    key: "individual.verification.document",
    type: "document",
    label: "Photo ID",
    matches: (k) => k === "individual.verification.document",
  },
  {
    key: "company.verification.document",
    type: "document",
    label: "Company verification document",
    matches: (k) => k === "company.verification.document",
  },
] as const;

const SENSITIVE_FIELD_KEYS = new Set(FIELD_GROUPS.filter((g) => g.sensitive).map((g) => g.key));

function isExcludedRequirementKey(key: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)) || AUTO_HANDLED_KEYS.has(key);
}

function requirementList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function statusFor(account: Stripe.Account, currentlyDue: string[], pendingVerification: string[]): IdentityStatus {
  const disabledReason = account.requirements?.disabled_reason ?? null;
  // A `requirements.*` disabled reason just means fields are due — the ordinary
  // case this form exists for. Any other reason (rejected.fraud, listed,
  // under_review, platform_paused, …) is Stripe itself refusing the account
  // regardless of what more gets collected.
  if (disabledReason && !disabledReason.startsWith("requirements.")) {
    return "restricted";
  }
  if (currentlyDue.length > 0 || (account.requirements?.past_due?.length ?? 0) > 0) return "needs_info";
  if (pendingVerification.length > 0) return "pending";
  if (!account.details_submitted) return "needs_info";
  return "verified";
}

export type IdentityStatusSnapshot = {
  status: IdentityStatus;
  currentlyDue: string[];
  pendingVerification: string[];
  disabledReason: string | null;
};

/**
 * The status/currently-due projection off an `Account` object already in
 * hand — no Stripe call. Shared by {@link getIdentityRequirements} and the
 * `account.updated` webhook handler (`stripe-webhook-financials.ts`), which
 * already has the full account in the event payload and refreshes
 * `payout_identity_status` from it without a second round trip.
 */
export function identityStatusFromAccount(account: Stripe.Account): IdentityStatusSnapshot {
  const currentlyDue = [
    ...new Set([
      ...requirementList(account.requirements?.currently_due),
      ...requirementList(account.requirements?.past_due),
    ]),
  ];
  const pendingVerification = requirementList(account.requirements?.pending_verification);
  return {
    status: statusFor(account, currentlyDue, pendingVerification),
    currentlyDue,
    pendingVerification,
    disabledReason: account.requirements?.disabled_reason ?? null,
  };
}

/**
 * Requirements → form spec. Reads `currently_due` (merged with `past_due`,
 * since both are "asked right now") and maps each key to the one
 * {@link IdentityFieldSpec} that answers it, deduplicated — `individual.dob.day`
 * and `individual.dob.year` both point at the single "Date of birth" field.
 * A key with no mapping flips `fallbackToEmbedded` rather than being dropped.
 */
export async function getIdentityRequirements(stripe: Stripe, accountId: string): Promise<IdentityRequirements> {
  const account = await stripe.accounts.retrieve(accountId);
  const snapshot = identityStatusFromAccount(account);
  const { currentlyDue } = snapshot;

  const fields: IdentityFieldSpec[] = [];
  const seenKeys = new Set<string>();
  let fallbackToEmbedded = false;

  for (const requirementKey of currentlyDue) {
    if (isExcludedRequirementKey(requirementKey)) continue;
    const group = FIELD_GROUPS.find((g) => g.matches(requirementKey));
    if (!group) {
      fallbackToEmbedded = true;
      continue;
    }
    if (seenKeys.has(group.key)) continue;
    seenKeys.add(group.key);
    fields.push({
      key: group.key,
      type: group.type,
      label: group.label,
      sensitive: group.sensitive,
      options: group.options,
      requirementKeys: currentlyDue.filter((k) => group.matches(k)),
    });
  }

  return {
    status: snapshot.status,
    fields,
    fallbackToEmbedded,
    currentlyDue,
    disabledReason: snapshot.disabledReason,
    isApplicationCollected: isApplicationCollected(account),
  };
}

export type SubmitIdentityInput = {
  /** `stripe.createToken('account', …)` result from the browser — the whole individual/business bundle, SSN and DOB included, tokenized before it ever reaches PropLane. */
  accountToken?: string;
  /** `stripe.createToken('person', …)` result, for a company representative/owner other than the account's own `individual`. */
  personToken?: string;
  /** Required together with `personToken` — which Person the token updates. */
  personId?: string;
  /**
   * Non-sensitive plain values keyed by {@link IdentityFieldSpec.key}. Any key
   * this module marks `sensitive` (`individual.ssn_last_4`,
   * `individual.id_number`, `company.tax_id`) is dropped even if present —
   * those values are only ever accepted inside a token.
   */
  fields?: Record<string, string>;
  documentFileIds?: { front: string; back?: string };
  /** Derived server-side from the request, never from client-supplied values — see the identity route. */
  tosAcceptance: { date: number; ip: string; userAgent: string };
};

export type SubmitIdentityResult =
  | { ok: true; status: IdentityStatus; fallbackToEmbedded: boolean }
  | { ok: false; error: string };

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const next = node[part];
    if (typeof next !== "object" || next === null) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * Applies a Verify-identity submission. Sensitive fields never appear as
 * plain values in the Stripe call this function makes — they travel only
 * inside `accountToken`/`personToken`, which Stripe itself resolves; this
 * function forwards the token id and nothing else for those fields.
 * `tos_acceptance` is stamped on every submit from the caller-supplied
 * (server-derived) date/ip/user agent — see the identity route, which reads
 * these from the authenticated request rather than trusting the client body.
 */
/** 10 MB — Stripe's own limit for an `identity_document`/`additional_verification` file. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

export function isAllowedIdentityDocumentType(mimeType: string): boolean {
  return ALLOWED_DOCUMENT_TYPES.has(mimeType);
}

export function isAllowedIdentityDocumentSize(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_DOCUMENT_BYTES;
}

/**
 * Proxies one file straight to Stripe Files for the connected account
 * (`purpose: "identity_document"`) and returns only the resulting file id.
 * The bytes never touch our database or logs — the route that calls this
 * forwards the upload in memory and discards it once this resolves.
 */
export async function uploadIdentityDocumentFile(
  stripe: Stripe,
  accountId: string,
  file: { data: Buffer; name: string; type: string },
): Promise<string> {
  const uploaded = await stripe.files.create(
    { file: { data: file.data, name: file.name, type: file.type }, purpose: "identity_document" },
    { stripeAccount: accountId },
  );
  return uploaded.id;
}

export async function submitIdentity(
  stripe: Stripe,
  accountId: string,
  input: SubmitIdentityInput,
): Promise<SubmitIdentityResult> {
  try {
    if (input.accountToken) {
      await stripe.accounts.update(accountId, { account_token: input.accountToken });
    }

    if (input.personToken) {
      if (!input.personId) {
        return { ok: false, error: "A person token was submitted without a person id." };
      }
      await stripe.accounts.updatePerson(accountId, input.personId, { person_token: input.personToken });
    }

    const plain: Record<string, unknown> = {
      // Decide (plan): real estate management, MCC 6513 — never asked of the
      // manager, always set here so `business_profile.mcc` never blocks status.
      business_profile: { mcc: "6513", product_description: "Property management services" },
    };

    for (const [key, value] of Object.entries(input.fields ?? {})) {
      if (SENSITIVE_FIELD_KEYS.has(key)) continue; // defense in depth: never accepted as a plain value
      if (typeof value !== "string" || !value.trim()) continue;
      if (key === "individual.legal_name") {
        const parts = value.trim().split(/\s+/);
        const [firstName, ...rest] = parts;
        setPath(plain, "individual.first_name", firstName);
        if (rest.length > 0) setPath(plain, "individual.last_name", rest.join(" "));
        continue;
      }
      setPath(plain, key, value);
    }

    if (input.documentFileIds) {
      const businessType = input.fields?.business_type === "company" ? "company" : "individual";
      setPath(plain, `${businessType}.verification.document.front`, input.documentFileIds.front);
      if (input.documentFileIds.back) {
        setPath(plain, `${businessType}.verification.document.back`, input.documentFileIds.back);
      }
    }

    setPath(plain, "tos_acceptance.date", input.tosAcceptance.date);
    setPath(plain, "tos_acceptance.ip", input.tosAcceptance.ip);
    setPath(plain, "tos_acceptance.user_agent", input.tosAcceptance.userAgent);

    await stripe.accounts.update(accountId, plain as unknown as Stripe.AccountUpdateParams);

    const requirements = await getIdentityRequirements(stripe, accountId);
    return { ok: true, status: requirements.status, fallbackToEmbedded: requirements.fallbackToEmbedded };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update Stripe identity details.";
    return { ok: false, error: message };
  }
}
