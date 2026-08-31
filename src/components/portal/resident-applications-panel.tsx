"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { CosignerInviteCallout } from "@/components/marketing/cosigner-invite-callout";
import { GroupShareCallout } from "@/components/marketing/rental-application-finish-panel";
import { PublicApplyAccountPrompt } from "@/components/marketing/public-apply-account-prompt";
import { SignedInResidentAccountPrompt } from "@/components/marketing/signed-in-resident-account-prompt";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_PRIMARY_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { DataList } from "@/components/ui/data-list";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PortalDataTableEmpty,
  PORTAL_DETAIL_BTN,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
} from "@/components/portal/portal-data-table";
import { Badge } from "@/components/ui/badge";
import { ApplicationDocumentPreview } from "@/components/portal/manager-applications";
import {
  ApplicationCosignerListRow,
  ApplicationCosignerSection,
  ApplicationHouseholdCluster,
  ApplicationNestedListRow,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
import {
  groupIdForRow,
  groupRowInputForRow,
} from "@/components/portal/application-group-section";
import { ManagerCosignerReadonlyReview } from "@/components/portal/manager-cosigner-readonly-review";
import { useCosignerSubmissionsMap } from "@/hooks/use-cosigner-submissions-map";
import { buildApplicationGroups, describeGroupBadge, groupForRow, type ApplicationGroupMember } from "@/lib/rental-application/application-groups";
import {
  applicationListSortBucket,
  buildApplicationListClusters,
  orderApplicationRowsWithHouseholds,
  signerAppIdsForCosignerLookup,
} from "@/lib/rental-application/application-list-grouping";
import { ResidentApplicationEditor } from "@/components/portal/resident-application-editor";
import { PropertySearchPicker, type PropertySearchOption } from "@/components/marketing/property-search-picker";
import {
  isPropertyActiveForLeads,
  loadPublicExtraListingsFromServer,
  loadPublicPropertyLeadFromServer,
  readExtraListingsPublic,
} from "@/lib/demo-property-pipeline";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";
import { filterSandboxFromPublicCatalog } from "@/lib/public-sandbox-listings";
import { isProductionPublicSite } from "@/lib/public-demo-access";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  hasPublicApplyGuestContinue,
  markPublicApplyGuestContinue,
  publicApplyGateKey,
  publicApplyReturnPath,
  resolvePublicApplyView,
} from "@/lib/rental-application/public-apply-session";
import type { DemoApplicantRow, ManagerApplicationBucket } from "@/data/demo-portal";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  DEMO_APPLICATION_SUBMITTED_EVENT,
  DEMO_CLOSE_RESIDENT_APPLY_EVENT,
  DEMO_OPEN_RESIDENT_APPLY_EVENT,
} from "@/lib/demo/demo-playback";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  MANAGER_APPLICATIONS_EVENT,
  cancelPendingApplicationRowUpsert,
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { clearRentalWizardDraft, loadRentalWizardDraft, loadRentalWizardDraftAxisId, saveRentalWizardDraft, saveRentalWizardDraftAxisId } from "@/lib/rental-application/drafts";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { getRoomChoiceLabel, parseRoomChoiceValue } from "@/lib/rental-application/data";
import {
  applicationStageDisplayLabel,
  applicationStartedLabel,
  findInProgressRowForTarget,
  isInProgressApplicationRow,
  switchApplicationTargetProperty,
  type ApplicationRequestTarget,
} from "@/lib/rental-application/in-progress-application";
import {
  canResidentWithdrawApplication,
  isWithdrawnApplicationRow,
  sortResidentApplicationRows,
} from "@/lib/rental-application/resident-application-list";
import { applicantDisplayName, realApplicantName } from "@/lib/rental-application/applicant-name";
import { residentOwnsApplicationRow } from "@/lib/rental-application/resident-application-ownership";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import { residentBrowseFromApplicationHref } from "@/lib/resident-public-nav";
import {
  residentApplicationDetailHref,
  residentApplicationListHref,
  type ResidentApplicationBucketId,
} from "@/lib/portal-detail-routes";
import { ResidentApplicationWorkspaceActions } from "@/components/portal/resident-application-workspace";
import { buildResidentApplicationWorkspaceState } from "@/lib/rental-application/resident-application-workspace";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";

function countByBucket(rows: DemoApplicantRow[]) {
  return rows.reduce(
    (acc, row) => {
      acc[row.bucket] += 1;
      return acc;
    },
    { pending: 0, approved: 0, rejected: 0 } as Record<ManagerApplicationBucket, number>,
  );
}

function displayRoomForRow(row: DemoApplicantRow): string {
  const raw = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  if (!raw) return "—";
  const full = getRoomChoiceLabel(raw);
  return full.split(" · ")[0]?.trim() || full || "—";
}

function rowStatusLabel(row: DemoApplicantRow): string {
  if (row.bucket === "approved") return "Approved";
  if (row.bucket === "rejected") return "Rejected";
  if (isWithdrawnApplicationRow(row)) return "Withdrawn";
  return applicationStageDisplayLabel(row);
}

/** Inline server PDF for submitted, approved, and rejected applications. */
function ResidentApplicationPdfFrame({
  row,
  groupMembers = [],
}: {
  row: DemoApplicantRow;
  groupMembers?: ApplicationGroupMember[];
}) {
  return (
    <ApplicationDocumentPreview
      row={row}
      collapsible={false}
      showDownload
      variant="pdf"
      downloadPlacement="bottom"
      groupMembers={groupMembers}
    />
  );
}

