"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
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
import { loadPublicPropertyLeadFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { residentSetupIdFromUrlParams } from "@/lib/auth/resident-setup-token";
import {
  hasPublicApplyGuestContinue,
  markPublicApplyGuestContinue,
  publicApplyGateKey,
  publicApplyReturnPath,
  resolvePublicApplyView,
} from "@/lib/rental-application/public-apply-session";

function publicApplyResumeLinkActive(searchParams: { get(name: string): string | null }): boolean {
  const token = searchParams.get("token")?.trim();
  return Boolean(token && residentSetupIdFromUrlParams(searchParams));
}

/**
 * Public guest apply surface — account recommended, not required.
 *
 * `signedInNonResident` is resolved on the server (authoritative role check):
 * a signed-in manager/vendor is offered a separate resident account rather than
 * the anonymous sign-in nudge, and never a blank screen. A signed-in resident
 * is redirected to the portal apply flow before this component mounts.
 */
export function PublicApplyClient({ signedInNonResident = false }: { signedInNonResident?: boolean }) {
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

  const [guestBypass, setGuestBypass] = useState(false);
  const [guestContinuedInSession, setGuestContinuedInSession] = useState(false);

  useEffect(() => {
    if (!applyGateKey) {
      setGuestContinuedInSession(false);
      return;
    }
    setGuestContinuedInSession(hasPublicApplyGuestContinue(applyGateKey));
  }, [applyGateKey]);

  useEffect(() => {
    if (!resumeFromEmailLink || !applyGateKey) return;
    markPublicApplyGuestContinue(applyGateKey);
    setGuestBypass(true);
  }, [applyGateKey, resumeFromEmailLink]);

  const continueAsGuest = useCallback(() => {
    if (applyGateKey) markPublicApplyGuestContinue(applyGateKey);
    setGuestBypass(true);
  }, [applyGateKey]);

  const guestContinue = !applyGateKey || guestBypass || guestContinuedInSession || resumeFromEmailLink;

  const view = resolvePublicApplyView({
    gateKey: applyGateKey,
    guestContinue,
    signedInNonResident,
    hasResidentRole: false,
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
      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Rental application</h1>
        <div className="mt-8">
          {view === "signed-in-create-resident" ? (
            <SignedInResidentAccountPrompt
              gateKey={applyGateKey}
              applyReturnPath={applyReturnPath}
              propertyTitle={
                portfolioProperties.length === 1
                  ? portfolioProperties[0]?.title?.trim()
                  : `${portfolioProperties.length} homes`
              }
              onContinueGuest={continueAsGuest}
            />
          ) : view === "account-prompt" ? (
            <PublicApplyAccountPrompt
              gateKey={applyGateKey}
              applyReturnPath={applyReturnPath}
              propertyTitle={
                portfolioProperties.length === 1
                  ? portfolioProperties[0]?.title?.trim()
                  : `${portfolioProperties.length} homes`
              }
              onContinueGuest={continueAsGuest}
            />
          ) : portfolioProperties.length === 0 ? (
            <ManagerLinkGate
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
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      {view === "signed-in-create-resident" ? (
        <SignedInResidentAccountPrompt
          gateKey={applyGateKey}
          applyReturnPath={applyReturnPath}
          propertyTitle={propertyTitle}
          onContinueGuest={continueAsGuest}
        />
      ) : view === "account-prompt" ? (
        <PublicApplyAccountPrompt
          gateKey={applyGateKey}
          applyReturnPath={applyReturnPath}
          propertyTitle={propertyTitle}
          onContinueGuest={continueAsGuest}
        />
      ) : !applicationsAvailable ? (
        <ApplicationUnavailableContactManager
          propertyTitle={linkedProperty?.title}
          managerEmail={linkedProperty?.managerContactEmail}
          managerPhone={linkedProperty?.contactSmsPhone}
        />
      ) : (
        <RentalApplicationWizard showToast={showToast} mode="public" exitPath="/rent/browse" />
      )}
    </div>
  );
}
