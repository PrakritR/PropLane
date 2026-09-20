"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { CreateWorkspace } from "@/components/portal/listing-wizard-v2/create-workspace";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import {
  ManagerHousePropertiesPanel,
  MANAGER_STAGES,
  type ManagerStageKey,
} from "@/components/portal/pro-house-properties-panel";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { Share2 } from "lucide-react";
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
import { readAdminPropertyRows } from "@/lib/demo-admin-property-inventory";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";
import { resolveAddPropertyWorkspaceAction } from "@/lib/workspaces/add-property-gate";
import {
  countManagerManagedPropertiesForUser,
  mirrorLocalPropertyPipelineToServer,
  PROPERTY_PIPELINE_EVENT,
} from "@/lib/demo-property-pipeline";
import { collectLinkedPropertyIds, syncManagerPortfolioFromServer } from "@/lib/manager-portfolio-access";
import { accountLinksKnown, fetchAccountLinksCached, readCachedAccountLinkInvites } from "@/lib/portal-data-store";
import { hasIncomingAcceptedTeamLink } from "@/lib/workspace-co-manager-permissions";
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
  managerNeedsFirstListingOnboarding,
  markFirstListingWizardAutoOpened,
  markFirstListingWizardDismissed,
  readFirstListingPortfolioSnapshot,
  readFirstListingWizardAutoOpened,
  readFirstListingWizardDismissed,
  shouldAutoOpenFirstListingWizard,
  shouldSkipFirstListingOnboarding,
  takePendingFirstListingAutoOpen,
  writePendingFirstListingAutoOpen,
} from "@/lib/manager-first-listing-onboarding";

/**
 * Adding a property from a co-managed workspace was refused by the records API
 * (403 "Select an owned workspace before adding a property.") only AFTER the
 * manager filled in the whole form — the cause of the repeating save toast in
 * PLAN-0916-1119. The gate below switches to an owned workspace before the
 * editor opens; a switch remounts this page (WorkspaceProvider keys its
 * children on the active workspace id), so the intent to open Add is handed to
 * the fresh mount through sessionStorage, the same pattern the first-listing
 * auto-open uses across a stage-change remount.
 */
