"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { MockProperty } from "@/data/types";
import { loadPublicPropertyLeadFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { getPropertyForPublicLink } from "@/lib/rental-application/data";
import { ListingMessageForm } from "@/components/marketing/listing-message-sheet";
import { ManagerLinkGate } from "@/components/marketing/manager-link-gate";
import "@/components/public-site/journey-forms.css";
import { JourneyHouseCard } from "@/components/public-site/journey-house-card";
import { JourneyPicker, type JourneyPickerOption } from "@/components/public-site/journey-picker";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import {
  BROWSE_IDS_PARAM,
  buildTourContactHref,
  parseBrowseIdsParam,
} from "@/lib/manager-property-links";
import {
  TourScheduleFlow,
  isTourRoomUndecided,
  TOUR_ROOM_UNDECIDED_KEY,
  TOUR_ROOM_UNDECIDED_LABEL,
} from "@/components/marketing/tour-schedule-flow";
import {
  ProspectResidentPortalTourPrompt,
  ProspectSignedInResidentGate,
} from "@/components/marketing/prospect-action-account-gate";
import {
  PS_PROSPECT_CANVAS_CLASS,
} from "@/components/marketing/prospect-public-handoff";
import { useProspectActionGate } from "@/hooks/use-prospect-action-gate";


export { isTourRoomUndecided, TOUR_ROOM_UNDECIDED_KEY, TOUR_ROOM_UNDECIDED_LABEL };

type Tab = "tour" | "message";

export function ToursContactPageClient({ signedInNonResident = false }: { signedInNonResident?: boolean }) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabFromUrl = searchParams.get("tab")?.trim().toLowerCase();
  const initialTab: Tab = tabFromUrl === "message" ? "message" : "tour";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [extrasTick, setExtrasTick] = useState(0);
  const linkedPropertyId = searchParams.get("propertyId")?.trim() ?? "";
  const portfolioPropertyIds = useMemo(() => {
    if (linkedPropertyId) return [];
    return parseBrowseIdsParam(searchParams.get(BROWSE_IDS_PARAM));
  }, [linkedPropertyId, searchParams]);
  const nextPath = searchParams.get("next")?.trim() ?? "";
  const tourReturnPath = linkedPropertyId ? buildTourContactHref(linkedPropertyId) : "/rent/tours-contact";
  const returnAfterAuth = nextPath.startsWith("/") ? nextPath : tourReturnPath;

  useEffect(() => {
    if (!portfolioPropertyIds.length) return;
    void Promise.all(portfolioPropertyIds.map((id) => loadPublicPropertyLeadFromServer(id))).then(() => {
      setExtrasTick((n) => n + 1);
    });
  }, [portfolioPropertyIds]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const on = () => setExtrasTick((n) => n + 1);
    if (linkedPropertyId) {
      void loadPublicPropertyLeadFromServer(linkedPropertyId).then(() => on());
    }
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [linkedPropertyId]);

  const linkedProperty = useMemo(() => {
    void extrasTick;
    if (!linkedPropertyId) return undefined;
    return getPropertyForPublicLink(linkedPropertyId);
  }, [extrasTick, linkedPropertyId]);

  const portfolioProperties = useMemo(() => {
    void extrasTick;
    if (!portfolioPropertyIds.length) return [];
    return portfolioPropertyIds
      .map((id) => getPropertyForPublicLink(id))
      .filter((property): property is MockProperty => Boolean(property));
  }, [extrasTick, portfolioPropertyIds]);

  const contactAutofill = useProspectContactAutofill();
  const tourGate = useProspectActionGate("tour", linkedPropertyId, signedInNonResident, contactAutofill);

  // The house the page is about: a linked home, once it has loaded. Drawn beside the flow on desktop.
  const showHouse = Boolean(linkedProperty) && portfolioPropertyIds.length === 0;

  return (
    <div className="ps ps-j-page">
      <div className="ps-j-col">
        <div className="ps-j-title">
          <h1 className="ps-h1">{tab === "tour" ? "Book a tour" : "Message PropLane"}</h1>
        </div>

        <div className={showHouse ? "ps-j-grid" : undefined}>
          {showHouse && linkedProperty ? (
            <aside>
              <JourneyHouseCard property={linkedProperty} />
            </aside>
          ) : null}

          <div className="ps-j-stack" style={{ minWidth: 0 }}>
            <div className="ps-j-tabs" role="tablist" aria-label="Tour or message">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "tour"}
                className="ps-j-tab"
                data-attr="tours-contact-tab-tour"
                onClick={() => setTab("tour")}
              >
                Tour
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "message"}
                className="ps-j-tab"
                data-attr="tours-contact-tab-message"
                onClick={() => setTab("message")}
              >
                Message
              </button>
            </div>

            <div key={tab}>
              {tab === "tour" ? (
                portfolioPropertyIds.length > 0 && portfolioProperties.length === 0 ? (
                  <ManagerLinkGate
                    ps
                    title="Open your manager’s tour link"
                    body="This tour link is invalid or no longer active. Ask your property manager for a new tour link."
                  />
                ) : portfolioProperties.length > 0 ? (
                  <TourPropertyPicker
                    properties={portfolioProperties}
                    onSelectProperty={(propertyId) => {
                      router.push(buildTourContactHref(propertyId));
                    }}
                  />
                ) : !linkedPropertyId || !linkedProperty ? (
                  <ManagerLinkGate
                    ps
                    title="Open your manager’s tour link"
                    body={
                      linkedPropertyId && !linkedProperty
                        ? "This property link is invalid or no longer active. Ask your property manager for a new tour link."
                        : "Tours start from a link your property manager shares after you find a unit on Zillow, Redfin, or elsewhere."
                    }
                  />
                ) : !tourGate.ready ? (
                  <div className="ps-mute" aria-busy="true">
                    Loading…
                  </div>
                ) : tourGate.gateView === "resident-portal" ? (
                  <ProspectResidentPortalTourPrompt
                    propertyId={linkedProperty.id}
                    propertyTitle={linkedProperty.title}
                  />
                ) : tourGate.gateView === "signed-in-create-resident" ? (
                  <ProspectSignedInResidentGate
                    action="tour"
                    returnPath={tourGate.portalReturn}
                    propertyTitle={linkedProperty.title}
                  />
                ) : (
                  // A signed-out prospect sees the room, days and times straight away. The account is asked
                  // for at "Your details", after the time is chosen; nothing is written before sign-in.
                  <TourScheduleFlow
                    property={linkedProperty}
                    returnAfterAuth={returnAfterAuth}
                    onSuccess={() => showToast("Tour requested.")}
                  />
                )
              ) : !linkedPropertyId || !linkedProperty ? (
                <ManagerLinkGate
                  ps
                  title="Open your manager’s property link"
                  body={
                    linkedPropertyId && !linkedProperty
                      ? "This property link is invalid or no longer active. Ask your property manager for a new link."
                      : "Messages about a listing start from a link your property manager shares with the property ID."
                  }
                />
              ) : (
                // No account wall: a phone and a texted code are enough to message a home (design-1112 §1).
                <div className={PS_PROSPECT_CANVAS_CLASS}>
                  <ListingMessageForm target={{ propertyId: linkedProperty.id, propertyLabel: linkedProperty.title }} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TourPropertyPicker({
  properties,
  onSelectProperty,
}: {
  properties: MockProperty[];
  onSelectProperty: (propertyId: string) => void;
}) {
  const options: JourneyPickerOption[] = useMemo(
    () =>
      properties.map((property) => ({
        id: property.id,
        title: property.title,
        place: property.address || property.neighborhood,
        figure: property.rentLabel,
        searchText: `${property.neighborhood} ${property.buildingName} ${property.unitLabel}`,
      })),
    [properties],
  );

  return (
    <div className={PS_PROSPECT_CANVAS_CLASS} style={{ gap: 18 }}>
      <h2 className="ps-h3">Choose a home to tour</h2>
      <JourneyPicker
        options={options}
        value={null}
        onChange={onSelectProperty}
        placeholder="Search by address, neighborhood, or property name"
        emptyMessage="No properties match your search."
        listEmptyMessage="No properties are available from this link."
        ariaLabel="Search properties to tour"
        searchAbove={5}
      />
    </div>
  );
}
