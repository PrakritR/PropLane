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
import { PortalIconAction, PORTAL_PAGE_PRIMARY_ACTION_BTN } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { Settings2, Share2 } from "lucide-react";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import {
  ManagerPortalPageShell,
} from "@/components/portal/portal-metrics";
import { propertyDetailHref, propertyListHref, type PropertyDetailTabId } from "@/lib/portal-detail-routes";
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
import { accountLinksKnown, fetchAccountLinksCached } from "@/lib/portal-data-store";
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
  managerHasAnyListing,
  markFirstListingWizardDismissed,
  readFirstListingWizardDismissed,
  shouldAutoOpenFirstListingWizard,
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
   * The redesigned wizard is the default. `?wizard=v1` falls back to the previous
   * one, which stays in the tree as an escape hatch while the new flow settles.
   *
   * Read from `window` rather than `useSearchParams` so this component does not
   * acquire a Suspense boundary it does not otherwise need.
   *
   * It starts as `null` — "not decided yet" — so the first paint renders NEITHER
   * wizard. Defaulting either way would flash the wrong editor for a moment at
   * the one time a manager is watching the screen most closely.
   */
  const [useV2Wizard, setUseV2Wizard] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    // The redesigned workspace is what everybody gets. `?wizard=v1` is the way
    // back to the original form while it is still in the tree, and `?wizard=v2`
    // still opens the redesign straight away — that is how it is reviewed
    // without going through the ADD affordance, which turns into a paywall link
    // once a manager is at their plan limit. Publishing is still gated:
    // useListingPersistence pre-checks the plan and the server re-checks it.
    setUseV2Wizard(params.get("wizard") !== "v1");
    if (params.get("wizard") === "v2") setWizardOpen(true);
  }, []);
  /** Resume the seeded / first draft in the wizard (PRP-396). */
  const [resumeDraftId, setResumeDraftId] = useState<string | null>(null);
  /**
   * Closing the create-listing wizard is an ANSWER, remembered for good.
   *
   * It used to reopen on every visit to Properties until a listing existed, so
   * a manager who closed it found it waiting again the next time they came
   * back — including on the Drafts tab they were trying to read.
   */
  const dismissFirstListingWizard = useCallback(() => {
    setWizardOpen(false);
    setResumeDraftId(null);
    markFirstListingWizardDismissed(userId);
  }, [userId]);
  const [portfolioTick, setPortfolioTick] = useState(0);
  const firstListingSeedAttemptedRef = useRef(false);
  const [shareListingOpen, setShareListingOpen] = useState(false);
  const [listSettingsOpen, setListSettingsOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
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

  /**
   * Resolves whether the portfolio is now SERVER-TRUE. A false here means the
   * local counts below are whatever this browser happened to be holding, which
   * is why the first-listing seed refuses to act on them (PRP-429).
   */
  const refreshPortfolio = useCallback(async (): Promise<boolean> => {
    if (!scopeUserId) {
      setPropCount(0);
      return false;
    }
    let synced = false;
    if (!isDemoModeActive()) {
      try {
        synced = await syncManagerPortfolioFromServer(scopeUserId, { force: true });
      } catch {
        /* offline or dev server recompiling */
      }
    } else {
      synced = true;
    }
    setPropCount(countManagerManagedPropertiesForUser(scopeUserId));
    setPortfolioTick((t) => t + 1);
    return synced;
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
      void refreshPortfolio().then(async (portfolioSynced) => {
        // Only push local state up once a real sync has run (userId resolved) — otherwise
        // this re-uploads a stale locally-cached snapshot and can clobber an admin-side
        // status change (e.g. request-change) that happened since this browser last synced.
        if (userId) {
          void mirrorLocalPropertyPipelineToServer(userId, collectLinkedPropertyIds(userId), {
            onError: (message) => showToast(message),
          });
        }
        // PRP-396 / PRP-429: after a CONFIRMED sync, seed one draft when the
        // portfolio is empty (skip demo + sandbox accounts), then decide where
        // this manager should land and whether the wizard opens itself.
        //
        // The wizard used to reopen on EVERY visit until a listing existed. That
        // made closing it meaningless — it was waiting again the next time, on
        // top of the Drafts tab the manager was trying to read. It now opens on
        // exactly two conditions, both in `shouldAutoOpenFirstListingWizard`:
        // no listing of ANY kind (owned, unlisted, or co-managed), and never
        // closed before.
        if (
          userId &&
          scopeUserId &&
          portfolioSynced &&
          !propertyKeyProp &&
          !firstListingSeedAttemptedRef.current &&
          !shouldSkipFirstListingOnboarding({ email })
        ) {
          firstListingSeedAttemptedRef.current = true;
          // Wait for a real answer about co-manager links before judging the
          // portfolio empty. The link cache reads `[]` both before it loads and
          // when there genuinely are none, and seeding on the first of those
          // handed a co-manager a draft on every visit (their three properties
          // live on somebody else's row, so nothing they own says otherwise).
          try {
            await fetchAccountLinksCached();
          } catch {
            /* the known-flag stays false, which is itself the refusal below */
          }
          const linksKnown = accountLinksKnown();
          const seeded = await ensureManagerFirstListingDraft(userId, {
            email,
            portfolioSynced,
            coManagerLinksKnown: linksKnown,
          });
          if (seeded) {
            setPropCount(countManagerManagedPropertiesForUser(scopeUserId));
            setPortfolioTick((t) => t + 1);
          }
          // Read AFTER any seed, and outside the `seeded` branch: an account
          // that already had a draft still needs to land on Drafts, and one
          // where seeding was declined must not be stranded on an empty Listed.
          const snap = readFirstListingPortfolioSnapshot(userId);
          if (linksKnown && !managerHasAnyListing(snap) && activeStage !== "drafts") {
            setActiveStage("drafts");
          }
          if (
            seeded &&
            shouldAutoOpenFirstListingWizard({
              snap,
              dismissed: readFirstListingWizardDismissed(userId),
              coManagerLinksKnown: linksKnown,
            })
          ) {
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
    propertyKeyProp,
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
      searchQuery={listSearch}
      /*
        Disabled only while the PLAN is still unknown — never because the cap is
        spent. A manager at the Free limit gets a live button that refuses and
        says why, with the upgrade path in the message. Disabling it instead
        makes it a dead click: the one moment the product has to explain the
        limit and offer the upgrade passes in silence. Same rule, same reason as
        the sidebar's `upsell` nav lock in AGENTS.md.
      */
      addPropertyDisabled={!skuLoaded}
    />
  );

  return (
    <>
      {isDetailView ? (
        listPanel
      ) : (
        <ManagerPortalPageShell
          title="Properties"
          subtitle="Every home, rentable space, and listing in one place."
          hideTitleOnMobileNav
          titleInlineFilter={null}
          compactFilterRow
          primaryAction={
            <Button
              type="button"
              className={PORTAL_PAGE_PRIMARY_ACTION_BTN}
              disabled={!skuLoaded}
              data-attr="manager-properties-add-top"
              onClick={tryOpenAdd}
            >
              + Add property
            </Button>
          }
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
            search={{
              value: listSearch,
              onChange: setListSearch,
              placeholder: "Search properties",
              dataAttr: "manager-properties-search",
            }}
            actions={
              <>
                <PortalIconAction
                  icon={Settings2}
                  label="Property settings"
                  data-attr="manager-properties-settings-open"
                  onClick={() => setListSettingsOpen(true)}
                />
                <PortalIconAction
                  icon={Share2}
                  label="Share listing link"
                  data-attr="manager-properties-share-open"
                  onClick={() => openShareListing()}
                />
              </>
            }
          />
          <ManagerPortalSettingsModal
            open={listSettingsOpen}
            onClose={() => setListSettingsOpen(false)}
            initialTab="applications"
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
      {wizardOpen && useV2Wizard === true ? (
        /*
         * The redesigned listing workspace — a step rail, the form, and a panel
         * that shows what the manager just changed. It writes the same
         * submission shape as the original form, so a draft saved in either
         * opens in the other.
         */
        <ListingWizardOverlay>
          <ListingWizardV2
            onClose={dismissFirstListingWizard}
            onSaved={() => refreshPending()}
            onPublished={(listingId) => {
              setWizardOpen(false);
              setResumeDraftId(null);
              showToast("Listing submitted and published.");
              // Identical to the previous wizard's path — open the listing the
              // manager just made rather than leaving them on a stage that no
              // longer holds the row (PRP-429).
              void refreshPending().then(() => {
                const id = listingId?.trim();
                if (!id) return;
                router.push(propertyDetailHref(basePath, "listed", id, "preview"), { scroll: false });
              });
            }}
            initialSubmission={resumeDraftRow?.submission ?? null}
            initialDraftId={resumeDraftId}
            showToast={showToast}
            userId={userId}
            skuTier={skuTier}
            propertyCount={propCount}
          />
        </ListingWizardOverlay>
      ) : wizardOpen && useV2Wizard === false ? (
        <ManagerAddListingForm
          key={resumeDraftId ?? "new-listing"}
          onClose={dismissFirstListingWizard}
          onSubmitted={(listingId) => {
            setWizardOpen(false);
            setResumeDraftId(null);
            showToast("Listing submitted and published.");
            // Open the listing the manager just made instead of leaving them on
            // whichever stage they started from — after publishing the seeded
            // draft that stage is Drafts, which no longer holds the row, so the
            // reward for finishing the wizard was an empty list (PRP-429). The
            // publish helpers force a pipeline sync before resolving, but the
            // local catalog is re-read here anyway before the push so the detail
            // page never renders against a stale snapshot.
            void refreshPending().then(() => {
              const id = listingId?.trim();
              if (!id) return;
              router.push(propertyDetailHref(basePath, "listed", id, "preview"), {
                scroll: false,
              });
            });
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