function ResidentApplicationDetailWizard({
  row,
  sessionEmail,
  showToast,
  exitPath,
  applyPath,
}: {
  row: DemoApplicantRow;
  sessionEmail?: string;
  showToast: (message: string) => void;
  exitPath: string;
  applyPath: string;
}) {
  const propertyId = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const [propertyReady, setPropertyReady] = useState(!propertyId);

  useEffect(() => {
    const axisId = normalizeApplicationAxisId(row.id);
    const currentAxisId = loadRentalWizardDraftAxisId()?.trim();
    if (currentAxisId && normalizeApplicationAxisId(currentAxisId) !== axisId) {
      clearRentalWizardDraft();
    }
    saveRentalWizardDraftAxisId(axisId);
    if (row.application) {
      const email = (sessionEmail ?? row.application.email ?? row.email ?? "").trim().toLowerCase();
      saveRentalWizardDraft({
        ...createInitialRentalWizardState(),
        ...row.application,
        email,
      });
    }
  }, [row, sessionEmail]);

  useEffect(() => {
    if (!propertyId) {
      setPropertyReady(true);
      return;
    }
    let cancelled = false;
    void loadPublicPropertyLeadFromServer(propertyId).finally(() => {
      if (!cancelled) setPropertyReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  if (!propertyReady) {
    return <p className="text-sm text-muted">Loading application…</p>;
  }

  return (
    <RentalApplicationWizard
      showToast={showToast}
      mode="portal"
      layout="embedded"
      exitPath={exitPath}
      applyPath={applyPath}
      sessionEmail={sessionEmail}
      linkedPropertyId={propertyId || undefined}
    />
  );
}

function continueApplicationPath(row: DemoApplicantRow): string {
  const pid = row.propertyId?.trim() || row.application?.propertyId?.trim();
  if (!pid) return `${RESIDENT_PORTAL_BASE_PATH}/applications/apply`;
  const params = new URLSearchParams({ propertyId: pid });
  // Carry the row's own room/bundle so re-entering the wizard resolves back to
  // THIS specific in-progress application, not a different draft on the same property.
  const bundleId = row.application?.bundleId?.trim();
  if (bundleId) {
    params.set("bundle", bundleId);
  } else {
    const roomChoice = row.application?.roomChoice1?.trim();
    const listingRoomId = roomChoice ? parseRoomChoiceValue(roomChoice).listingRoomId : undefined;
    if (listingRoomId) params.set("listingRoomId", listingRoomId);
  }
  return `${RESIDENT_PORTAL_BASE_PATH}/applications/apply?${params.toString()}`;
}

export function ResidentApplicationsPanel({
  embedded = false,
  applyMode: applyModeProp = false,
  bucket: bucketProp = "pending",
  applicationId: applicationIdProp,
  basePath = RESIDENT_PORTAL_BASE_PATH,
  signedInNonResident = false,
  hasResidentRole = true,
}: {
  embedded?: boolean;
  applyMode?: boolean;
  bucket?: ManagerApplicationBucket;
  applicationId?: string;
  basePath?: string;
  /** Signed-in manager/vendor on the apply gate — server-resolved. */
  signedInNonResident?: boolean;
  /** Caller holds the resident role — skip the account gate. */
  hasResidentRole?: boolean;
} = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { email: sessionEmail, userId: sessionUserId, ready: sessionReady } = usePortalSession();
  const searchParams = useSearchParams();
  const portalNavigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const demoMode = isDemoModeActive();
  const residentEmail = (sessionEmail ?? "").trim().toLowerCase();
  const [demoApplyOpen, setDemoApplyOpen] = useState(false);
  const [demoApplyPropertyId, setDemoApplyPropertyId] = useState<string | undefined>();
  const applyMode =
    applyModeProp ||
    pathname.startsWith(`${RESIDENT_PORTAL_BASE_PATH}/applications/apply`) ||
    (demoMode && demoApplyOpen);
  const [tick, setTick] = useState(0);
  const [bucket, setBucket] = useState<ManagerApplicationBucket>(bucketProp);
  const [prevBucketProp, setPrevBucketProp] = useState(bucketProp);
  if (bucketProp !== prevBucketProp) {
    setPrevBucketProp(bucketProp);
    setBucket(bucketProp);
  }
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The ONE row this apply session's inline wizard is bound to — the row the
  // auto-expand effect resolved for the URL target (or the sole bare-/apply
  // draft). `expandedId` is NOT that identity: it follows every manual click,
  // and the wizard always binds to the URL target, so rendering it under any
  // other expanded in-progress row would show the WRONG application's wizard
  // beneath that row's header.
  const [wizardRowId, setWizardRowId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<DemoApplicantRow | null>(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [fetchedDetailRow, setFetchedDetailRow] = useState<DemoApplicantRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Inline "Apply to a property" picker: choosing which property to apply for
  // happens in place (a searchable modal), then the wizard opens INLINE under
  // its own row in this same list — no round-trip out to the browse page.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedPropertyId, setPickedPropertyId] = useState<string | null>(null);
  const openHandled = useRef(false);
  // Which application the apply-mode auto-expand has already opened. Guards the
  // effect so it fires ONCE per resolved id and never re-snaps: a background
  // sync tick rebuilds `rows` (new object refs), and without this guard the
  // effect re-fired and dragged the expansion back onto its target — hijacking
  // clicks on every OTHER row (the "clicking row 2/3 opens row 1" bug).
  const autoExpandedApplyIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionReady) return;
    const on = () => setTick((t) => t + 1);
    void syncManagerApplicationsFromServer({ force: true, selfScope: true }).then(on);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, on);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, on);
  }, [sessionReady]);

  useEffect(() => {
    if (!applicationIdProp) return;
    const refresh = () => {
      void syncManagerApplicationsFromServer({ force: true, selfScope: true }).then(() => setTick((t) => t + 1));
    };
    const interval = window.setInterval(refresh, 30_000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [applicationIdProp]);

  useEffect(() => {
    if (!demoMode) return;
    const closeApply = () => {
      setDemoApplyOpen(false);
      setDemoApplyPropertyId(undefined);
      setTick((t) => t + 1);
    };
    const onOpen = (e: Event) => {
      const propertyId = (e as CustomEvent<{ propertyId?: string }>).detail?.propertyId?.trim();
      setDemoApplyPropertyId(propertyId || undefined);
      setDemoApplyOpen(true);
    };
    window.addEventListener(DEMO_OPEN_RESIDENT_APPLY_EVENT, onOpen as EventListener);
    window.addEventListener(DEMO_CLOSE_RESIDENT_APPLY_EVENT, closeApply);
    window.addEventListener(DEMO_APPLICATION_SUBMITTED_EVENT, closeApply);
    return () => {
      window.removeEventListener(DEMO_OPEN_RESIDENT_APPLY_EVENT, onOpen as EventListener);
      window.removeEventListener(DEMO_CLOSE_RESIDENT_APPLY_EVENT, closeApply);
      window.removeEventListener(DEMO_APPLICATION_SUBMITTED_EVENT, closeApply);
    };
  }, [demoMode]);

  // Hydrate the public listing catalog the inline picker reads. The resident
  // portal doesn't otherwise load it (that used to be the browse page's job),
  // so without this the "Apply to a property" picker would be empty. The loader
  // is in-flight-guarded + CDN-cached, and re-renders options via the pipeline
  // event once listings land.
  useEffect(() => {
    if (!pickerOpen) return;
    void loadPublicExtraListingsFromServer();
    const on = () => setTick((t) => t + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [pickerOpen]);

  const rows = useMemo(() => {
    void tick;
    if (!residentEmail) return [];
    // A withdrawn application leaves the resident's active list (the manager keeps it).
    return sortResidentApplicationRows(
      readManagerApplicationRows().filter(
        (row) =>
          residentOwnsApplicationRow(row, { email: residentEmail, userId: sessionUserId }) &&
          !isWithdrawnApplicationRow(row),
      ),
    );
  }, [residentEmail, sessionUserId, tick]);

  // What this /apply request is actually asking for, so an in-progress
  // application for a DIFFERENT property (or a different room in the same
  // property) never hijacks the view meant for this one.
  const applyTarget = useMemo<ApplicationRequestTarget | null>(() => {
    const propertyId = (searchParams.get("propertyId") ?? "").trim();
    if (!propertyId) return null;
    return {
      propertyId,
      listingRoomId: (searchParams.get("listingRoomId") ?? "").trim() || undefined,
      bundleId: (searchParams.get("bundle") ?? "").trim() || undefined,
    };
  }, [searchParams]);

  const inProgressRow = useMemo(
    () => findInProgressRowForTarget(rows, applyTarget),
    [rows, applyTarget],
  );

  // `applyTarget` is a snapshot of the URL at load time and never changes as the
  // resident edits the wizard, but `inProgressRow` is recomputed from it on every
  // render — so the moment the resident picks a DIFFERENT room than the one the
  // URL named (or clears a bundle choice, etc.), `targetMatchesApplication` stops
  // matching and `inProgressRow` goes from "this row" to `undefined`, even though
  // it's still the exact same in-progress application, just with an updated room.
  // Once the auto-expand effect below has locked the wizard onto a row
  // (`wizardRowId`), keep trusting that lock instead of re-deriving the identity
  // from the stale target — otherwise the standalone `applyMode &&
  // !inProgressRow` branch below thinks there is suddenly no in-progress
  // application and mounts a SECOND, brand-new `RentalApplicationWizard` (fresh
  // `step` state, no draft) alongside the one already embedded in the expanded
  // row: the "glitches back to the start" bug, and the two instances'
  // un-coordinated syncs are why the room could also land on the server as
  // blank. See `tests/unit/resident-applications-room-change.test.tsx`.
  const lockedInProgressRow = useMemo(
    () => (wizardRowId ? rows.find((row) => row.id === wizardRowId && isInProgressApplicationRow(row)) : undefined),
    [rows, wizardRowId],
  );
  const activeInProgressRow = lockedInProgressRow ?? inProgressRow;

  const rentalTypeParam = searchParams.get("rentalType")?.trim();
  const rentalType = rentalTypeParam === "short_term" ? ("short_term" as const) : undefined;

  const applyGateKey = useMemo(
    () =>
      applyTarget
        ? publicApplyGateKey({
            propertyId: applyTarget.propertyId,
          })
        : "",
    [applyTarget],
  );

  const applyReturnPath = useMemo(
    () =>
      applyTarget
        ? publicApplyReturnPath({
            propertyId: applyTarget.propertyId,
            rentalType,
            listingRoomId: applyTarget.listingRoomId,
            bundleId: applyTarget.bundleId,
          })
        : "",
    [applyTarget, rentalType],
  );

  const [guestBypass, setGuestBypass] = useState(false);
  const [guestContinuedInSession, setGuestContinuedInSession] = useState(false);

  useEffect(() => {
    if (!applyGateKey) {
      setGuestContinuedInSession(false);
      return;
    }
    setGuestContinuedInSession(hasPublicApplyGuestContinue(applyGateKey));
  }, [applyGateKey]);

  const continueApplyAsGuest = useCallback(() => {
    if (applyGateKey) markPublicApplyGuestContinue(applyGateKey);
    setGuestBypass(true);
  }, [applyGateKey]);

  const guestContinue = !applyGateKey || guestBypass || guestContinuedInSession;

  const applyView = useMemo(
    () =>
      resolvePublicApplyView({
        gateKey: applyGateKey,
        guestContinue,
        signedInNonResident,
        hasResidentRole,
      }),
    [applyGateKey, guestContinue, signedInNonResident, hasResidentRole],
  );

  const applyPropertyTitle = useMemo(() => {
    if (!applyTarget?.propertyId) return undefined;
    return getPropertyById(applyTarget.propertyId)?.title?.trim();
  }, [applyTarget, tick]);

  const counts = useMemo(() => countByBucket(rows), [rows]);
  const tabs = useMemo(
    () =>
      [
        { id: "pending" as const, label: "Pending", count: counts.pending },
        { id: "approved" as const, label: "Approved", count: counts.approved },
        { id: "rejected" as const, label: "Rejected", count: counts.rejected },
      ] as const,
    [counts],
  );

  const rowsForBucket = useMemo(() => rows.filter((row) => row.bucket === bucket), [rows, bucket]);

  const filteredRowsForBucket = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rowsForBucket;
    return rowsForBucket.filter((row) => {
      const hay = [
        row.name,
        row.property,
        row.id,
        displayRoomForRow(row),
        rowStatusLabel(row),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rowsForBucket, searchQuery]);

  const applicationGroups = useMemo(
    () => buildApplicationGroups(rows.map(groupRowInputForRow)),
    [rows],
  );

  const listSortBucket = applicationListSortBucket(bucket);

  const detailRow = applicationIdProp
    ? rows.find(
        (row) =>
          normalizeApplicationAxisId(row.id).toUpperCase() ===
          normalizeApplicationAxisId(applicationIdProp).toUpperCase(),
      ) ?? fetchedDetailRow
    : undefined;

  useEffect(() => {
    if (!applicationIdProp || !sessionReady) return;
    const normalizedTarget = normalizeApplicationAxisId(applicationIdProp).toUpperCase();
    const cached = rows.find(
      (row) => normalizeApplicationAxisId(row.id).toUpperCase() === normalizedTarget,
    );
    if (cached) {
      setFetchedDetailRow(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/manager-applications?scope=self", { credentials: "include" });
        if (!res.ok || cancelled) return;
        const body = (await res.json().catch(() => null)) as { rows?: DemoApplicantRow[] } | null;
        const hit = (body?.rows ?? []).find(
          (row) => normalizeApplicationAxisId(row.id).toUpperCase() === normalizedTarget,
        );
        if (!hit || cancelled) return;
        replaceManagerApplicationRowInCache(hit);
        setFetchedDetailRow(hit);
        setTick((t) => t + 1);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationIdProp, rows, sessionReady]);

  useEffect(() => {
    if (!detailRow || !applicationIdProp) return;
    const actualBucket = detailRow.bucket;
    if (
      actualBucket !== bucket &&
      (actualBucket === "pending" || actualBucket === "approved" || actualBucket === "rejected")
    ) {
      router.replace(residentApplicationDetailHref(basePath, actualBucket as ResidentApplicationBucketId, detailRow.id));
    }
  }, [applicationIdProp, basePath, bucket, detailRow, router]);

  const cosignerSignerIds = useMemo(() => {
    const ids = signerAppIdsForCosignerLookup(rowsForBucket);
    if (detailRow?.application?.hasCosigner === "yes" && !ids.includes(detailRow.id)) {
      return [...ids, detailRow.id];
    }
    return ids;
  }, [rowsForBucket, detailRow]);
  const cosignerSubmissionsBySigner = useCosignerSubmissionsMap(cosignerSignerIds);

  const cosignerIndexParam = searchParams.get("cosigner");
  const activeCosignerIndex =
    cosignerIndexParam != null && /^\d+$/.test(cosignerIndexParam) ? parseInt(cosignerIndexParam, 10) : null;
  const detailCosignerSubmissions = useMemo(() => {
    if (!detailRow) return [];
    const key = normalizeApplicationAxisId(detailRow.id).toUpperCase();
    return cosignerSubmissionsBySigner.get(key) ?? [];
  }, [detailRow, cosignerSubmissionsBySigner]);
  const activeCosignerSubmission =
    activeCosignerIndex != null && activeCosignerIndex >= 0 && activeCosignerIndex < detailCosignerSubmissions.length
      ? detailCosignerSubmissions[activeCosignerIndex]!
      : null;

  const listClustersForRows = useCallback(
    (listRows: DemoApplicantRow[]) =>
      buildApplicationListClusters(
        orderApplicationRowsWithHouseholds(listRows, listSortBucket),
        applicationGroups,
        listSortBucket,
      ),
    [applicationGroups, listSortBucket],
  );

  // Active public listings the resident can apply for — the same catalog the
  // wizard's own property picker reads, surfaced up here so property choice can
  // happen inline instead of on the separate browse page.
  const propertyPickerOptions = useMemo<PropertySearchOption[]>(() => {
    void tick;
    if (!pickerOpen) return [];
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
  }, [pickerOpen, tick]);

  const workspace = useMemo(
    () => buildResidentApplicationWorkspaceState(rows, applyTarget),
    [rows, applyTarget],
  );

  const openPropertyPicker = () => {
    setPickedPropertyId(null);
    void loadPublicExtraListingsFromServer();
    setPickerOpen(true);
  };

  const abandonInProgressRow = (row: DemoApplicantRow) => {
    cancelPendingApplicationRowUpsert(row.id);
    const draftAxisId = loadRentalWizardDraftAxisId();
    if (draftAxisId && normalizeApplicationAxisId(draftAxisId) === normalizeApplicationAxisId(row.id)) {
      clearRentalWizardDraft();
    }
    replaceManagerApplicationRowInCache({ ...row, withdrawnAt: new Date().toISOString() });
    if (expandedId === row.id) setExpandedId(null);
    if (wizardRowId === row.id) setWizardRowId(null);
    if (editingId === row.id) setEditingId(null);
    autoExpandedApplyIdRef.current = null;
    setTick((t) => t + 1);
  };

  const startApplicationForProperty = (propertyId: string) => {
    const pid = propertyId.trim();
    if (!pid) return;
    setPickerOpen(false);
    setPickedPropertyId(null);

    const inProgressRows = rows.filter(isInProgressApplicationRow);
    const existingForProperty = findInProgressRowForTarget(inProgressRows, { propertyId: pid });
    const draft = loadRentalWizardDraft();
    const previousPropertyId = draft?.propertyId?.trim() || "";

    if (existingForProperty?.application) {
      saveRentalWizardDraftAxisId(existingForProperty.id);
      saveRentalWizardDraft({
        ...createInitialRentalWizardState(),
        ...existingForProperty.application,
        email: (sessionEmail ?? existingForProperty.application.email ?? existingForProperty.email ?? "").trim().toLowerCase(),
      });
    } else if (previousPropertyId && previousPropertyId !== pid) {
      switchApplicationTargetProperty({
        previousPropertyId,
        nextPropertyId: pid,
        inProgressRows,
      });
    }

    if (demoMode) {
      setDemoApplyPropertyId(pid);
      setDemoApplyOpen(true);
      return;
    }
    portalNavigate(`${RESIDENT_PORTAL_BASE_PATH}/applications/apply?propertyId=${encodeURIComponent(pid)}`);
  };

  const openApplicationRow = useCallback(
    (row: DemoApplicantRow) => {
      portalNavigate(
        residentApplicationDetailHref(basePath, row.bucket as ResidentApplicationBucketId, row.id),
      );
    },
    [basePath, portalNavigate],
  );

  // A resident with zero applications is deliberately NOT auto-redirected into
  // the apply flow. The list page — with its always-visible "Apply to a property"
  // header action and the "No applications yet" empty state — must render
  // regardless of how many applications exist or their status; bouncing an empty
  // list straight to /apply is exactly what hid the entry point the captain
  // reported missing. Starting an application is always an explicit click.

  // The wizard-row lock belongs to ONE apply target. When the resident starts
  // an application for a DIFFERENT property (the inline picker navigates to a
  // new ?propertyId), release the lock so the standalone wizard can mount for
  // the new target instead of staying pinned to the previous application. Keyed
  // on the target's VALUES, not the `applyTarget` object — the wizard's own
  // `?wizardStep=` URL writes re-mint `searchParams` (and therefore the memo)
  // without changing the target.
  const applyTargetKey = applyTarget
    ? [applyTarget.propertyId, applyTarget.listingRoomId ?? "", applyTarget.bundleId ?? ""].join("|")
    : "";
  const applyTargetKeyRef = useRef(applyTargetKey);
  useEffect(() => {
    if (applyTargetKeyRef.current === applyTargetKey) return;
    applyTargetKeyRef.current = applyTargetKey;
    autoExpandedApplyIdRef.current = null;
    setWizardRowId(null);
  }, [applyTargetKey]);

  useEffect(() => {
    if (!applyMode) return;
    // Auto-open ONLY the application this apply session is actually for:
    //  - a propertyId in the apply URL -> the in-progress row matching it
    //    (Continue / the inline "Apply to a property" flow);
    //  - a bare /apply with exactly ONE in-progress draft -> resume that draft.
    // With several in-progress drafts and no target we open NONE — picking an
    // arbitrary "first" is exactly what hijacked clicks on every other row and
    // let withdraw/edit hit the WRONG application. The ref makes it fire once
    // per resolved id so a sync tick can never re-snap over a row the resident
    // opened by hand.
    const inProgress = rows.filter(isInProgressApplicationRow);
    const targetRow = applyTarget?.propertyId.trim()
      ? findInProgressRowForTarget(rows, applyTarget)
      : inProgress.length === 1
        ? inProgress[0]
        : undefined;
    if (!targetRow || autoExpandedApplyIdRef.current === targetRow.id) return;
    autoExpandedApplyIdRef.current = targetRow.id;
    queueMicrotask(() => {
      setBucket("pending");
      setWizardRowId(targetRow.id);
      portalNavigate(residentApplicationDetailHref(basePath, "pending", targetRow.id));
    });
  }, [applyMode, applyTarget, basePath, portalNavigate, rows]);

  useEffect(() => {
    if (openHandled.current || rows.length === 0) return;
    const raw = (searchParams.get("open") ?? searchParams.get("axisId") ?? "").trim();
    if (!raw) return;
    const id = normalizeApplicationAxisId(raw).toUpperCase();
    const hit = rows.find((row) => normalizeApplicationAxisId(row.id).toUpperCase() === id);
    if (!hit) return;
    openHandled.current = true;
    queueMicrotask(() => {
      setBucket(hit.bucket);
      portalNavigate(residentApplicationDetailHref(basePath, hit.bucket as ResidentApplicationBucketId, hit.id));
    });
  }, [basePath, portalNavigate, rows, searchParams]);

  const confirmWithdraw = async () => {
    const row = withdrawTarget;
    if (!row || withdrawBusy) return;
    setWithdrawBusy(true);
    try {
      const res = await fetch("/api/manager-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "withdraw", id: row.id }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      // A 404 means the server has no record to stamp yet — a brand-new
      // in-progress draft whose background snapshot hasn't landed. The resident's
      // intent is still "remove this from my list", so honor it locally instead
      // of stranding the row (this is the "withdraw does nothing on my only
      // application" case). Any other failure is a real error.
      if ((!res.ok || !body?.ok) && res.status !== 404) {
        showToast(body?.error ?? "Could not withdraw application.");
        return;
      }
      // Reflect the withdrawal locally so the row leaves the active list
      // immediately. Removal is durable without a sticky merge: the withdraw
      // route persisted `withdrawnAt` (GET returns it), the union merge keeps a
      // local-only 404 row, and withdrawn rows are excluded from the apply
      // resume comparator. Drop any queued autosave for this id first so a
      // pre-withdraw snapshot can't land after the stamp and revive the row.
      cancelPendingApplicationRowUpsert(row.id);
      replaceManagerApplicationRowInCache({ ...row, withdrawnAt: new Date().toISOString() });
      // Withdrawal is FINAL for the applicant: if the local wizard draft belongs
      // to this application, drop it (and its axis id) so a later reapply to the
      // same property starts genuinely fresh — no revived row, no leftover
      // answers. The manager keeps the withdrawn record on their side.
      const draftAxisId = loadRentalWizardDraftAxisId();
      if (draftAxisId && normalizeApplicationAxisId(draftAxisId) === normalizeApplicationAxisId(row.id)) {
        clearRentalWizardDraft();
      }
      if (expandedId === row.id) setExpandedId(null);
      if (editingId === row.id) setEditingId(null);
      if (wizardRowId === row.id) setWizardRowId(null);
      autoExpandedApplyIdRef.current = null;
      setFetchedDetailRow(null);
      setWithdrawTarget(null);
      setTick((t) => t + 1);
      showToast("Application withdrawn. Your property manager still has the record.");
      if (applicationIdProp || applyMode) {
        portalNavigate(residentApplicationListHref(basePath, row.bucket as ResidentApplicationBucketId));
      }
    } catch {
      showToast("Could not withdraw application.");
    } finally {
      setWithdrawBusy(false);
    }
  };

  const withdrawModal = (
    <Modal
      open={withdrawTarget !== null}
      title="Withdraw application"
      onClose={() => (withdrawBusy ? undefined : setWithdrawTarget(null))}
      panelClassName="max-w-md"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Withdrawing removes this application from your list. Your property manager keeps the record
          {withdrawTarget?.property ? ` for ${withdrawTarget.property}` : ""} and its history. Withdrawal is
          final for this application: applying to the same home again starts a brand-new application.
        </p>
        <div className="flex justify-start gap-2">
          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            onClick={() => setWithdrawTarget(null)}
            disabled={withdrawBusy}
          >
            Keep application
          </Button>
          <Button
            type="button"
            variant="danger"
            className="rounded-full"
            data-attr="resident-application-withdraw-confirm"
            onClick={() => confirmWithdraw()}
            disabled={withdrawBusy}
          >
            {withdrawBusy ? "Withdrawing…" : "Withdraw application"}
          </Button>
        </div>
      </div>
    </Modal>
  );

  const propertyPickerModal = (
    <Modal
      open={pickerOpen}
      title="Apply to a property"
      onClose={() => setPickerOpen(false)}
      panelClassName="max-w-lg"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Choose the home you want to apply for. Your application opens right here in your list — you can add
          another property anytime.
        </p>
        <PropertySearchPicker
          options={propertyPickerOptions}
          value={pickedPropertyId}
          onChange={setPickedPropertyId}
          placeholder="Search by address, neighborhood, or property name…"
          emptyMessage="No properties match your search."
          listEmptyMessage="No properties are available to apply for right now."
          ariaLabel="Search properties to apply for"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            className="rounded-full px-4 text-[13px]"
            data-attr="resident-applications-browse-homes"
            onClick={() => {
              setPickerOpen(false);
              portalNavigate(residentBrowseFromApplicationHref());
            }}
          >
            Browse homes
          </Button>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            data-attr="resident-applications-start"
            disabled={!pickedPropertyId}
            onClick={() => pickedPropertyId && startApplicationForProperty(pickedPropertyId)}
          >
            Start application
          </Button>
        </div>
      </div>
    </Modal>
  );

  const embeddedWizard = (
    <RentalApplicationWizard
      showToast={showToast}
      mode="portal"
      layout="embedded"
      exitPath={`${RESIDENT_PORTAL_BASE_PATH}/applications`}
      sessionEmail={sessionEmail ?? undefined}
      linkedPropertyId={applyTarget?.propertyId ?? demoApplyPropertyId}
    />
  );

  const renderStandaloneApplySurface = () => {
    if (!applyMode || activeInProgressRow || !applyTarget) return null;

    if (applyView !== "wizard") {
      return (
        <div className="mx-auto w-full max-w-3xl py-4 sm:py-8">
          {applyView === "signed-in-create-resident" ? (
            <SignedInResidentAccountPrompt
              gateKey={applyGateKey}
              applyReturnPath={applyReturnPath}
              propertyTitle={applyPropertyTitle}
              onContinueGuest={continueApplyAsGuest}
            />
          ) : (
            <PublicApplyAccountPrompt
              gateKey={applyGateKey}
              applyReturnPath={applyReturnPath}
              propertyTitle={applyPropertyTitle}
              onContinueGuest={continueApplyAsGuest}
            />
          )}
        </div>
      );
    }

    return <div className={PORTAL_DATA_TABLE_WRAP}>{embeddedWizard}</div>;
  };

  const renderDetailActions = (row: DemoApplicantRow) => (
    <PortalSectionActionRow variant="header">
      {isInProgressApplicationRow(row) && !applicationIdProp ? (
        <Button
          type="button"
          variant="primary"
          className={PORTAL_DETAIL_BTN}
          onClick={() => portalNavigate(continueApplicationPath(row))}
        >
          Continue application
        </Button>
      ) : row.bucket === "pending" && row.application && !isInProgressApplicationRow(row) ? (
        <Button
          type="button"
          variant="primary"
          className={PORTAL_DETAIL_BTN}
          onClick={() => setEditingId(row.id)}
        >
          Edit application
        </Button>
      ) : null}
      {canResidentWithdrawApplication(row) ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          data-attr="resident-application-withdraw"
          onClick={() => setWithdrawTarget(row)}
        >
          Withdraw application
        </Button>
      ) : null}
    </PortalSectionActionRow>
  );

  const renderApplicationDetailBody = (row: DemoApplicantRow) => {
    if (editingId === row.id && row.bucket === "pending" && row.application && !isInProgressApplicationRow(row)) {
      return (
        <div className="mx-auto w-full max-w-5xl">
          <ResidentApplicationEditor
            row={row}
            residentEmail={residentEmail}
            onCancel={() => setEditingId(null)}
            onSaved={() => {
              setEditingId(null);
              setTick((t) => t + 1);
            }}
          />
        </div>
      );
    }
    if (isInProgressApplicationRow(row)) {
      return (
        <div className="mx-auto w-full max-w-5xl">
          <ResidentApplicationDetailWizard
            row={row}
            sessionEmail={sessionEmail ?? undefined}
            showToast={showToast}
            exitPath={residentApplicationListHref(basePath, row.bucket as ResidentApplicationBucketId)}
            applyPath={residentApplicationDetailHref(
              basePath,
              row.bucket as ResidentApplicationBucketId,
              row.id,
            )}
          />
        </div>
      );
    }
    const group = groupForRow(applicationGroups, { groupId: groupIdForRow(row) });
    const signerKey = normalizeApplicationAxisId(row.id).toUpperCase();
    const cosignerSubmissions = cosignerSubmissionsBySigner.get(signerKey) ?? [];
    return (
      <div className="space-y-4">
        {row.application?.applyingAsGroup === "yes" && row.application?.groupRole === "first" ? (
          <GroupShareCallout
            leaderAppId={row.id}
            groupRole="first"
            groupSize={row.application?.groupSize}
            propertyId={row.propertyId}
            className="rounded-2xl border border-border bg-accent/30 p-5"
            shareable={row.bucket !== "rejected"}
          />
        ) : null}
        {row.application?.hasCosigner === "yes" ? (
          <CosignerInviteCallout signerAppId={row.id} className="mt-4" />
        ) : null}
        {cosignerSubmissions.length > 0 ? (
          <ApplicationCosignerSection
            submissions={cosignerSubmissions}
            primaryApplicationAxisId={row.id}
            onOpenCosigner={(index) => {
              portalNavigate(
                `${residentApplicationDetailHref(basePath, row.bucket as ResidentApplicationBucketId, row.id)}?cosigner=${index}`,
              );
            }}
          />
        ) : null}
        <ResidentApplicationPdfFrame
          row={row}
          groupMembers={group?.members.filter((member) => member.id !== row.id) ?? []}
        />
      </div>
    );
  };

  const filterRow = (
    <LocalDestinationNav
      items={tabs.map((t) => ({
        id: t.id,
        label: t.label,
        count: t.count,
        dataAttr: `resident-applications-bucket-${t.id}`,
      }))}
      activeId={bucket}
      onChange={(id) => {
        const next = id as ManagerApplicationBucket;
        setBucket(next);
        if (!embedded && !applyMode) {
          portalNavigate(residentApplicationListHref(basePath, next as ResidentApplicationBucketId));
        }
      }}
      ariaLabel="Application status"
    />
  );

  const canOpenPropertyPicker = sessionReady;

  const newApplicationButton =
    sessionReady && canOpenPropertyPicker ? (
      <Button
        type="button"
        variant="primary"
        className={`shrink-0 ${PORTAL_HEADER_PRIMARY_ACTION_BTN}`}
        data-attr="resident-applications-apply"
        onClick={openPropertyPicker}
      >
        {workspace.mode === "in_progress"
          ? "Apply to property"
          : workspace.mode === "submitted"
            ? "Apply to another property"
            : "Apply to a property"}
      </Button>
    ) : null;

  const renderRoutedList = () => (
    <DataList
      variant="resident"
      hideColumnHeaders
      rows={listClustersForRows(filteredRowsForBucket)
        .flatMap((cluster) => (cluster.kind === "household" ? cluster.rows : [cluster.row]))
        .map((row) => {
        const room = displayRoomForRow(row);
        // Every row used to read "<Property> Applicant" and nothing else, so a
        // resident holding several applications for the same property+room had
        // no way to tell them apart (resident audit F7). Status, when it was
        // started/submitted, and the application id make each row identifiable.
        // Status lives in `trailing`; repeating it here printed it twice on the
        // same card. The id leads because `meta` is a single truncated line on
        // a phone — trailing it behind the property put the one field that
        // tells two identical rows apart under the clip.
        const subtitle = [
          row.id,
          stripPropertyRoomCountSuffix(row.property || ""),
          room !== "—" ? `Room ${room}` : "",
          applicationStartedLabel(row),
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          id: row.id,
          data: row,
          primary: applicantDisplayName(row),
          trailing: <span className="text-xs text-muted">{applicationStageDisplayLabel(row)}</span>,
          meta: subtitle || row.id,
          onClick: () => openApplicationRow(row),
        };
      })}
      columns={[
        {
          id: "name",
          header: "Application",
          cell: (row) => (
            <>
              <span className="block truncate">{applicantDisplayName(row)}</span>
              <span className="block font-mono text-[10px] text-muted">{row.id}</span>
            </>
          ),
        },
        { id: "property", header: "Property", cell: (row) => row.property || "—" },
        { id: "room", header: "Room", cell: (row) => displayRoomForRow(row) },
        { id: "status", header: "Status", cell: (row) => applicationStageDisplayLabel(row) },
        { id: "started", header: "Date", cell: (row) => applicationStartedLabel(row) || "—" },
      ]}
      emptyState={
        <PortalDataTableEmpty
          icon="application"
          message={
            searchQuery.trim() ? "No applications match your search." : "No applications in this tab yet."
          }
        />
      }
    />
  );

  const renderApplicationsTable = () => (
    <>
      <div className="space-y-2 lg:hidden">
        {rowsForBucket.map((row) => (
          <button
            key={row.id}
            type="button"
            id={`resident-application-${row.id}`}
            className={`${PORTAL_MOBILE_CARD_CLASS} w-full text-left`}
            onClick={() => openApplicationRow(row)}
            data-attr="resident-application-list-row"
          >
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 flex-1 truncate font-semibold text-foreground">{applicantDisplayName(row)}</p>
              <span className="shrink-0 text-xs text-muted">{applicationStageDisplayLabel(row)}</span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted">
              {[row.property || "—", `Room ${displayRoomForRow(row)}`, applicationStartedLabel(row)]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mt-1 font-mono text-[10px] text-muted/90">{row.id}</p>
          </button>
        ))}
      </div>
      <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
        <div className={PORTAL_DATA_TABLE_SCROLL}>
          <table className={PORTAL_DATA_TABLE}>
            <tbody>
              {rowsForBucket.map((row) => (
                <tr
                  key={row.id}
                  id={`resident-application-${row.id}`}
                  className={`${PORTAL_TABLE_TR_EXPANDABLE} cursor-pointer`}
                  onClick={() => openApplicationRow(row)}
                  data-attr="resident-application-list-row"
                >
                  <td className={`${PORTAL_TABLE_TD} align-middle`}>
                    <p className="font-medium leading-snug text-foreground">{applicantDisplayName(row)}</p>
                    <p className="mt-1.5 font-mono text-[10px] leading-relaxed tracking-wide text-muted">{row.id}</p>
                  </td>
                  <td className={`${PORTAL_TABLE_TD} align-middle leading-relaxed`}>{row.property || "—"}</td>
                  <td className={`${PORTAL_TABLE_TD} align-middle leading-relaxed`}>{displayRoomForRow(row)}</td>
                  <td className={`${PORTAL_TABLE_TD} align-middle leading-relaxed`}>
                    {applicationStageDisplayLabel(row)}
                  </td>
                  <td className={`${PORTAL_TABLE_TD} align-middle leading-relaxed`}>
                    {applicationStartedLabel(row) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  const tableBody = !sessionReady ? (
    <div className={PORTAL_DATA_TABLE_WRAP}>
      <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">Loading applications…</div>
    </div>
  ) : (
    <>
      {embedded ? filterRow : null}

      {renderStandaloneApplySurface()}

      {rows.length === 0 && !applyMode ? (
        <PortalDataTableEmpty icon="application" message="No applications yet. Start your first application." />
      ) : rowsForBucket.length === 0 && !(applyMode && !activeInProgressRow) ? (
        <PortalDataTableEmpty icon="application" message="No applications in this tab yet." />
      ) : applyMode || embedded ? (
        rowsForBucket.length > 0 ? renderApplicationsTable() : null
      ) : filteredRowsForBucket.length === 0 ? (
        <PortalDataTableEmpty
          icon="application"
          message={
            searchQuery.trim()
              ? "No applications match your search."
              : "No applications in this tab yet."
          }
        />
      ) : (
        renderRoutedList()
      )}
      {withdrawModal}
      {propertyPickerModal}
    </>
  );

  if (embedded) return tableBody;

  const renderResidentApplicationList = () => {
    const listRows = searchQuery.trim() ? filteredRowsForBucket : rowsForBucket;

    return (
      <>
        <PortalListControlStack className="mb-2 max-lg:mb-2" destinationRow={filterRow} />

        {!sessionReady ? (
          <div className={PORTAL_DATA_TABLE_WRAP}>
            <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">Loading applications…</div>
          </div>
        ) : listRows.length === 0 ? (
          <PortalDataTableEmpty icon="application" message="No applications in this tab yet." />
        ) : (
          <div className={PORTAL_LIST_PAGE_BODY}>{renderRoutedList()}</div>
        )}

        {withdrawModal}
        {propertyPickerModal}
      </>
    );
  };

  if (!applicationIdProp && !applyMode) {
    return (
      <ManagerPortalPageShell
        title="Applications"
        hideTitleOnMobileNav
        titleAside={
          <ResidentApplicationWorkspaceActions
            workspace={workspace}
            sessionReady={sessionReady}
            onApplyClick={openPropertyPicker}
            canOpenPropertyPicker={canOpenPropertyPicker}
          />
        }
        compactFilterRow
      >
        {renderResidentApplicationList()}
      </ManagerPortalPageShell>
    );
  }

  if (!applicationIdProp && applyMode) {
    if (applyTarget && applyView === "wizard" && !activeInProgressRow) {
      return (
        <ManagerPortalPageShell title="Apply" hideTitleOnMobileNav compactFilterRow>
          <div className={PORTAL_DATA_TABLE_WRAP}>
            {!sessionReady ? (
              <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">Loading application…</div>
            ) : (
              embeddedWizard
            )}
          </div>
          {withdrawModal}
          {propertyPickerModal}
        </ManagerPortalPageShell>
      );
    }

    return (
      <ManagerPortalPageShell
        title="Applications"
        hideTitleOnMobileNav
        titleAside={newApplicationButton ?? undefined}
        compactFilterRow
      >
        <PortalListControlStack className="mb-2 max-lg:mb-2" destinationRow={filterRow} />
        {!sessionReady ? (
          <div className={PORTAL_DATA_TABLE_WRAP}>
            <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">Loading applications…</div>
          </div>
        ) : (
          <>
            {renderStandaloneApplySurface()}
            {rowsForBucket.length > 0 ? renderApplicationsTable() : null}
          </>
        )}
        {withdrawModal}
        {propertyPickerModal}
      </ManagerPortalPageShell>
    );
  }

  if (applicationIdProp) {
    if (!sessionReady) {
      return (
        <ManagerPortalPageShell title="Applications" hideTitleOnMobileNav>
          <div className={PORTAL_DATA_TABLE_WRAP}>
            <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">
              Loading application…
            </div>
          </div>
        </ManagerPortalPageShell>
      );
    }
    if (!detailRow) {
      if (detailLoading) {
        return (
          <ManagerPortalPageShell title="Applications" hideTitleOnMobileNav>
            <div className={PORTAL_DATA_TABLE_WRAP}>
              <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">
                Loading application…
              </div>
            </div>
          </ManagerPortalPageShell>
        );
      }
      return (
        <ManagerPortalPageShell title="Applications" hideTitleOnMobileNav>
          <PortalDataTableEmpty icon="application" message="Application not found." />
        </ManagerPortalPageShell>
      );
    }
    return (
      <>
        {withdrawModal}
        {propertyPickerModal}
        <PortalRecordDetailPage
          pageTitle="Applications"
          title={
            activeCosignerSubmission
              ? activeCosignerSubmission.fullName || "Co-signer application"
              : stripPropertyRoomCountSuffix(detailRow.property || detailRow.name || "Application")
          }
          subtitle={
            activeCosignerSubmission
              ? activeCosignerSubmission.email || `Co-signer for ${applicantDisplayName(detailRow)}`
              : detailRow.email || undefined
          }
          backHref={
            activeCosignerSubmission
              ? residentApplicationDetailHref(
                  basePath,
                  detailRow.bucket as ResidentApplicationBucketId,
                  detailRow.id,
                )
              : residentApplicationListHref(basePath, detailRow.bucket as ResidentApplicationBucketId)
          }
          hideBackText
          bareHeader
          dataAttrBack="resident-application-detail-back"
          inlineActions={!activeCosignerSubmission}
          actions={activeCosignerSubmission ? undefined : renderDetailActions(detailRow)}
        >
          {activeCosignerSubmission ? (
            <ManagerCosignerReadonlyReview
              sub={activeCosignerSubmission}
              onOpenSignerApplication={() =>
                router.push(
                  residentApplicationDetailHref(
                    basePath,
                    detailRow.bucket as ResidentApplicationBucketId,
                    detailRow.id,
                  ),
                )
              }
            />
          ) : (
            renderApplicationDetailBody(detailRow)
          )}
        </PortalRecordDetailPage>
      </>
    );
  }

  return null;
}
