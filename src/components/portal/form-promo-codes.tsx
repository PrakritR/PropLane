"use client";

import { useState } from "react";
import { Ticket } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { WaiveCodesSettingsSection } from "@/components/portal/settings-waive-codes-section";

/**
 * "Promo codes" on an Application or a Lease card: opens the EXISTING waive-code list (Settings ->
 * Waive codes, `/api/manager/application-fee-waivers`) in a standard dialog, scoped to this property and
 * to the fee the form owns -- an application's codes waive its Application fee, a lease's its Lease fee.
 * There is no second code system: create, cap, expire and disable all run through that section.
 */
export function FormPromoCodesDialog({
  open,
  onClose,
  kind,
  propertyId,
  propertyLabel,
}: {
  open: boolean;
  onClose: () => void;
  kind: "application" | "lease";
  /** The saved property the codes apply on; absent on a draft that is not saved yet (then every property). */
  propertyId?: string | null;
  propertyLabel?: string | null;
}) {
  const id = propertyId?.trim() ?? "";
  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Promo codes"
      primaryAction={null}
      dataAttr={`${kind}-promo-codes-dialog`}
    >
      <WaiveCodesSettingsSection
        propertyOptions={id ? [{ id, label: propertyLabel?.trim() || "This property" }] : []}
        defaultAppliesTo={kind}
        show={kind}
      />
    </PortalDialog>
  );
}

/** The small "Promo codes" action a form card carries: a ticket glyph that opens {@link FormPromoCodesDialog}. */
export function FormPromoCodesAction({
  kind,
  propertyId,
  propertyLabel,
  dataAttr,
}: {
  kind: "application" | "lease";
  propertyId?: string | null;
  propertyLabel?: string | null;
  dataAttr: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PortalIconAction icon={Ticket} label="Promo codes" data-attr={dataAttr} onClick={() => setOpen(true)} />
      <FormPromoCodesDialog open={open} onClose={() => setOpen(false)} kind={kind} propertyId={propertyId} propertyLabel={propertyLabel} />
    </>
  );
}
