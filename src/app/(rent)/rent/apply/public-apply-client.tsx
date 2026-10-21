"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import { ApplicationFeeReturnPanel } from "@/components/marketing/application-fee-return-panel";
import { PublicApplyAccountPrompt } from "@/components/marketing/public-apply-account-prompt";
import { SignedInResidentAccountPrompt } from "@/components/marketing/signed-in-resident-account-prompt";
import { ApplyPropertyPicker } from "@/components/marketing/apply-property-picker";
import { ManagerLinkGate } from "@/components/marketing/manager-link-gate";
import { ApplicationUnavailableContactManager } from "@/components/marketing/application-unavailable-contact-manager";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { getPropertyForPublicLink } from "@/lib/rental-application/data";
import { propertyAcceptingOnlineApplications } from "@/lib/property-application-template-sync";
import { buildRentalApplyHref } from "@/lib/rental-application/apply-from-listing";
import { BROWSE_IDS_PARAM, parseBrowseIdsParam } from "@/lib/manager-property-links";
import "@/components/public-site/journey-forms.css";
import { loadPublicPropertyLeadFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { residentSetupIdFromUrlParams } from "@/lib/auth/resident-setup-links";
import {
  publicApplyGateKey,
  publicApplyReturnPath,
  resolvePublicApplyView,
} from "@/lib/rental-application/public-apply-session";

function publicApplyResumeLinkActive(searchParams: { get(name: string): string | null }): boolean {
  const token = searchParams.get("token")?.trim();
  return Boolean(token && residentSetupIdFromUrlParams(searchParams));
}

/**
 * Public apply surface — a resident account is required (PLAN-0924-1421).
 *
 * `signedInNonResident` is resolved on the server (authoritative role check):
 * a signed-in manager/vendor is offered a separate resident account rather than
 * the anonymous sign-in nudge, and never a blank screen. A signed-in resident
 * is redirected to the portal apply flow before this component mounts.
 */
export function PublicApplyClient({ signedInNonResident = false }: { signedInNonResident?: boolean }) {
  const searchParams = useSearchParams();
  const feeCheckout = searchParams.get("fee_checkout");
  const sessionId = searchParams.get("session_id")?.trim();
  if ((feeCheckout === "return" || feeCheckout === "success") && sessionId) {
    return (
      <div className="ps ps-j-page">
        <div className="ps-j-col">
          <ApplicationFeeReturnPanel sessionId={sessionId} />
        </div>
      </div>
    );
  }
  return <PublicApplyApplicationClient signedInNonResident={signedInNonResident} />;
}

function PublicApplyApplicationClient({ signedInNonResident }: { signedInNonResident: boolean }) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const propertyId = searchParams.get("propertyId")?.trim() ?? "";
  const portfolioPropertyIds = useMemo(() => {
    if (propertyId) return [];
    return parseBrowseIdsParam(searchParams.get(BROWSE_IDS_PARAM));
  }, [propertyId, searchParams]);
  const [extrasTick, setExtrasTick] = useState(0);
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  useEffect(() => {
    if (!portfolioPropertyIds.length) {
      setPortfolioLoading(false);
      return;
    }
    setPortfolioLoading(true);
    void Promise.all(portfolioPropertyIds.map((id) => loadPublicPropertyLeadFromServer(id))).then(() => {
      setExtrasTick((n) => n + 1);
      setPortfolioLoading(false);
    });
  }, [portfolioPropertyIds]);

  useEffect(() => {
    const on = () => setExtrasTick((n) => n + 1);
    if (propertyId) {
      void loadPublicPropertyLeadFromServer(propertyId).then(() => on());
    }
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [propertyId]);

  const portfolioProperties = useMemo(() => {
    void extrasTick;
    if (!portfolioPropertyIds.length) return [];
    return portfolioPropertyIds
      .map((id) => getPropertyForPublicLink(id))
      .filter((property): property is NonNullable<typeof property> => Boolean(property));
  }, [extrasTick, portfolioPropertyIds]);

  const propertyTitle = useMemo(() => {
    if (!propertyId) return undefined;
    return getPropertyForPublicLink(propertyId)?.title?.trim();
  }, [propertyId, extrasTick]);

  const linkedProperty = useMemo(() => {
    void extrasTick;
    if (!propertyId) return undefined;
    return getPropertyForPublicLink(propertyId);
  }, [propertyId, extrasTick]);

  const applicationsAvailable = useMemo(() => {
    if (!linkedProperty?.listingSubmission) return true;
    return propertyAcceptingOnlineApplications(linkedProperty.listingSubmission);
  }, [linkedProperty]);

  const rentalTypeParam = searchParams.get("rentalType")?.trim();
  const rentalType = rentalTypeParam === "short_term" ? ("short_term" as const) : undefined;

  const applyGateKey = useMemo(
    () => publicApplyGateKey({ propertyId, portfolioPropertyIds }),
    [propertyId, portfolioPropertyIds],
  );

  const applyReturnPath = useMemo(
    () => publicApplyReturnPath({ propertyId, portfolioPropertyIds, rentalType }),
    [propertyId, portfolioPropertyIds, rentalType],
  );

  const resumeFromEmailLink = useMemo(() => publicApplyResumeLinkActive(searchParams), [searchParams]);

  const view = resolvePublicApplyView({
    gateKey: applyGateKey,
    signedInNonResident,
    hasResidentRole: false,
    resumeFromEmailLink,
  });

  // A multi-home share now opens the wizard on the FIRST property with the rest
  // switchable inside it (AXI-154), so the standalone picker is only still the
  // right screen while the account gate is up, or when nothing resolved. One
  // resolvable home is not a choice either — the wizard handles that itself.
  const portfolioPickerBlocks =
    portfolioPropertyIds.length > 0 &&
    !propertyId &&
    (view !== "wizard" || (portfolioProperties.length === 0 && !portfolioLoading));

  if (portfolioPickerBlocks) {
    return (
      <div className="ps ps-j-page">
       <div className="ps-j-col">
        <div className="ps-j-title">
          <h1 className="ps-h1">Apply</h1>
        </div>
        <div>
          {view === "signed-in-create-resident" ? (
            <SignedInResidentAccountPrompt
              ps
              applyReturnPath={applyReturnPath}
              propertyTitle={
                portfolioProperties.length === 1
                  ? portfolioProperties[0]?.title?.trim()
                  : `${portfolioProperties.length} homes`
              }
            />
          ) : view === "account-prompt" ? (
            <PublicApplyAccountPrompt
              ps
              gateKey={applyGateKey}
              applyReturnPath={applyReturnPath}
              propertyTitle={
                portfolioProperties.length === 1
                  ? portfolioProperties[0]?.title?.trim()
                  : `${portfolioProperties.length} homes`
              }
            />
          ) : portfolioProperties.length === 0 ? (
            <ManagerLinkGate
              ps
              title="Open your manager’s application link"
              body="This application link is invalid or no longer active. Ask your property manager for a new link."
            />
          ) : (
            <ApplyPropertyPicker
              properties={portfolioProperties}
              onSelectProperty={(selectedId) => {
                const path = buildRentalApplyHref({
                  propertyId: selectedId,
                  rentalType,
                });
                router.push(path);
              }}
            />
          )}
        </div>
       </div>
      </div>
    );
  }

  const homeArea = linkedProperty?.neighborhood?.trim() || linkedProperty?.address?.trim() || "";

  return (
    <div className="ps ps-j-page">
     <div className={`ps-j-col${view === "wizard" ? " ps-j-col-wide" : ""}`}>
      <div className="ps-j-title">
        <h1 className="ps-h1">Apply</h1>
        {propertyTitle ? (
          <p className="ps-j-sub" data-attr="apply-home-line">
            {propertyTitle}
            {homeArea && homeArea !== propertyTitle ? ` · ${homeArea}` : ""}
          </p>
        ) : null}
      </div>
      {view === "signed-in-create-resident" ? (
        <SignedInResidentAccountPrompt
          ps
          applyReturnPath={applyReturnPath}
          propertyTitle={propertyTitle}
          purpose="apply"
        />
      ) : view === "account-prompt" ? (
        <PublicApplyAccountPrompt
          ps
          gateKey={applyGateKey}
          applyReturnPath={applyReturnPath}
          propertyTitle={propertyTitle}
        />
      ) : !applicationsAvailable ? (
        <ApplicationUnavailableContactManager
          ps
          propertyTitle={linkedProperty?.title}
          managerEmail={linkedProperty?.managerContactEmail}
        />
      ) : (
        <div className="ps-j-apply">
          <RentalApplicationWizard showToast={showToast} mode="public" exitPath="/rent/browse" />
        </div>
      )}
     </div>
    </div>
  );
}
