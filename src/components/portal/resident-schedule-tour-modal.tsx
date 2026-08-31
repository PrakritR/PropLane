"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PORTAL_MODAL_BODY_SCROLL_CLASS } from "@/components/ui/modal-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PropertySearchPicker, type PropertySearchOption } from "@/components/marketing/property-search-picker";
import { TourScheduleFlow } from "@/components/marketing/tour-schedule-flow";
import {
  isPropertyActiveForLeads,
  loadPublicExtraListingsFromServer,
  loadPublicPropertyLeadFromServer,
  readExtraListingsPublic,
} from "@/lib/demo-property-pipeline";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";
import { filterSandboxFromPublicCatalog } from "@/lib/public-sandbox-listings";
import { isProductionPublicSite } from "@/lib/public-demo-access";
import { getPropertyById, getPropertyForPublicLink } from "@/lib/rental-application/data";
import { residentBrowseForTourHref } from "@/lib/resident-public-nav";
import { usePortalNavigate } from "@/lib/portal-nav-client";

export function ResidentScheduleTourModal({
  open,
  onClose,
  onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  onScheduled?: () => void;
}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [tick, setTick] = useState(0);
  const [pickedPropertyId, setPickedPropertyId] = useState<string | null>(null);
  const [flowPropertyId, setFlowPropertyId] = useState<string | null>(null);
  const [flowFooter, setFlowFooter] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!open) return;
    setPickedPropertyId(null);
    setFlowPropertyId(null);
    setFlowFooter(null);
    void loadPublicExtraListingsFromServer().then(() => setTick((n) => n + 1));
    const on = () => setTick((n) => n + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [open]);

  useEffect(() => {
    if (!flowPropertyId) return;
    void loadPublicPropertyLeadFromServer(flowPropertyId).then(() => setTick((n) => n + 1));
  }, [flowPropertyId]);

  const propertyOptions = useMemo<PropertySearchOption[]>(() => {
    void tick;
    if (!open) return [];
    return filterSandboxFromPublicCatalog(readExtraListingsPublic(), { production: isProductionPublicSite() })
      .filter(isPropertyActiveForLeads)
      .map((property) => {
        const prop = getPropertyById(property.id);
        return {
          id: property.id,
          title: property.title,
          subtitle: prop?.address,
          tags: prop ? [prop.neighborhood, prop.rentLabel].filter(Boolean) : undefined,
          searchText: prop
            ? `${prop.title} ${prop.address} ${prop.neighborhood} ${prop.buildingName} ${prop.zip}`
            : property.title,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [open, tick]);

  const flowProperty = useMemo(() => {
    void tick;
    if (!flowPropertyId) return undefined;
    return getPropertyForPublicLink(flowPropertyId);
  }, [flowPropertyId, tick]);

  const handleClose = () => {
    setPickedPropertyId(null);
    setFlowPropertyId(null);
    setFlowFooter(null);
    onClose();
  };

  const startScheduling = () => {
    const pid = pickedPropertyId?.trim();
    if (!pid) return;
    setFlowPropertyId(pid);
  };

  const pickerFooter = (
    <ModalFooter>
      <Button
        type="button"
        variant="outline"
        className="rounded-full px-4 text-[13px]"
        data-attr="resident-tour-browse-homes"
        onClick={() => {
          handleClose();
          navigate(residentBrowseForTourHref());
        }}
      >
        Browse homes
      </Button>
      <Button
        type="button"
        variant="primary"
        className="rounded-full"
        data-attr="resident-tour-continue"
        disabled={!pickedPropertyId}
        onClick={startScheduling}
      >
        Continue
      </Button>
    </ModalFooter>
  );

  return (
    <Modal
      open={open}
      title={flowProperty ? "Schedule tour" : "Choose a home to tour"}
      description={
        flowProperty
          ? undefined
          : "Pick the home you want to visit. You can request a tour time right here without leaving your tour list."
      }
      onClose={handleClose}
      dense
      assistantContext="Schedule tour"
      panelClassName={flowProperty ? "max-w-2xl" : "max-w-lg"}
      footer={flowProperty ? (flowFooter ? <ModalFooter className="w-full">{flowFooter}</ModalFooter> : null) : pickerFooter}
    >
      {flowProperty ? (
        <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
          <TourScheduleFlow
            property={flowProperty}
            returnAfterAuth="/resident/tour/pending"
            embedded
            embeddedModalLayout
            onEmbeddedFooterChange={setFlowFooter}
            onSuccess={() => {
              showToast("Tour request sent.");
              onScheduled?.();
              handleClose();
            }}
          />
        </div>
      ) : (
        <PropertySearchPicker
          options={propertyOptions}
          value={pickedPropertyId}
          onChange={setPickedPropertyId}
          placeholder="Search by address, neighborhood, or property name…"
          emptyMessage="No properties match your search."
          listEmptyMessage="No homes are available to tour right now."
          ariaLabel="Search homes to tour"
          listFillsAvailableHeight
          className="min-h-0 flex-1"
        />
      )}
    </Modal>
  );
}
