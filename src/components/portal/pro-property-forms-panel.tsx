"use client";

/**
 * A property's Forms tab (leasing rail: Applications · Lease · Forms · Move-in · Pricing): the
 * move-in forms the property sends. One header card holds the shared underline tabs, the Long term /
 * Short term stay tabs with a count each (a form for both stays is listed under each), then the
 * Settings gear and the round blue +. Below it are the template rows and the Quick add row
 * (`PropertyMoveInFormsPanel`). Move-in keeps only the whole house and its rooms.
 */
import { useMemo, useState } from "react";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PropertyMoveInFormsPanel } from "@/components/portal/move-in-forms/property-move-in-forms-panel";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import { ManagerSettingsGear } from "@/components/portal/manager-settings-gear";
import type { ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { moveInFormStayTabs } from "@/lib/move-in-forms/stays";
import { readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { stayLabel, type PropertyStay } from "@/lib/property-stay-tabs";

export function ManagerPropertyFormsPanel({
  sub,
  saveTarget,
  managerUserId,
  canEdit,
  onUpdated,
  showToast,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget | null;
  managerUserId: string | null;
  canEdit: boolean;
  onUpdated: () => void;
  showToast: (message: string) => void;
  propertyLabel?: string;
}) {
  const [formStay, setFormStay] = useState<PropertyStay>("long_term");
  const [chooserOpen, setChooserOpen] = useState(false);

  // Each form shows under the stay(s) its "Applies to" names; a form for both is in both tabs. A stay the
  // property does not allow gets no tab unless it still holds a form for that stay alone (nothing is hidden).
  const { tabs: formStayTabs, counts: formStayCounts } = useMemo(() => {
    const leases = readPropertyLeaseTemplates(sub).map((lease) => ({ id: lease.id, kind: lease.kind }));
    return moveInFormStayTabs(sub, readMoveInFormTemplates(sub), leases);
  }, [sub]);
  const openFormStay: PropertyStay = formStayTabs.includes(formStay) ? formStay : formStayTabs[0]!;

  const stayNav = (
    <LocalDestinationNav
      items={formStayTabs.map((stay) => ({
        id: stay,
        label: stayLabel(stay),
        count: formStayCounts[stay],
        dataAttr: `property-forms-tab-${stay === "long_term" ? "long" : "short"}`,
      }))}
      activeId={openFormStay}
      onChange={(id) => setFormStay(id as PropertyStay)}
      ariaLabel="Forms"
      appearance="command"
    />
  );

  return (
    <PortalPropertyDetailSection>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={stayNav}
        activeDestinationId={openFormStay}
        destinationAriaLabel="Forms"
        actions={<ManagerSettingsGear target="moveInForms" label="Move-in settings" dataAttr="property-move-in-settings-open" />}
        primary={
          canEdit ? (
            <PortalPrimaryIconAction
              label="Add move-in form"
              data-attr="property-move-in-forms-add"
              onClick={() => setChooserOpen(true)}
              className="[&>svg]:transition-transform [&>svg]:duration-(--motion-base) [&>svg]:ease-(--motion-nudge) hover:[&>svg]:rotate-90 motion-reduce:[&>svg]:transition-none"
            />
          ) : undefined
        }
      />
      <PropertyMoveInFormsPanel
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        canEdit={canEdit}
        onUpdated={onUpdated}
        showToast={showToast}
        chooserOpen={chooserOpen}
        onChooserOpenChange={setChooserOpen}
        stay={openFormStay}
      />
    </PortalPropertyDetailSection>
  );
}
