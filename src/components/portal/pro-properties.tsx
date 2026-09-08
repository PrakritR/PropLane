"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ManagerAddListingForm } from "@/components/portal/pro-add-listing-form";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import {
  ManagerHousePropertiesPanel,
  MANAGER_STAGES,
  type ManagerStageKey,
} from "@/components/portal/pro-house-properties-panel";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  ManagerPortalPageShell,
} from "@/components/portal/portal-metrics";
import { propertyListHref, type PropertyDetailTabId } from "@/lib/portal-detail-routes";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import {
  DEMO_OPEN_CREATE_LISTING_EVENT,
  DEMO_PROPERTIES_STAGE_EVENT,
  type DemoPropertiesStage,
} from "@/lib/demo/demo-playback";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { adminKpiCounts, readAdminPropertyRows } from "@/lib/demo-admin-property-inventory";
import {
  countManagerManagedPropertiesForUser,
  mirrorLocalPropertyPipelineToServer,
  PROPERTY_PIPELINE_EVENT,
} from "@/lib/demo-property-pipeline";
import { collectLinkedPropertyIds, syncManagerPortfolioFromServer } from "@/lib/manager-portfolio-access";
import { isServerSyncOriginatedEvent } from "@/lib/property-pipeline-events";
import { buildManagerShareablePropertyOptions } from "@/lib/manager-property-links";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import {
  managerPropertyLimitMessage,
  managerTierPropertyLimitReached,
  maxPropertiesForManagerTier,
} from "@/lib/manager-access";
import { loadManagerEffectivePlanTierClient } from "@/lib/manager-subscription-client";
import {
  ensureManagerFirstListingDraft,
  managerNeedsFirstListingOnboarding,
  readFirstListingPortfolioSnapshot,
  shouldSkipFirstListingOnboarding,
} from "@/lib/manager-first-listing-onboarding";

