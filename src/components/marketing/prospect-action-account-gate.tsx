"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AddResidentRoleButton } from "@/components/marketing/add-resident-role-button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  hasProspectGuestContinue,
  markProspectGuestContinue,
  prospectCreateAccountHref,
  prospectSignInHref,
  type ProspectActionKind,
} from "@/lib/prospect-public-gate";
import {
  residentPortalListingMessagePath,
  stageResidentListingMessageCompose,
} from "@/lib/prospect-public-nav";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { residentCreateAccountHref } from "@/lib/resident-public-nav";

const COPY: Record<
  ProspectActionKind,
  { eyebrow: string; title: string; body: (listing: string) => string; guestLabel: string }
> = {
  apply: {
    eyebrow: "Before you apply",
    title: "Create your resident account",
    body: (listing) =>
      `We recommend a resident account for ${listing} — create one and apply from your portal, where you can track your application, messages, and payments. Already have an account? Sign in. Or apply as a guest and we'll email setup instructions to the address you use.`,
    guestLabel: "Continue without an account",
  },
  tour: {
    eyebrow: "Before you schedule",
    title: "Create your resident account",
    body: (listing) =>
      `Track your tour for ${listing} in the resident portal — create an account to see updates and message your manager in one place. Already have an account? Sign in. Or continue as a guest and we'll ask again after your request is sent.`,
    guestLabel: "Continue as a guest",
  },
  message: {
    eyebrow: "Before you send",
    title: "Create your resident account",
    body: (listing) =>
      `Read manager replies about ${listing} in PropLane Communication — create a resident account to keep the conversation in one place. Already have an account? Sign in. Or send as a guest and we'll ask again after your message is sent.`,
    guestLabel: "Send as a guest",
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

/** Guest account gate before tour, message, or apply on a public listing link. */
export function ProspectGuestAccountGate({
  action,
  gateKey,
  returnPath,
  propertyTitle,
  onContinueGuest,
}: {
  action: ProspectActionKind;
  gateKey: string;
  returnPath: string;
  propertyTitle?: string;
  onContinueGuest: () => void;
}) {
  const [resolved, setResolved] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [guestChosen, setGuestChosen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (hasProspectGuestContinue(gateKey)) {
      setGuestChosen(true);
      setResolved(true);
      return;
    }
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

  if (!resolved || signedIn || guestChosen) return null;

  const listing = propertyTitle?.trim() || "this home";
  const copy = COPY[action];

  const continueAsGuest = () => {
    markProspectGuestContinue(gateKey);
    setGuestChosen(true);
    onContinueGuest();
  };

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
      <Button
        type="button"
        variant="ghost"
        className="mt-2.5 min-h-[44px] w-full rounded-full text-[15px] font-semibold text-muted"
        data-attr={`prospect-${action}-continue-guest`}
        onClick={continueAsGuest}
      >
        {copy.guestLabel}
      </Button>
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

/** Signed-in manager/vendor — add a resident account before tour, message, or apply. */
export function ProspectSignedInResidentGate({
  action,
  gateKey,
  returnPath,
  propertyTitle,
  onContinueGuest,
}: {
  action: ProspectActionKind;
  gateKey: string;
  returnPath: string;
  propertyTitle?: string;
  onContinueGuest: () => void;
}) {
  const autofill = useProspectContactAutofill();
  const listing = propertyTitle?.trim() || "this home";
  const createHref = residentCreateAccountHref(returnPath, {
    email: autofill.email || undefined,
    fullName: autofill.name || undefined,
    phone: autofill.phone || undefined,
    handoff: action === "message" ? "message" : undefined,
  });

  const actionLabel =
    action === "apply" ? "apply" : action === "tour" ? "schedule your tour" : "send your message";

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
          className={gatePrimaryBtnClass()}
          dataAttr={`signed-in-prospect-${action}-create-account`}
        />
        <Button
          type="button"
          variant="outline"
          className={`${gateSecondaryBtnClass()} mt-0`}
          data-attr={`signed-in-prospect-${action}-continue-guest`}
          onClick={() => {
            markProspectGuestContinue(gateKey);
            onContinueGuest();
          }}
        >
          {action === "apply" ? "Apply as a guest instead" : action === "tour" ? "Schedule as a guest" : "Send as a guest"}
        </Button>
      </div>
    </div>
  );
}