const PENDING_ADD_AFTER_SWITCH_KEY = "proplane:add-property-after-workspace-switch";
function writePendingAddAfterSwitch(userId: string | null) {
  try {
    if (userId) window.sessionStorage.setItem(PENDING_ADD_AFTER_SWITCH_KEY, userId);
  } catch {
    /* private mode / storage blocked — the switch still happens, just no auto-open */
  }
}
function takePendingAddAfterSwitch(userId: string | null): boolean {
  try {
    const pending = window.sessionStorage.getItem(PENDING_ADD_AFTER_SWITCH_KEY);
    if (pending && pending === userId) {
      window.sessionStorage.removeItem(PENDING_ADD_AFTER_SWITCH_KEY);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

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
  const workspaces = useWorkspaces();
  const { userId, email } = useManagerUserId();
  const scopeUserId = resolveManagerScopeUserId(userId);
  const [skuLoaded, setSkuLoaded] = useState(false);
  const [skuTier, setSkuTier] = useState<string | null>(null);
  const [propCount, setPropCount] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  /**
   * Create is one door: CreateWorkspace. `?wizard=v2` still opens it straight
   * away so review can skip the ADD affordance (which turns into a paywall
   * link at the plan limit). Publishing is still gated in useListingPersistence.
   *
   * Read from `window` rather than `useSearchParams` so this component does not
   * acquire a Suspense boundary it does not otherwise need.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("wizard") === "v2") setWizardOpen(true);
  }, []);
  /** Resume the seeded / first draft in the wizard (PRP-396). */
  const [resumeDraftId, setResumeDraftId] = useState<string | null>(null);
  /** The draft the open editor last wrote — where closing it lands. */
  const lastSavedDraftIdRef = useRef<string | null>(null);
  // The page that routed here from an empty /all handed over "open the seeded
  // draft" — take it exactly once, on the page that actually stays mounted.
  useEffect(() => {
    if (!userId) return;
    const pending = takePendingFirstListingAutoOpen(userId);
    if (!pending) return;
    setResumeDraftId(pending);
    setWizardOpen(true);
  }, [userId]);
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
  const [listSearch, setListSearch] = useState("");
  const [shareListingPropertyId, setShareListingPropertyId] = useState<string | undefined>();
  /** Several selected listings, for a bulk share from the Properties list (AXI-140). */
  const [shareListingPropertyIds, setShareListingPropertyIds] = useState<string[] | undefined>();
  const [demoStage, setDemoStage] = useState<ManagerStageKey>("all");
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
          !shouldSkipFirstListingOnboarding({
            email,
            incomingTeam: hasIncomingAcceptedTeamLink(readCachedAccountLinkInvites()),
          })
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
            incomingTeam: hasIncomingAcceptedTeamLink(readCachedAccountLinkInvites()),
            onError: (m) => showToast(`Could not start your first listing: ${m} Press Create to try again.`),
          });
          if (seeded) {
            setPropCount(countManagerManagedPropertiesForUser(scopeUserId));
            setPortfolioTick((t) => t + 1);
          }
          // Read AFTER any seed, and outside the `seeded` branch: an account
          // that already had a draft still needs to land on Drafts, and one
          // where seeding was declined must not be stranded on an empty Listed.
          const snap = readFirstListingPortfolioSnapshot(userId);
          const mustMoveToDrafts = linksKnown && !managerHasAnyListing(snap) && activeStage !== "drafts";
          const autoOpen =
            Boolean(seeded) &&
            shouldAutoOpenFirstListingWizard({
              snap,
              dismissed: readFirstListingWizardDismissed(userId),
              coManagerLinksKnown: linksKnown,
              autoOpenedThisSession: readFirstListingWizardAutoOpened(userId),
            });
          if (autoOpen && seeded) {
            // One shot per session — set BEFORE any navigation so the page that
            // mounts on Drafts cannot decide to open it a second time.
            markFirstListingWizardAutoOpened(userId);
          }
          if (mustMoveToDrafts) {
            // Moving stage remounts this page (`[stage]` is a dynamic segment),
            // so opening the wizard here would be undone by the router a frame
            // later and re-done by the fresh page — the open / close / open
            // flicker. Hand the intent to the page that will mount instead.
            if (autoOpen && seeded) writePendingFirstListingAutoOpen(userId, seeded.draftId);
            setActiveStage("drafts");
          } else if (autoOpen && seeded) {
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
    // The same rows the list renders, counted under the same workspace filter —
    // a badge that says "20" over an empty list was reading the whole account.
    // Index 5 is the drafts side bucket (see AdminPropertyBucketIndex).
    const inWorkspace = (bucket: 2 | 3 | 5) =>
      readAdminPropertyRows(bucket, scopeUserId).filter((row) =>
        workspaceContainsProperty(row.listingId?.trim() || row.adminRefId.trim()),
      ).length;
    const listed = inWorkspace(2);
    const unlisted = inWorkspace(3);
    const drafts = inWorkspace(5);
    return {
      all: listed + unlisted + drafts,
      listed,
      unlisted,
      drafts,
    } satisfies Record<ManagerStageKey, number>;
  }, [portfolioTick, scopeUserId]);

  const shareableProperties = useMemo(() => {
    void portfolioTick;
    return buildManagerShareablePropertyOptions(scopeUserId);
  }, [scopeUserId, portfolioTick]);

  const atPropertyLimit = skuLoaded && managerTierPropertyLimitReached(skuTier, propCount);
  const limitMax = maxPropertiesForManagerTier(skuTier);

  /** The checks both ＋ menu items share: plan loaded, signed in, under the limit. */
  const canOpenAdd = (): boolean => {
    if (!skuLoaded) {
      showToast("Loading subscription…");
      void loadSku();
      return false;
    }
    if (!scopeUserId) {
      showToast("Sign in to create a listing.");
      return false;
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
      return false;
    }
    return true;
  };
  /**
   * "Add property" clicked while workspaces are still loading, or while this
   * account owns none yet, is not a dead end — the manager gets told what is
   * happening and the click is replayed exactly once, the moment the
   * workspaces load (or the default one gets created). Shared by both the
   * `wait` and `no-owned` branches below.
   */
  const pendingAddRetryRef = useRef(false);
  /**
   * "Add property" can only save into a workspace the manager OWNS (the records
   * API refuses a co-managed one). Resolve that BEFORE the editor opens rather
   * than after the form is filled in. Returns true when the editor may open now.
   */
  const ensureOwnedWorkspaceForAdd = (): boolean => {
    const action = resolveAddPropertyWorkspaceAction(workspaces);
    switch (action.kind) {
      case "open":
        return true;
      case "wait":
        showToast("Loading your workspaces…");
        pendingAddRetryRef.current = true;
        return false;
      case "no-owned":
        if (workspaces && !workspaces.workspaces.some((w) => w.owned)) {
          // No workspace of any kind is owned yet — a brand-new account that
          // has not been given its default workspace. Create it rather than
          // stopping at a toast the manager has no way to act on.
          showToast("Setting up your workspace…");
          pendingAddRetryRef.current = true;
          void workspaces
            .mutate({ action: "initialize" })
            .then(() => {
              if (!pendingAddRetryRef.current) return;
              pendingAddRetryRef.current = false;
              tryOpenAdd();
            })
            .catch((e) => {
              pendingAddRetryRef.current = false;
              showToast(e instanceof Error ? e.message : "Could not set up your workspace.");
            });
          return false;
        }
        showToast("You need a workspace you own to add a property.");
        return false;
      case "switch":
        // Silent switch to the one owned workspace, then re-open Add on the
        // fresh mount the switch triggers.
        writePendingAddAfterSwitch(userId);
        void workspaces!.select(action.workspaceId, { href: false }).catch((e) => {
          takePendingAddAfterSwitch(userId);
          showToast(e instanceof Error ? e.message : "Could not switch workspace.");
        });
        return false;
      case "ask-pick":
        // Several owned workspaces: the manager chooses which. The switcher in
        // the sidebar / top bar is the one picker — point them at it rather than
        // opening an editor that cannot save here.
        showToast("Pick a workspace you own to add a property.");
        return false;
    }
  };

  const tryOpenAdd = () => {
    if (!canOpenAdd()) return;
    if (!ensureOwnedWorkspaceForAdd()) return;
    // Prefer resuming the first-listing draft when that is the only work left.
    const snap = readFirstListingPortfolioSnapshot(scopeUserId);
    if (
      managerNeedsFirstListingOnboarding(snap) &&
      !shouldSkipFirstListingOnboarding({
        email,
        incomingTeam: hasIncomingAcceptedTeamLink(readCachedAccountLinkInvites()),
      })
    ) {
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
  // "Add property" clicked mid-load is not a dead click: the workspaces
  // context finishing its load is the signal to replay the one queued intent.
  // The `no-owned` -> initialize path resolves its own retry directly off the
  // `mutate` promise (workspaces.loading never flips for it), so this effect
  // only needs to watch the load flag itself.
  useEffect(() => {
    if (!pendingAddRetryRef.current || !workspaces || workspaces.loading) return;
    pendingAddRetryRef.current = false;
    tryOpenAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces?.loading]);
  // After a workspace switch triggered by "Add property" from a co-managed
  // workspace, the page remounts under the now-owned workspace; re-open Add here
  // (once the plan tier is known so canOpenAdd can pass).
  const pendingAddAfterSwitchRef = useRef(false);
  useEffect(() => {
    if (userId && takePendingAddAfterSwitch(userId)) pendingAddAfterSwitchRef.current = true;
  }, [userId]);
  useEffect(() => {
    if (!pendingAddAfterSwitchRef.current || !skuLoaded) return;
    pendingAddAfterSwitchRef.current = false;
    tryOpenAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuLoaded]);
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
      onClearSearch={() => setListSearch("")}
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
              hideTitleOnMobileNav
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
            search={{
              value: listSearch,
              onChange: setListSearch,
              placeholder: "Search properties",
              dataAttr: "manager-properties-search",
            }}
            actions={
              <>
                <PortalIconAction
                  icon={Share2}
                  label="Share listing link"
                  data-attr="manager-properties-share-open"
                  onClick={() => openShareListing()}
                />
              </>
            }
            primary={
              /*
               * One door in. Create opens the listing editor; importing a file
               * is a strip at the top of its Basics step, so there is no menu
               * and no second workspace to choose between.
               */
              <PortalPrimaryIconAction
                label="Create"
                disabled={!skuLoaded}
                data-attr="manager-properties-add-top"
                onClick={tryOpenAdd}
              />
            }
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
      {wizardOpen ? (
        /*
         * The redesigned listing workspace — a step rail, the form, and a panel
         * that shows what the manager just changed. It writes the same
         * submission shape as the original form, so a draft saved in either
         * opens in the other. A file dropped on its Basics step turns the same
         * workspace into the import: one draft per property the file held.
         */
        <ListingWizardOverlay>
          <CreateWorkspace
            onClose={() => {
              // Closing a NEW property opens that property, exactly as Publish
              // does — a manager who just made a home expects to land in it,
              // not back on a list that may not even show it yet.
              dismissFirstListingWizard();
              const id = lastSavedDraftIdRef.current?.trim();
              lastSavedDraftIdRef.current = null;
              void refreshPending().then(() => {
                if (!id) return;
                router.push(propertyDetailHref(basePath, "drafts", id, "preview"), { scroll: false });
              });
            }}
            onDraftsChanged={() => {
              void refreshPending();
            }}
            onSaved={(_sub, savedId) => {
              // The editor saves on ✕ (and on Review Save / Publish), never on a
              // typing timer. A save never closes it. The id is kept for when the
              // close callback fires so it lands on the right draft.
              if (savedId?.trim()) lastSavedDraftIdRef.current = savedId.trim();
              void refreshPending();
            }}
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
