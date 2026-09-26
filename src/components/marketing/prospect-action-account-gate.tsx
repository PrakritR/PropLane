"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AddResidentRoleButton } from "@/components/marketing/add-resident-role-button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  prospectCreateAccountHref,
  prospectSignInHref,
  type ProspectActionKind,
} from "@/lib/prospect-public-gate";
import {
  residentPortalListingMessagePath,
  residentPortalTourSchedulePath,
  stageResidentListingMessageCompose,
} from "@/lib/prospect-public-nav";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";

const COPY: Record<
  ProspectActionKind,
  { eyebrow: string; title: string; body: (listing: string) => string }
> = {
  apply: {
    eyebrow: "Before you apply",
    title: "Create your resident account",
    body: (listing) =>
      `A resident account is required to apply for ${listing}. Create one and apply from your portal, where you track your application, messages, and payments. Already have an account? Sign in.`,
  },
  tour: {
    eyebrow: "Before you schedule",
    title: "Create your resident account",
    body: (listing) =>
      `A resident account is required to schedule a tour of ${listing}. Create one to see tour updates and message your manager in one place. Already have an account? Sign in.`,
  },
  message: {
    eyebrow: "Before you send",
    title: "Create your resident account",
    body: (listing) =>
      `A resident account is required to message your manager about ${listing}. Create one to keep replies in PropLane Communication. Already have an account? Sign in.`,
  },
  lease: {
    eyebrow: "Before you sign",
    title: "Create your resident account to sign your lease",
    body: (listing) =>
      `A resident account is required to sign your lease for ${listing}. Create one to review the document, sign it, and pay from your portal. Already have an account? Sign in.`,
  },
};

function gateButtonRowClass() {
  return "flex flex-wrap gap-2.5";
}

function gatePrimaryBtnClass() {
  return "btn-cobalt inline-flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-full px-5 text-[15px] font-semibold sm:px-6";
}

function gateSecondaryBtnClass() {
  return "inline-flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-full border border-border px-5 text-[15px] font-semibold text-foreground hover:bg-accent/30 sm:px-6";
}

/**
 * Account gate before tour, message, apply, or lease signature on a public
 * listing link. An account is required (PLAN-0924-1421) — there is no guest
 * path out of this gate.
 */
export function ProspectGuestAccountGate({
  action,
  gateKey,
  returnPath,
  propertyTitle,
}: {
  action: ProspectActionKind;
  gateKey: string;
  returnPath: string;
  propertyTitle?: string;
}) {
  const [resolved, setResolved] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data } = await supabase.auth.getSession();
        if (!cancelled) {
          setSignedIn(Boolean(data.session?.user));
          setResolved(true);
        }
      } catch {
        if (!cancelled) setResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateKey]);

  if (!resolved || signedIn) return null;

  const listing = propertyTitle?.trim() || "this home";
  const copy = COPY[action];

  return (
    <div className="mx-auto w-full max-w-3xl py-2 sm:py-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">{copy.eyebrow}</p>
      <h2 className="mt-2 text-lg font-bold tracking-tight text-foreground sm:text-xl">{copy.title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{copy.body(listing)}</p>
      <div className={`mt-4 ${gateButtonRowClass()}`}>
        <Link
          href={prospectCreateAccountHref(action, gateKey, returnPath)}
          className={gatePrimaryBtnClass()}
          data-attr={`prospect-${action}-create-account`}
        >
          Create account
        </Link>
        <Link
          href={prospectSignInHref(action, gateKey, returnPath)}
          className={gateSecondaryBtnClass()}
          data-attr={`prospect-${action}-sign-in`}
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}

/** Signed-in resident — schedule tours from the resident portal, not the public form. */
export function ProspectResidentPortalTourPrompt({
  propertyId,
  propertyTitle,
}: {
  propertyId: string;
  propertyTitle?: string;
}) {
  const listing = propertyTitle?.trim() || "this listing";
  const portalPath = residentPortalTourSchedulePath(propertyId);

  return (
    <div className="mx-auto w-full max-w-3xl py-2 sm:py-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">Resident account</p>
      <h2 className="mt-2 text-lg font-bold tracking-tight text-foreground sm:text-xl">
        Schedule your tour in the resident portal
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        You already have a resident account — pick a room and time for {listing} from your tour schedule in the
        resident portal.
      </p>
      <div className={`mt-4 ${gateButtonRowClass()}`}>
        <Link
          href={portalPath}
          className={gatePrimaryBtnClass()}
          data-attr="prospect-tour-open-portal-schedule"
        >
          Schedule tour
        </Link>
        <Link
          href="/resident/tour/pending"
          className={gateSecondaryBtnClass()}
          data-attr="prospect-tour-open-tour-inbox"
        >
          Go to tours
        </Link>
      </div>
    </div>
  );
}

/** Signed-in resident — message from Communication, not the public lead form. */
export function ProspectResidentPortalMessagePrompt({
  propertyId,
  propertyTitle,
}: {
  propertyId: string;
  propertyTitle?: string;
}) {
  const listing = propertyTitle?.trim() || "this listing";
  const portalPath = residentPortalListingMessagePath(propertyId);

  return (
    <div className="mx-auto w-full max-w-3xl py-2 sm:py-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">Resident account</p>
      <h2 className="mt-2 text-lg font-bold tracking-tight text-foreground sm:text-xl">
        Message your manager in Communication
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        You already have a resident account — send questions about {listing} from PropLane Communication so manager
        replies stay in one place with your applications, lease, and payments.
      </p>
      <div className={`mt-4 ${gateButtonRowClass()}`}>
        <Link
          href={portalPath}
          className={gatePrimaryBtnClass()}
          data-attr="prospect-message-open-communication"
          onClick={() => stageResidentListingMessageCompose(propertyId)}
        >
          Open Communication
        </Link>
        <Link
          href="/resident/communication/active"
          className={gateSecondaryBtnClass()}
          data-attr="prospect-message-open-inbox"
        >
          Go to inbox
        </Link>
      </div>
    </div>
  );
}

/** Signed-in manager/vendor — add a resident account before tour, message, apply, or lease. */
export function ProspectSignedInResidentGate({
  action,
  returnPath,
  propertyTitle,
}: {
  action: ProspectActionKind;
  returnPath: string;
  propertyTitle?: string;
}) {
  const autofill = useProspectContactAutofill();
  const listing = propertyTitle?.trim() || "this home";

  const actionLabel =
    action === "apply"
      ? "apply"
      : action === "tour"
        ? "schedule your tour"
        : action === "lease"
          ? "sign your lease"
          : "send your message";

  return (
    <div className="mx-auto w-full max-w-3xl py-2 sm:py-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">You&apos;re signed in</p>
      <h2 className="mt-2 text-lg font-bold tracking-tight text-foreground sm:text-xl">
        Create a resident account to {actionLabel}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        To {actionLabel} for {listing}, add a separate resident account on your existing login — same email, no new
        password, and its own resident portal kept separate from your current account.
      </p>
      <div className={`mt-4 ${gateButtonRowClass()}`}>
        <AddResidentRoleButton
          returnPath={returnPath}
          contactEmail={autofill.email || undefined}
          className={gatePrimaryBtnClass()}
          dataAttr={`signed-in-prospect-${action}-create-account`}
        />
      </div>
    </div>
  );
}