export function ManagerProperties({
  stage: stageProp = "listed",
  basePath = "/portal",
  propertyKey: propertyKeyProp,
  detailTab: detailTabProp,
  propertyTourBucket,
  propertyTourId,
}: {
  stage?: ManagerStageKey;
  basePath?: string;
  propertyKey?: string;
  detailTab?: PropertyDetailTabId;
  propertyTourBucket?: import("@/lib/portal-detail-routes").ManagerTourBucketId;
  propertyTourId?: string;
}) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const { userId, email } = useManagerUserId();
  const scopeUserId = resolveManagerScopeUserId(userId);
  const [skuLoaded, setSkuLoaded] = useState(false);
  const [skuTier, setSkuTier] = useState<string | null>(null);
  const [propCount, setPropCount] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  /**
   * Opt into the redesigned wizard with `?wizard=v2`.
   *
   * Read from `window` rather than `useSearchParams` so this component does not
   * acquire a Suspense boundary it does not otherwise need; it is only ever a
   * review switch, and the default path is untouched.
   */
  const [useV2Wizard, setUseV2Wizard] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = new URLSearchParams(window.location.search).get("wizard") === "v2";
    setUseV2Wizard(on);
    // Open it straight away so the redesign can be reviewed without going through
    // the ADD affordance, which is a paywall link once a manager is at their plan
    // limit. This opens the FORM only — creating and publishing a listing must
    // still pass the same plan gate the live wizard uses, and that wiring is not
    // in place yet, so this stays behind the flag until it is.
    if (on) setWizardOpen(true);
  }, []);
  /** Resume the seeded / first draft in the wizard (PRP-396). */
  const [resumeDraftId, setResumeDraftId] = useState<string | null>(null);
  const [portfolioTick, setPortfolioTick] = useState(0);
  const firstListingSeedAttemptedRef = useRef(false);
  const [shareListingOpen, setShareListingOpen] = useState(false);
  const [shareListingPropertyId, setShareListingPropertyId] = useState<string | undefined>();
  /** Several selected listings, for a bulk share from the Properties list (AXI-140). */
  const [shareListingPropertyIds, setShareListingPropertyIds] = useState<string[] | undefined>();
  const [demoStage, setDemoStage] = useState<ManagerStageKey>("listed");

  const activeStage = isDemoModeActive()
    ? demoStage
    : stageProp;

  const setActiveStage = useCallback(
    (stage: ManagerStageKey) => {
      if (isDemoModeActive()) {
        setDemoStage(stage);
        return;
      }
      router.push(propertyListHref(basePath, stage), { scroll: false });
    },
    [basePath, router],
  );

  const refreshPortfolio = useCallback(async () => {
    if (!scopeUserId) {
      setPropCount(0);
      return;
    }
    if (!isDemoModeActive()) {
      try {
        await syncManagerPortfolioFromServer(scopeUserId, { force: true });
      } catch {
        /* offline or dev server recompiling */
      }
    }
    setPropCount(countManagerManagedPropertiesForUser(scopeUserId));
    setPortfolioTick((t) => t + 1);
  }, [scopeUserId]);

  const refreshPending = refreshPortfolio;

  const loadSku = useCallback(async () => {
    if (isDemoModeActive()) {
      setSkuLoaded(true);
      return;
    }
    try {
      // The EFFECTIVE plan, not the raw SKU: this value only ever feeds the
      // property-limit pre-checks here and in the properties panel, and
      // `POST /api/property-records` re-resolves the same one. Reading the raw
      // tier would let the interface promise a publish the server refuses.
      const tier = await loadManagerEffectivePlanTierClient();
      setSkuTier(tier);
    } catch {
      /* ignore */
    } finally {
      setSkuLoaded(true);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadSku();
    });
  }, [loadSku]);

  useEffect(() => {
    queueMicrotask(() => {
      void refreshPortfolio().then(async () => {
        // Only push local state up once a real sync has run (userId resolved) — otherwise
        // this re-uploads a stale locally-cached snapshot and can clobber an admin-side
        // status change (e.g. request-change) that happened since this browser last synced.
        if (userId) {
          void mirrorLocalPropertyPipelineToServer(userId, collectLinkedPropertyIds(userId), {
            onError: (message) => showToast(message),
          });
        }
        // PRP-396: after the first successful sync, seed one draft when the
        // owned portfolio is empty (skip demo + sandbox accounts).
        if (
          userId &&
          scopeUserId &&
          !firstListingSeedAttemptedRef.current &&
          !shouldSkipFirstListingOnboarding({ email })
        ) {
          firstListingSeedAttemptedRef.current = true;
          const seeded = await ensureManagerFirstListingDraft(userId, { email });
          if (seeded?.created) {
            setPropCount(countManagerManagedPropertiesForUser(scopeUserId));
            setPortfolioTick((t) => t + 1);
            if (activeStage !== "drafts") {
              setActiveStage("drafts");
            }
            setResumeDraftId(seeded.draftId);
            setWizardOpen(true);
          }
        }
      });
    });
    const on = (e: Event) => {
      // A sync-originated event already delivered the fresh snapshot into the
      // local store; forcing another sync here just re-fetches what we hold.
      if (isServerSyncOriginatedEvent(e)) {
        setPropCount(countManagerManagedPropertiesForUser(scopeUserId));
        setPortfolioTick((t) => t + 1);
        return;
      }
      void refreshPortfolio();
    };
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    window.addEventListener("axis-pro-relationships", on);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
      window.removeEventListener("axis-pro-relationships", on);
    };
  }, [
    refreshPortfolio,
    userId,
    scopeUserId,
    showToast,
    email,
    firstListingSeedAttemptedRef,
  ]);

  const stageCounts = useMemo(() => {
    void portfolioTick;
    const kpiValues = adminKpiCounts(scopeUserId);
    // Index 5 is the drafts side bucket (see AdminPropertyBucketIndex).
    return {
      listed: kpiValues[2],
      unlisted: kpiValues[3],
      drafts: kpiValues[5],
    } satisfies Record<ManagerStageKey, number>;
  }, [portfolioTick, scopeUserId]);

  const shareableProperties = useMemo(() => {
    void portfolioTick;
    return buildManagerShareablePropertyOptions(scopeUserId);
  }, [scopeUserId, portfolioTick]);

  const atPropertyLimit = skuLoaded && managerTierPropertyLimitReached(skuTier, propCount);
  const limitMax = maxPropertiesForManagerTier(skuTier);

  const tryOpenAdd = () => {
    if (!skuLoaded) {
      showToast("Loading subscription…");
      void loadSku();
      return;
    }
    if (!scopeUserId) {
      showToast("Sign in to create a listing.");
      return;
    }
    if (atPropertyLimit) {
      // Take the manager to the plans page rather than only saying no. This is
      // the highest-intent moment there is — they clicked the primary action
      // BECAUSE they want another property — and a toast that names an upgrade
      // without going there wastes it. It is the same rule as the sidebar's
      // `upsell` nav lock in AGENTS.md: the locked control stays live because
      // its destination is the only route to upgrade.
      //
      // Native is the exception, and deliberately: the app may not steer to an
      // external purchase, which is what `omitUpgradeCta` already encodes, so
      // there the message alone is the whole response.
      showToast(managerPropertyLimitMessage(skuTier, { omitUpgradeCta: isNativeRuntimeSync() }));
      if (!isNativeRuntimeSync()) router.push(MANAGER_PLAN_PORTAL_URL);
      return;
    }
    // Prefer resuming the first-listing draft when that is the only work left.
    const snap = readFirstListingPortfolioSnapshot(scopeUserId);
    if (managerNeedsFirstListingOnboarding(snap) && !shouldSkipFirstListingOnboarding({ email })) {
      const draftId = readAdminPropertyRows(5, scopeUserId)[0]?.adminRefId?.trim() || null;
      if (draftId) {
        setResumeDraftId(draftId);
        setWizardOpen(true);
        return;
      }
    }
    setResumeDraftId(null);
    setWizardOpen(true);
  };

  useEffect(() => {
    if (!isDemoModeActive()) return;
    const onOpen = () => tryOpenAdd();
    const onStage = (e: Event) => {
      const stage = (e as CustomEvent<{ stage?: DemoPropertiesStage }>).detail?.stage;
      if (stage === "listed" || stage === "unlisted") setActiveStage(stage);
    };
    window.addEventListener(DEMO_OPEN_CREATE_LISTING_EVENT, onOpen);
    window.addEventListener(DEMO_PROPERTIES_STAGE_EVENT, onStage as EventListener);
    return () => {
      window.removeEventListener(DEMO_OPEN_CREATE_LISTING_EVENT, onOpen);
      window.removeEventListener(DEMO_PROPERTIES_STAGE_EVENT, onStage as EventListener);
    };
  }, [setActiveStage]);

  const openShareListing = (listingIds?: string | string[]) => {
    const many = Array.isArray(listingIds) ? listingIds.filter(Boolean) : [];
    setShareListingPropertyIds(many.length > 1 ? many : undefined);
    setShareListingPropertyId(many.length > 0 ? many[0] : (listingIds as string | undefined));
    setShareListingOpen(true);
  };

  const resumeDraftRow = useMemo(() => {
    if (!resumeDraftId || !scopeUserId) return null;
    void portfolioTick;
    return readAdminPropertyRows(5, scopeUserId).find((r) => r.adminRefId === resumeDraftId) ?? null;
  }, [resumeDraftId, scopeUserId, portfolioTick]);

  const isDetailView = Boolean(propertyKeyProp);

  const listPanel = (
    <ManagerHousePropertiesPanel
      showToast={showToast}
      activeStage={activeStage}
      onStageChange={setActiveStage}
      onSendToProspect={openShareListing}
      skuTier={skuTier}
      skuLoaded={skuLoaded}
      propertiesBase={basePath}
      propertyKey={propertyKeyProp}
      detailTab={detailTabProp}
      propertyTourBucket={propertyTourBucket}
      propertyTourId={propertyTourId}
      onAddProperty={tryOpenAdd}
      /*
        Disabled only while the PLAN is still unknown — never because the cap is
        spent. A manager at the Free limit gets a live button that refuses and
        says why, with the upgrade path in the message. Disabling it instead
        makes it a dead click: the one moment the product has to explain the
        limit and offer the upgrade passes in silence. Same rule, same reason as
        the sidebar's `upsell` nav lock in AGENTS.md.
      */
      addPropertyDisabled={!skuLoaded}
      addPropertyHint={
        atPropertyLimit && limitMax != null
          ? `Plan limit (${limitMax}) reached — upgrade to add more`
          : undefined
      }
    />
  );

  return (
    <>
      {isDetailView ? (
        listPanel
      ) : (
        <ManagerPortalPageShell
          title="Properties"
          hideTitleOnMobileNav
          navigationProvidesTitle
          titleInlineFilter={null}
          compactFilterRow
        >
          <PortalListControlStack
            className="mb-2"
            variant="command"
            stickyDestinations={false}
            destinations={MANAGER_STAGES.map((stage) => ({
              id: stage.key,
              label: stage.label,
              href: propertyListHref(basePath, stage.key),
              count: stageCounts[stage.key],
              dataAttr: `manager-properties-tab-${stage.key}`,
            }))}
            activeDestinationId={activeStage}
            destinationAriaLabel="Property pipeline stage"
          />
          {atPropertyLimit && limitMax != null ? (
            <p className="mb-4 shrink-0 rounded-2xl border px-4 py-3 text-sm portal-banner-danger lg:mb-4">
              You&apos;ve reached your plan limit of {limitMax} propert{limitMax === 1 ? "y" : "ies"}.
              <span className="native-hide">
                {" "}
                <Link className="font-semibold underline underline-offset-2 hover:text-rose-900" href={MANAGER_PLAN_PORTAL_URL}>
                  View plans
                </Link>{" "}
                to add more.
              </span>
            </p>
          ) : null}
          {listPanel}
        </ManagerPortalPageShell>
      )}
      {wizardOpen && useV2Wizard ? (
        /*
         * The redesigned wizard, opened with ?wizard=v2 so it can be reviewed
         * against the live one without changing what anybody gets by default.
         * It writes the same submission shape, so a draft saved here opens in
         * either wizard.
         */
        <ListingWizardOverlay>
          <ListingWizardV2
            onClose={() => {
              setWizardOpen(false);
              setResumeDraftId(null);
            }}
            onSaved={() => refreshPending()}
            onPublished={() => refreshPending()}
            initialSubmission={resumeDraftRow?.submission ?? null}
            showToast={showToast}
          />
        </ListingWizardOverlay>
      ) : wizardOpen ? (
        <ManagerAddListingForm
          key={resumeDraftId ?? "new-listing"}
          onClose={() => {
            setWizardOpen(false);
            setResumeDraftId(null);
          }}
          onSubmitted={() => {
            setWizardOpen(false);
            setResumeDraftId(null);
            refreshPending();
            showToast("Listing submitted and published.");
          }}
          showToast={showToast}
          skuTier={skuTier}
          propCountBeforeSubmit={propCount}
          editDraftId={resumeDraftId}
          initialSubmission={resumeDraftRow?.submission ?? null}
          initialStepIndex={resumeDraftRow?.draftStepIndex ?? null}
          initialMaxStepReached={resumeDraftRow?.draftMaxStepReached ?? null}
        />
      ) : null}
      <ShareLeadLinkModal
        open={shareListingOpen}
        onClose={() => setShareListingOpen(false)}
        kind="listing"
        properties={shareableProperties}
        preselectedPropertyId={shareListingPropertyId}
        preselectedPropertyIds={shareListingPropertyIds}
      />
    </>
  );
}
