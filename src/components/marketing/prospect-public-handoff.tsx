"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { promoteToResidentPortal } from "@/lib/prospect-portal-handoff.client";
import { residentPortalPublicHref } from "@/lib/resident-public-nav";

/** Flat public marketing canvas — no nested card chrome around tour/message flows. */
export const PUBLIC_PROSPECT_CANVAS_CLASS = "mt-8 space-y-6";
/** Same canvas inside the prospect journey (`.ps`): a stack with hairline sections. */
export const PS_PROSPECT_CANVAS_CLASS = "ps-j-stack";

const VIEW_IN_PORTAL_BTN_CLASS =
  "btn-cobalt inline-flex min-h-[44px] w-full items-center justify-center rounded-full px-6 text-[15px] font-semibold";

export function ProspectPublicSuccessBanner({
  eyebrow,
  title,
  children,
  ps = false,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  /** Journey styling (`.ps` pages only); the resident portal keeps the default. */
  ps?: boolean;
}) {
  if (ps) {
    return (
      <div className="ps-j-stack" style={{ gap: 18 }}>
        <p className="ps-j-eyebrow">{eyebrow}</p>
        <h2 className="ps-h2">{title}</h2>
        <div className="ps-j-stack" style={{ gap: 12, fontSize: 16 }}>
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border px-5 py-5 portal-banner-success">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground">{children}</div>
    </div>
  );
}

/** Signed-in prospect — open the resident portal (or add resident role first). */
export function ProspectViewInPortalAction({
  portalPath,
  signedIn,
  hasResidentRole,
  dataAttr = "prospect-view-in-portal",
  ps = false,
}: {
  portalPath: string;
  signedIn: boolean;
  hasResidentRole: boolean;
  dataAttr?: string;
  ps?: boolean;
}) {
  const btnClass = ps ? "ps-btn ps-btn-line ps-btn-block" : VIEW_IN_PORTAL_BTN_CLASS;
  const { showToast } = useAppUi();
  const [opening, setOpening] = useState(false);
  const href = residentPortalPublicHref({
    signedIn,
    isResident: hasResidentRole,
    nextPath: portalPath,
  });

  if (signedIn && !hasResidentRole) {
    return (
      <button
        type="button"
        data-attr={dataAttr}
        disabled={opening}
        onClick={() => {
          if (opening) return;
          setOpening(true);
          void promoteToResidentPortal(portalPath).then((ok) => {
            if (!ok) showToast("Could not open the resident portal.");
            setOpening(false);
          });
        }}
        className={btnClass}
      >
        {opening ? "Opening…" : "View in portal"}
      </button>
    );
  }

  return (
    <Link href={href} data-attr={dataAttr} className={btnClass}>
      View in portal
    </Link>
  );
}

export function ProspectAccountHandoff({
  title,
  description,
  createAccountHref,
  signInHref,
  createAccountDataAttr,
  signInDataAttr,
  ps = false,
}: {
  title: string;
  description: string;
  createAccountHref: string;
  signInHref: string;
  createAccountDataAttr: string;
  signInDataAttr: string;
  ps?: boolean;
}) {
  if (ps) {
    return (
      <div className="ps-j-sect">
        <h3 className="ps-h3">{title}</h3>
        <p style={{ margin: 0 }}>{description}</p>
        <div className="ps-j-btn-row">
          <Link href={createAccountHref} data-attr={createAccountDataAttr} className="ps-btn ps-btn-blue">
            Create account
          </Link>
          <Link href={signInHref} data-attr={signInDataAttr} className="ps-btn ps-btn-line">
            Sign in
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Link
          href={createAccountHref}
          data-attr={createAccountDataAttr}
          className="btn-cobalt inline-flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-full px-5 text-[15px] font-semibold sm:px-6"
        >
          Create account
        </Link>
        <Link
          href={signInHref}
          data-attr={signInDataAttr}
          className="inline-flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-full border border-border px-5 text-[15px] font-semibold text-foreground hover:bg-accent/30 sm:px-6"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
