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
  return "ps-j-btn-row";
}

function gatePrimaryBtnClass() {
  return "ps-btn ps-btn-blue";
}

function gateSecondaryBtnClass() {
  return "ps-btn ps-btn-line";
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
    <div className="ps-j-gate">
      <p className="ps-j-eyebrow">{copy.eyebrow}</p>
      <h2 className="ps-h3">{copy.title}</h2>
      <p>{copy.body(listing)}</p>
      <div className={gateButtonRowClass()}>
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
    <div className="ps-j-gate">
      <p className="ps-j-eyebrow">Resident account</p>
      <h2 className="ps-h3">
        Schedule your tour in the resident portal
      </h2>
      <p>
        You already have a resident account — pick a room and time for {listing} from your tour schedule in the
        resident portal.
      </p>
      <div className={gateButtonRowClass()}>
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
    <div className="ps-j-gate">
      <p className="ps-j-eyebrow">Resident account</p>
      <h2 className="ps-h3">
        Message your manager in Communication
      </h2>
      <p>
        You already have a resident account — send questions about {listing} from PropLane Communication so manager
        replies stay in one place with your applications, lease, and payments.
      </p>
      <div className={gateButtonRowClass()}>
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
    <div className="ps-j-gate">
      <p className="ps-j-eyebrow">You&apos;re signed in</p>
      <h2 className="ps-h3">
        Create a resident account to {actionLabel}
      </h2>
      <p>
        To {actionLabel} for {listing}, add a separate resident account on your existing login — same email, no new
        password, and its own resident portal kept separate from your current account.
      </p>
      <div className={gateButtonRowClass()}>
        <AddResidentRoleButton
          returnPath={returnPath}
          contactEmail={autofill.email || undefined}
          className="ps-btn ps-btn-blue !rounded-[3px] !bg-[var(--ps-blue)] lg:!h-11 lg:!px-[18px] lg:!text-[15px]"
          dataAttr={`signed-in-prospect-${action}-create-account`}
        />
      </div>
    </div>
  );
}
