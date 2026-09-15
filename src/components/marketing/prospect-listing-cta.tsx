"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import {
  buildProspectApplyHref,
  buildProspectMessageHref,
  buildProspectTourHref,
  stageResidentListingMessageCompose,
} from "@/lib/prospect-public-nav";
import type { RentalApplyFromListingParams } from "@/lib/rental-application/apply-from-listing";

type ProspectListingCtaProps = {
  action: "apply" | "tour" | "message";
  propertyId: string;
  className?: string;
  children: ReactNode;
  "data-attr"?: string;
  applyParams?: Omit<RentalApplyFromListingParams, "propertyId">;
  /** Open in a new tab — a manager's own preview must not navigate the portal away. */
  newTab?: boolean;
};

export function ProspectListingCta({
  action,
  propertyId,
  className,
  children,
  "data-attr": dataAttr,
  applyParams,
  newTab = false,
}: ProspectListingCtaProps) {
  const autofill = useProspectContactAutofill();

  const href = useMemo(() => {
    const auth = {
      ready: autofill.ready,
      userId: autofill.userId,
      hasResidentRole: autofill.hasResidentRole,
    };
    if (action === "apply") {
      return buildProspectApplyHref({ propertyId, ...applyParams }, auth);
    }
    if (action === "tour") {
      return buildProspectTourHref(propertyId, auth);
    }
    return buildProspectMessageHref(propertyId, auth);
  }, [action, applyParams, autofill.hasResidentRole, autofill.ready, autofill.userId, propertyId]);

  const onClick = () => {
    if (action === "message" && autofill.ready && autofill.userId && autofill.hasResidentRole) {
      stageResidentListingMessageCompose(propertyId);
    }
  };

  return (
    <Link
      href={href}
      className={className}
      data-attr={dataAttr}
      onClick={onClick}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </Link>
  );
}
