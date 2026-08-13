"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalDetailDestinationNav } from "@/components/portal/portal-detail-destination-nav";
import type { MockProperty } from "@/data/types";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { ListingStickySubnav } from "@/components/marketing/listing-detail-subnav";
import { getListingRichContent } from "@/data/listing-rich-content";
import { ManagerAddListingForm } from "@/components/portal/manager-add-listing-form";
import { ManagerPropertyHouseDetailsPanel } from "@/components/portal/manager-property-house-details-panel";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/manager-property-room-move-in-panel";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/manager-property-application-questions-panel";
import { ManagerPropertyLeasePanel } from "@/components/portal/manager-property-lease-panel";
import { ManagerPropertyPromotionPanel } from "@/components/portal/manager-property-promotion-panel";
import { ManagerPropertyCalendarPanel } from "@/components/portal/manager-property-calendar-panel";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { PortalPageFooterActions, PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalPageChrome, PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { cn } from "@/lib/utils";
import { PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";
import { PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS } from "@/components/portal/portal-property-detail-section";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import {
  PROPERTY_DETAIL_SECTION_TABS,
  PROPERTY_DETAIL_TAB_LABELS,
  PROPERTY_DETAIL_TOP_TAB_LABELS,
  PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS,
  propertyDetailHref,
  propertyListHref,
  propertyDetailTopNavId,
  parsePropertyDetailTab,
  parsePropertyCalendarSubTab,
  type PropertyCalendarSubTabId,
  type PropertyDetailSectionTabId,
  type PropertyDetailTabId,
} from "@/lib/portal-detail-routes";
import { ManagerPropertyRequestsPanel } from "@/components/portal/manager-property-requests-panel";
import { PropertyResidentOnboardWizard } from "@/components/portal/property-resident-onboard-wizard";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useListingContactSmsPhone } from "@/hooks/use-listing-contact-sms-phone";
import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import {
  adminPropertyRentDisplayLabel,
  compareAdminPropertyRowsForDisplay,
  deleteManagerPropertyDraft,
  deleteUnlistedManagerProperty,
  listAdminRow,
  readAdminPropertyRows,
  resolveAdminPropertyRowPreview,
  unlistManagerListing,
  type AdminPropertyBucketIndex,
  type AdminPropertyRow,
} from "@/lib/demo-admin-property-inventory";
import { parseMonthlyRent } from "@/lib/listings-search";
import {
  PROPERTY_PIPELINE_EVENT,
  countManagerManagedPropertiesForUser,
  readExtraListingsForUser,
} from "@/lib/demo-property-pipeline";
import { samePropertyId } from "@/lib/co-manager-calendar";
import {
  collectLinkedPropertyIds,
  hasLinkedPropertyModuleLevel,
  linkedPropertyOwnerId,
  syncManagerPortfolioFromServer,
} from "@/lib/manager-portfolio-access";
import { isServerSyncOriginatedEvent } from "@/lib/property-pipeline-events";
import { managerPropertyLimitMessage, managerTierPropertyLimitReached } from "@/lib/manager-access";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";

function propertyIdIsLinked(pid: string, linkedIds: Set<string>): boolean {
  if (!pid) return false;
  if (linkedIds.has(pid)) return true;
  for (const id of linkedIds) {
    if (samePropertyId(id, pid)) return true;
  }
  return false;
}
import { resolvePropertySaveTarget } from "@/lib/manager-property-save-target";
import {
  legacyAdminFieldsToSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { withListingContactSmsPhone } from "@/lib/listing-contact-sms";

function submissionForListedEdit(p: MockProperty): ManagerListingSubmissionV1 {
  if (p.listingSubmission) return normalizeManagerListingSubmissionV1(p.listingSubmission);
  const rentNum = parseMonthlyRent(String(p.rentLabel ?? "")) ?? 0;
  return normalizeManagerListingSubmissionV1(
    legacyAdminFieldsToSubmission({
      buildingName: p.buildingName,
      address: p.address,
      zip: p.zip,
      neighborhood: p.neighborhood,
      unitLabel: p.unitLabel,
      beds: p.beds,
      baths: p.baths,
      monthlyRent: rentNum,
      petFriendly: p.petFriendly,
      tagline: p.tagline,
    }),
  );
}

function submissionForAdminRow(row: AdminPropertyRow): ManagerListingSubmissionV1 {
  if (row.submission) return normalizeManagerListingSubmissionV1(row.submission);
  return normalizeManagerListingSubmissionV1(
    legacyAdminFieldsToSubmission({
      buildingName: row.buildingName,
      address: row.address,
      zip: row.zip,
      neighborhood: row.neighborhood,
      unitLabel: row.unitLabel,
      beds: row.beds,
      baths: row.baths,
      monthlyRent: row.monthlyRent,
      petFriendly: row.petFriendly,
      tagline: row.tagline,
    }),
  );
}

/** Lets the browser paint after click before heavy localStorage writes (better INP on delete/unlist). */
function deferCatalogMutation(fn: () => void) {
  requestAnimationFrame(() => {
    requestAnimationFrame(fn);
  });
}

const MANAGER_STAGES = [
  { key: "drafts", label: "Drafts", buckets: [5] as AdminPropertyBucketIndex[] },
  { key: "listed", label: "Listed", buckets: [2] as AdminPropertyBucketIndex[] },
  { key: "unlisted", label: "Unlisted", buckets: [3] as AdminPropertyBucketIndex[] },
] as const;

export type ManagerStageKey = (typeof MANAGER_STAGES)[number]["key"];

/** A draft can be saved before it has a name — never render an empty title cell. */
function managerPropertyRowTitle(row: AdminPropertyRow, bucket: AdminPropertyBucketIndex): string {
  return row.buildingName.trim() || (bucket === 5 ? "Untitled draft" : "Untitled property");
}

export function managerStageFromParam(raw: string | null): ManagerStageKey {
  return MANAGER_STAGES.some((stage) => stage.key === raw) ? (raw as ManagerStageKey) : "listed";
}

export { MANAGER_STAGES };

function ManagerPropertyInlineDetails({
  bucket,
  row,
  dataRevision,
  onUpdated,
  onAfterUnlist,
  showToast,
  managerUserId,
  skuTier,
  skuLoaded,
  propCount,
  onSendToProspect,
  propertiesBase,
  stage,
  detailTab: detailTabProp = "preview",
  calendarSubTab: calendarSubTabProp = "tours",
  onDetailHeaderActions,
}: {
  bucket: AdminPropertyBucketIndex;
  row: AdminPropertyRow | null;
  /** Bumps when local property pipeline storage changes so listing submissions re-read. */
  dataRevision: number;
  onUpdated: () => void;
  onAfterUnlist?: (propertyKey: string) => void;
  showToast: (m: string) => void;
  managerUserId: string | null;
  skuTier: string | null;
  skuLoaded: boolean;
  propCount: number;
  onSendToProspect?: (listingId: string) => void;
  propertiesBase: string;
  stage: ManagerStageKey;
  detailTab?: PropertyDetailTabId;
  calendarSubTab?: PropertyCalendarSubTabId;
  onDetailHeaderActions?: (key: string, actions: ReactNode) => void;
}) {
  const mock = useMemo(() => (row ? resolveAdminPropertyRowPreview(row) : null), [row]);
  const contactSmsPhone = useListingContactSmsPhone({
    listingId: row?.listingId,
    ownerManagerUserId: row?.managerUserId,
    viewerManagerUserId: managerUserId,
  });
  const previewProperty = useMemo(
    () => (mock ? withListingContactSmsPhone(mock, contactSmsPhone) : null),
    [mock, contactSmsPhone],
  );
  const rich = useMemo(() => (previewProperty ? getListingRichContent(previewProperty) : null), [previewProperty]);
  const hasPreview = Boolean(previewProperty && rich);
  const detailTab = parsePropertyDetailTab(detailTabProp);
  const calendarSubTab = parsePropertyCalendarSubTab(calendarSubTabProp);
  const listingId = row?.listingId;
  const stablePropertyId = row?.listingId?.trim() || row?.adminRefId?.trim() || null;

  const isLinkedProperty = Boolean(
    managerUserId && stablePropertyId && collectLinkedPropertyIds(managerUserId).has(stablePropertyId),
  );

  // For a LINKED property, the listing itself is owned by another manager and
  // stored under the owner's key. Resolve that owner so edits/deletes attribute
  // to and mutate the owner's record (the server re-checks the co-manager grant).
  const linkedOwnerId = useMemo(
    () =>
      isLinkedProperty && managerUserId && stablePropertyId
        ? linkedPropertyOwnerId(managerUserId, stablePropertyId)
        : null,
    [isLinkedProperty, managerUserId, stablePropertyId],
  );
  // Gate the destructive/edit actions on a linked property by the co-manager's
  // granted level for the `properties` module. Own properties always qualify.
  const canEditLevel =
    !isLinkedProperty ||
    Boolean(
      managerUserId &&
        stablePropertyId &&
        hasLinkedPropertyModuleLevel(managerUserId, stablePropertyId, "properties", "edit"),
    );
  const canDeleteLevel =
    !isLinkedProperty ||
    Boolean(
      managerUserId &&
        stablePropertyId &&
        hasLinkedPropertyModuleLevel(managerUserId, stablePropertyId, "properties", "delete"),
    );

  const portalSub = useMemo<
    | {
        sub: ManagerListingSubmissionV1;
        saveMode: "listing";
        saveId: string;
        listingId?: string;
        ownerUserId?: string;
      }
    | null
  >(() => {
    if (!managerUserId || !row) return null;

    const listingId = row.listingId?.trim() || undefined;
    if (listingId) {
      // Linked (co-managed) property: the listing lives under the OWNER's key in
      // the local mirror. Resolve it there and remember the owner so the edit
      // save + delete target the owner's record (server re-checks the grant).
      if (linkedOwnerId) {
        const owned = readExtraListingsForUser(linkedOwnerId).find((x) => x.id === listingId);
        if (owned) {
          return {
            sub: submissionForListedEdit(owned),
            saveMode: "listing",
            saveId: listingId,
            listingId,
            ownerUserId: linkedOwnerId,
          };
        }
      }
      const p = readExtraListingsForUser(managerUserId).find((x) => x.id === listingId);
      if (p) return { sub: submissionForListedEdit(p), saveMode: "listing", saveId: listingId, listingId };
    }

    return null;
  }, [dataRevision, managerUserId, row, linkedOwnerId]);

  // noteKey is stable per listing — derived from row identifiers so it doesn't depend on portalSub.
  const noteKey = useMemo(
    () => (managerUserId && stablePropertyId ? `${managerUserId}:${stablePropertyId}` : null),
    [managerUserId, stablePropertyId],
  );

  const displaySub = portalSub?.sub ?? null;
  const [listingEditorOpen, setListingEditorOpen] = useState(false);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const [shareApplicationOpen, setShareApplicationOpen] = useState(false);
  const [residentOnboardOpen, setResidentOnboardOpen] = useState(false);
  const [pendingDestructiveAction, setPendingDestructiveAction] = useState<
    "delete-queue" | "delete-draft" | "unlist" | null
  >(null);
  const [destructiveBusy, setDestructiveBusy] = useState(false);

  const managerSubmission = useMemo(
    () => (row ? displaySub ?? submissionForAdminRow(row) : null),
    [dataRevision, displaySub, row],
  );

  const houseSaveTarget = useMemo(() => {
    if (!row) return null;
    return resolvePropertySaveTarget({
      portalSaveMode: portalSub?.saveMode,
      portalSaveId: portalSub?.saveId,
      bucket,
      adminRefId: row.adminRefId,
      listingId,
    });
  }, [portalSub, bucket, row, listingId]);

  const leasePropertyHint = useMemo(
    () =>
      row
        ? { buildingName: row.buildingName, unitLabel: row.unitLabel, rentLabel: row.rentRangeLabel }
        : undefined,
    [row],
  );

  const run = (label: string, ok: boolean, err = "Action could not be completed.") => {
    if (!ok) {
      showToast(err);
      return;
    }
    showToast(label);
    onUpdated();
  };

  const propertyShareLabel = row ? managerPropertyRowTitle(row, bucket) : "Property";
  const sharePropertyId = listingId ?? stablePropertyId ?? "";
  const sharePropertyOptions = useMemo(
    () => (sharePropertyId ? [{ id: sharePropertyId, label: propertyShareLabel }] : []),
    [sharePropertyId, propertyShareLabel],
  );


  const sectionHeaderBtn = PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS;
  const canEditListing = Boolean(displaySub && portalSub);
  // Show Edit only with write (`edit`) level and Delete only with `delete` level.
  // Own properties always qualify; a linked property is gated by the grant.
  const canEditAction = canEditListing && canEditLevel;
  const canDeleteAction = canEditListing && canDeleteLevel;
  // Listing edits/deletes for a linked property must mutate the OWNER's record.
  const listingOwnerUserId = portalSub?.ownerUserId ?? managerUserId;

  const openFullListingEditor = () => setListingEditorOpen(true);
  const dangerBtnClass = `${sectionHeaderBtn} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`;

  const leaseAddHandlerRef = useRef<(() => void) | null>(null);
  const registerLeaseAddHandler = useCallback((handler: (() => void) | null) => {
    leaseAddHandlerRef.current = handler;
  }, []);

  const tourSendHandlerRef = useRef<(() => void) | null>(null);
  const registerTourSendHandler = useCallback((handler: (() => void) | null) => {
    tourSendHandlerRef.current = handler;
  }, []);

  const promotionNewHandlerRef = useRef<(() => void) | null>(null);
  const registerPromotionNewHandler = useCallback((handler: (() => void) | null) => {
    promotionNewHandlerRef.current = handler;
  }, []);

  const requestAddHandlerRef = useRef<(() => void) | null>(null);
  const registerRequestAddHandler = useCallback((handler: (() => void) | null) => {
    requestAddHandlerRef.current = handler;
  }, []);

  const applicationAddHandlerRef = useRef<(() => void) | null>(null);
  const registerApplicationAddHandler = useCallback((handler: (() => void) | null) => {
    applicationAddHandlerRef.current = handler;
  }, []);

  const propertyTopHeaderActions = useMemo(
    () => (
      <PortalSectionActionRow variant="header">
        {bucket === 2 && listingId ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={sectionHeaderBtn}
              data-attr="listing-send-listing"
              onClick={(e) => {
                e.stopPropagation();
                onSendToProspect?.(listingId);
              }}
            >
              Send listing
            </Button>
            <Button
              type="button"
              variant="outline"
              className={sectionHeaderBtn}
              data-attr="listing-unlist"
              onClick={(e) => {
                e.stopPropagation();
                setPendingDestructiveAction("unlist");
              }}
            >
              Unlist
            </Button>
          </>
        ) : null}

        {bucket === 3 ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={sectionHeaderBtn}
              data-attr="listing-relist"
              onClick={(e) => {
                e.stopPropagation();
                if (!skuLoaded) {
                  showToast("Loading subscription…");
                  return;
                }
                if (managerTierPropertyLimitReached(skuTier, propCount)) {
                  showToast(managerPropertyLimitMessage(skuTier, { omitUpgradeCta: isNativeRuntimeSync() }));
                  return;
                }
                deferCatalogMutation(() => {
                  if (!row) return;
                  const id = listAdminRow(row, managerUserId);
                  if (!id) {
                    showToast("Could not relist.");
                    return;
                  }
                  showToast("Listing is live again.");
                  onUpdated();
                });
              }}
            >
              Relist property
            </Button>
            {canDeleteAction ? (
              <Button
                type="button"
                variant="outline"
                className={dangerBtnClass}
                data-attr="listing-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDestructiveAction("delete-queue");
                }}
              >
                Delete from queue
              </Button>
            ) : null}
          </>
        ) : null}

        {bucket === 5 ? (
          <>
            <Button
              type="button"
              variant="primary"
              className={sectionHeaderBtn}
              data-attr="draft-continue-editing"
              onClick={(e) => {
                e.stopPropagation();
                if (!skuLoaded) {
                  showToast("Loading subscription…");
                  return;
                }
                setDraftEditorOpen(true);
              }}
            >
              Continue editing
            </Button>
            <Button
              type="button"
              variant="outline"
              className={dangerBtnClass}
              data-attr="draft-delete"
              onClick={(e) => {
                e.stopPropagation();
                setPendingDestructiveAction("delete-draft");
              }}
            >
              Delete draft
            </Button>
          </>
        ) : null}
      </PortalSectionActionRow>
    ),
    [
      bucket,
      listingId,
      canDeleteAction,
      sectionHeaderBtn,
      dangerBtnClass,
      onSendToProspect,
      row,
      managerUserId,
      showToast,
      onUpdated,
      skuLoaded,
      skuTier,
      propCount,
    ],
  );

  const confirmDestructiveAction = () => {
    if (!row || !pendingDestructiveAction) return;
    const action = pendingDestructiveAction;
    setDestructiveBusy(true);
    deferCatalogMutation(() => {
      if (action === "delete-queue") {
        run("Removed from queue.", deleteUnlistedManagerProperty(row.adminRefId, managerUserId));
        setDestructiveBusy(false);
        setPendingDestructiveAction(null);
        return;
      }
      if (action === "delete-draft") {
        void deleteManagerPropertyDraft(row.adminRefId, managerUserId).then((ok) => {
          run("Draft deleted.", ok, "Could not delete the draft. Check your connection and try again.");
          setDestructiveBusy(false);
          setPendingDestructiveAction(null);
        });
        return;
      }
      if (action === "unlist") {
        if (!listingId) {
          showToast("Could not unlist.");
          setDestructiveBusy(false);
          setPendingDestructiveAction(null);
          return;
        }
        const ok = unlistManagerListing(listingId, managerUserId);
        setDestructiveBusy(false);
        setPendingDestructiveAction(null);
        if (!ok) {
          showToast("Could not unlist.");
          return;
        }
        showToast("Listing unlisted.");
        onUpdated();
        onAfterUnlist?.(listingId.trim() || row.adminRefId.trim());
      }
    });
  };

  const destructiveModalCopy =
    pendingDestructiveAction === "delete-queue"
      ? {
          title: "Delete from queue",
          description: `Remove ${propertyShareLabel} from your unlisted queue permanently?`,
          confirmLabel: "Delete from queue",
          dataAttr: "listing-delete-confirm",
        }
      : pendingDestructiveAction === "delete-draft"
        ? {
            title: "Delete draft",
            description: `Delete the draft for ${propertyShareLabel}? Your saved progress will be removed.`,
            confirmLabel: "Delete draft",
            dataAttr: "draft-delete-confirm",
          }
        : pendingDestructiveAction === "unlist"
          ? {
              title: "Unlist property",
              description: `Unlist ${propertyShareLabel}? It will be removed from the public listing and moved to your unlisted queue.`,
              confirmLabel: "Unlist",
              dataAttr: "listing-unlist-confirm",
            }
          : null;

  const listingFormProps = portalSub
    ? {
        onClose: () => {
          setListingEditorOpen(false);
        },
        onSubmitted: () => {
          setListingEditorOpen(false);
          onUpdated();
        },
        showToast,
        skuTier,
        propCountBeforeSubmit: propCount,
        initialSubmission: portalSub.sub,
        noteKey,
        editPendingId: null,
        editListingId: portalSub.saveId,
        editRequestChangeId: null,
        editListingOwnerUserId: portalSub.ownerUserId ?? null,
      }
    : null;

  // Resume a saved draft in the full wizard. On final submit the wizard publishes
  // this draft in place (draft → live) and removes it from the drafts bucket.
  const draftFormProps =
    bucket === 5 && managerUserId
      ? {
          onClose: () => setDraftEditorOpen(false),
          onSubmitted: () => {
            setDraftEditorOpen(false);
            showToast("Listing submitted and published.");
            onUpdated();
          },
          onSaved: onUpdated,
          showToast,
          skuTier,
          propCountBeforeSubmit: propCount,
          initialSubmission: managerSubmission,
          noteKey,
          editDraftId: row?.adminRefId,
          initialStepIndex: row?.draftStepIndex ?? null,
          initialMaxStepReached: row?.draftMaxStepReached ?? null,
        }
      : null;

  // Falls back to "" only in the render that returns null below (no row), where it is
  // never read. Keeps the type a plain string for every href builder downstream.
  const propertyRouteKey = stablePropertyId || row?.adminRefId || "";
  const availableTabs: PropertyDetailTabId[] =
    bucket === 3 || bucket === 5
      ? ["preview"]
      : bucket === 2 && listingId
        ? ["preview", "house-details", "move-in", "application", "lease", "calendar", "requests", "promotion"]
        : ["preview", "house-details", "move-in", "application", "lease"];
  const activeDetailTab = availableTabs.includes(detailTab) ? detailTab : availableTabs[0]!;
  const detailSectionTabs = useMemo(
    () =>
      availableTabs.filter((tab): tab is PropertyDetailSectionTabId =>
        (PROPERTY_DETAIL_SECTION_TABS as readonly string[]).includes(tab),
      ),
    [availableTabs],
  );
  const topNavItems = useMemo(() => {
    const items: Array<{
      id: string;
      label: string;
      shortLabel?: string;
      href: string;
      dataAttr: string;
    }> = [];
    const pushTopTab = (
      id: keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS,
      tab: PropertyDetailTabId,
    ) => {
      if (!availableTabs.includes(tab)) return;
      items.push({
        id,
        label: PROPERTY_DETAIL_TOP_TAB_LABELS[id],
        shortLabel: PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS[id],
        href: propertyDetailHref(propertiesBase, stage, propertyRouteKey, tab),
        dataAttr: `property-detail-tab-${id}`,
      });
    };

    if (detailSectionTabs.length > 0) {
      items.push({
        id: "details",
        label: PROPERTY_DETAIL_TOP_TAB_LABELS.details,
        href: propertyDetailHref(propertiesBase, stage, propertyRouteKey, detailSectionTabs[0]!),
        dataAttr: "property-detail-tab-details",
      });
    }
    pushTopTab("calendar", "calendar");
    pushTopTab("application", "application");
    pushTopTab("lease", "lease");
    pushTopTab("requests", "requests");
    pushTopTab("promotion", "promotion");
    return items;
  }, [availableTabs, detailSectionTabs, propertiesBase, propertyRouteKey, stage]);
  const activeTopNavId = propertyDetailTopNavId(activeDetailTab);
  const isDetailsSection = activeTopNavId === "details";
  const detailsSubNavItems = useMemo(
    () =>
      detailSectionTabs.map((tab) => ({
        id: tab,
        label: PROPERTY_DETAIL_TAB_LABELS[tab],
        href: propertyDetailHref(propertiesBase, stage, propertyRouteKey, tab),
        dataAttr: `property-details-subtab-${tab}`,
      })),
    [detailSectionTabs, propertiesBase, propertyRouteKey, stage],
  );

  const previewHasToolbar = bucket === 2 || bucket === 3 || bucket === 5;

  const propertyTabFooterActions = useMemo(() => {
    if (activeDetailTab === "preview") {
      if (bucket === 2 && canEditAction) {
        return (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="listing-edit-full"
            onClick={() => openFullListingEditor()}
          >
            Edit listing
          </Button>
        );
      }
      if (bucket === 3 && canEditListing && canEditAction) {
        return (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="listing-edit-full"
            onClick={() => openFullListingEditor()}
          >
            Edit listing
          </Button>
        );
      }
      return null;
    }
    if (
      (activeDetailTab === "application" || activeDetailTab === "lease") &&
      bucket !== 3 &&
      bucket !== 5
    ) {
      const fromLeaseTab = activeDetailTab === "lease";
      const openOnboard = () => setResidentOnboardOpen(true);
      const actions: PortalAdaptiveAction[] = [
        {
          id: "add-application",
          node: (
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr={
                fromLeaseTab
                  ? "property-application-add-footer-from-lease"
                  : "property-application-add-footer"
              }
              onClick={openOnboard}
            >
              Add application
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr={
                fromLeaseTab
                  ? "property-application-add-footer-from-lease"
                  : "property-application-add-footer"
              }
              onSelect={openOnboard}
            >
              Add application
            </DropdownMenuItem>
          ),
        },
        {
          id: "add-lease",
          node: (
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr={
                fromLeaseTab ? "property-lease-add-footer" : "property-lease-add-footer-from-application"
              }
              onClick={openOnboard}
            >
              Add lease
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr={
                fromLeaseTab ? "property-lease-add-footer" : "property-lease-add-footer-from-application"
              }
              onSelect={openOnboard}
            >
              Add lease
            </DropdownMenuItem>
          ),
        },
        {
          id: "add-resident",
          alwaysVisible: true,
          pinEdge: "end",
          keepPriority: 10,
          node: (
            <Button
              type="button"
              variant="primary"
              className={PORTAL_DETAIL_BTN}
              data-attr={
                fromLeaseTab ? "property-resident-onboard-footer-lease-tab" : "property-resident-onboard-footer"
              }
              onClick={openOnboard}
            >
              Add resident
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr={
                fromLeaseTab ? "property-resident-onboard-footer-lease-tab" : "property-resident-onboard-footer"
              }
              onSelect={openOnboard}
            >
              Add resident
            </DropdownMenuItem>
          ),
        },
      ];
      if (!fromLeaseTab && sharePropertyId) {
        actions.push({
          id: "send-application",
          node: (
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr="property-application-send-footer"
              onClick={() => setShareApplicationOpen(true)}
            >
              Send application
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="property-application-send-footer"
              onSelect={() => setShareApplicationOpen(true)}
            >
              Send application
            </DropdownMenuItem>
          ),
        });
      }
      return (
        <PortalAdaptiveActionRow
          actions={actions}
          moreAriaLabel="More resident actions"
          moreDataAttr="property-resident-footer-more"
          gapPx={8}
        />
      );
    }
    if (activeDetailTab === "calendar" && calendarSubTab === "tours" && bucket === 2 && listingId) {
      return (
        <Button
          type="button"
          variant="primary"
          className={PORTAL_DETAIL_BTN}
          data-attr="listing-send-tour-link-footer"
          onClick={() => tourSendHandlerRef.current?.()}
        >
          Send tour link
        </Button>
      );
    }
    if (activeDetailTab === "requests" && bucket === 2 && stablePropertyId) {
      return (
        <Button
          type="button"
          variant="primary"
          className={PORTAL_DETAIL_BTN}
          data-attr="manager-service-request-add-footer"
          onClick={() => requestAddHandlerRef.current?.()}
        >
          Add request
        </Button>
      );
    }
    if (activeDetailTab === "promotion" && bucket === 2 && listingId) {
      return (
        <Button
          type="button"
          variant="primary"
          className={PORTAL_DETAIL_BTN}
          data-attr="manager-property-new-promotion-footer"
          onClick={() => promotionNewHandlerRef.current?.()}
        >
          Add
        </Button>
      );
    }
    return null;
  }, [
    activeDetailTab,
    bucket,
    listingId,
    stablePropertyId,
    canEditAction,
    canEditListing,
    sharePropertyId,
    openFullListingEditor,
  ]);

  const propertyTopHeaderActionsRef = useRef(propertyTopHeaderActions);
  useEffect(() => {
    propertyTopHeaderActionsRef.current = propertyTopHeaderActions;
  });

  const detailHeaderKey = useMemo(() => {
    if (!previewHasToolbar) return "none";
    return `top:${bucket}:${listingId ?? ""}:${canDeleteAction}:${skuLoaded}`;
  }, [previewHasToolbar, bucket, listingId, canDeleteAction, skuLoaded]);

  useEffect(() => {
    if (!onDetailHeaderActions) return;
    const actions =
      previewHasToolbar && activeDetailTab === "preview"
        ? propertyTopHeaderActionsRef.current
        : null;
    onDetailHeaderActions(detailHeaderKey, actions);
  }, [onDetailHeaderActions, detailHeaderKey, previewHasToolbar, activeDetailTab]);

  useEffect(() => {
    if (!onDetailHeaderActions) return;
    return () => onDetailHeaderActions("none", null);
  }, [onDetailHeaderActions]);

  // Every hook above runs unconditionally. This guard used to sit ~470 lines earlier, so a
  // row/mock/submission flipping between renders changed the hook COUNT, which is the
  // rules-of-hooks violation React throws "rendered more hooks than during the previous
  // render" on. It gates rendering only.
  if (!row || !mock || !managerSubmission) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PortalPageChrome>
        <div
          className="border-b border-border/40 bg-background"
          data-portal-property-detail-chrome
        >
          <PortalDetailDestinationNav
            items={topNavItems}
            activeId={activeTopNavId}
            ariaLabel="Property sections"
            denseEqualRow
          />

          {isDetailsSection && detailsSubNavItems.length > 1 ? (
            <PortalListControlStack
              className="border-t border-border bg-accent/30 py-1"
              destinations={detailsSubNavItems}
              activeDestinationId={activeDetailTab}
              destinationAriaLabel="Details sections"
              stickyDestinations={false}
              destinationInset
            />
          ) : null}

          {isDetailsSection && activeDetailTab === "preview" && hasPreview ? (
            <ListingStickySubnav
              mode="portal"
              appearance="portal"
              className="shrink-0 rounded-none border-0 border-t border-border bg-accent/30 py-1.5 shadow-none"
            />
          ) : null}
        </div>
      </PortalPageChrome>

      <PortalPageScrollBody
        className={cn(
          "min-w-0 max-w-full",
          activeDetailTab !== "calendar" && activeDetailTab !== "preview" && "pt-3",
        )}
      >
      {isDetailsSection && activeDetailTab === "preview" ? (
        hasPreview ? (
          <ListingDetailSections
            property={previewProperty!}
            rich={rich!}
            portalEmbedded
            expandSectionsOnMobile
            managerPreviewChrome
            hidePortalSubnav
          />
        ) : bucket === 3 || bucket === 5 ? (
          <p className="text-sm text-muted">
            {bucket === 5
              ? "Finish the draft wizard to see a public preview."
              : "Relist this property to restore the public preview."}
          </p>
        ) : null
      ) : null}

      {isDetailsSection && activeDetailTab === "house-details" && bucket !== 3 && bucket !== 5 ? (
        <ManagerPropertyHouseDetailsPanel
          noteKey={noteKey}
          sub={managerSubmission}
          saveTarget={houseSaveTarget}
          managerUserId={managerUserId}
          onUpdated={onUpdated}
          showToast={showToast}
        />
      ) : null}

      {isDetailsSection && activeDetailTab === "move-in" && bucket !== 3 && bucket !== 5 ? (
        <ManagerPropertyRoomMoveInPanel
          sub={managerSubmission}
          saveTarget={houseSaveTarget}
          managerUserId={listingOwnerUserId}
          canEdit={canEditAction}
          onUpdated={onUpdated}
          showToast={showToast}
        />
      ) : null}

      {activeDetailTab === "application" && bucket !== 3 && bucket !== 5 ? (
        <ManagerPropertyApplicationQuestionsPanel
          sub={managerSubmission}
          saveTarget={houseSaveTarget}
          managerUserId={managerUserId}
          listingId={listingId}
          onUpdated={onUpdated}
          showToast={showToast}
          onRegisterAddApplication={registerApplicationAddHandler}
        />
      ) : null}

      {activeDetailTab === "lease" && bucket !== 3 && bucket !== 5 ? (
        <ManagerPropertyLeasePanel
          sub={managerSubmission}
          saveTarget={houseSaveTarget}
          managerUserId={managerUserId}
          propertyId={stablePropertyId}
          propertyLabel={leasePropertyHint?.buildingName ?? row?.buildingName}
          onUpdated={onUpdated}
          showToast={showToast}
          propertyHint={leasePropertyHint}
          demoMode={isDemoModeActive()}
          onRegisterAddLease={registerLeaseAddHandler}
        />
      ) : null}

      {activeDetailTab === "calendar" && bucket === 2 && listingId && stablePropertyId ? (
        <ManagerPropertyCalendarPanel
          propertiesBase={propertiesBase}
          stage={stage}
          propertyRouteKey={propertyRouteKey}
          calendarSubTab={calendarSubTab}
          listingId={listingId}
          propertyId={stablePropertyId}
          managerUserId={managerUserId}
          propertyLabel={propertyShareLabel}
          submission={managerSubmission}
          showToast={showToast}
          onRegisterSendTour={registerTourSendHandler}
        />
      ) : null}

      {activeDetailTab === "promotion" && bucket === 2 && listingId ? (
        <ManagerPropertyPromotionPanel
          listingId={listingId}
          showToast={showToast}
          onUpdated={onUpdated}
          onRegisterNewPromotion={registerPromotionNewHandler}
        />
      ) : null}

      {activeDetailTab === "requests" && bucket === 2 && stablePropertyId ? (
        <ManagerPropertyRequestsPanel
          sub={managerSubmission}
          saveTarget={houseSaveTarget}
          managerUserId={managerUserId}
          onUpdated={onUpdated}
          showToast={showToast}
          onRegisterAddRequest={registerRequestAddHandler}
        />
      ) : null}

      </PortalPageScrollBody>

      {propertyTabFooterActions ? (
        <PortalPageFooterActions pinned rowVariant="header">
          {propertyTabFooterActions}
        </PortalPageFooterActions>
      ) : null}

      {listingId || stablePropertyId ? (
        <ShareLeadLinkModal
          open={shareApplicationOpen}
          onClose={() => setShareApplicationOpen(false)}
          kind="apply"
          properties={sharePropertyOptions}
          preselectedPropertyId={sharePropertyId || undefined}
        />
      ) : null}

      {listingEditorOpen && listingFormProps ? (
        <ManagerAddListingForm {...listingFormProps} wizardScope="full" />
      ) : null}

      {draftEditorOpen && draftFormProps ? (
        <ManagerAddListingForm {...draftFormProps} wizardScope="full" />
      ) : null}

      {destructiveModalCopy ? (
        <ConfirmDeleteModal
          open={pendingDestructiveAction !== null}
          title={destructiveModalCopy.title}
          description={destructiveModalCopy.description}
          confirmLabel={destructiveModalCopy.confirmLabel}
          busy={destructiveBusy}
          dataAttr={destructiveModalCopy.dataAttr}
          onClose={() => {
            if (!destructiveBusy) setPendingDestructiveAction(null);
          }}
          onConfirm={confirmDestructiveAction}
        />
      ) : null}

      {sharePropertyId ? (
        <PropertyResidentOnboardWizard
          open={residentOnboardOpen}
          propertyId={sharePropertyId}
          propertyLabel={propertyShareLabel}
          managerUserId={managerUserId}
          onClose={() => setResidentOnboardOpen(false)}
          onImported={() => {
            setResidentOnboardOpen(false);
            onUpdated();
          }}
          showToast={showToast}
        />
      ) : null}
    </div>
  );
}

export function ManagerHousePropertiesPanel({
  showToast,
  activeStage,
  onStageChange,
  onSendToProspect,
  skuTier,
  skuLoaded,
  propertiesBase,
  propertyKey: propertyKeyProp,
  detailTab: detailTabProp,
  calendarSubTab: calendarSubTabProp,
  onAddProperty,
  addPropertyDisabled = false,
}: {
  showToast: (m: string) => void;
  activeStage: ManagerStageKey;
  onStageChange: (stage: ManagerStageKey) => void;
  onSendToProspect?: (listingId: string) => void;
  skuTier: string | null;
  skuLoaded: boolean;
  propertiesBase: string;
  propertyKey?: string;
  detailTab?: PropertyDetailTabId;
  calendarSubTab?: PropertyCalendarSubTabId;
  onAddProperty?: () => void;
  addPropertyDisabled?: boolean;
}) {
  const router = useRouter();
  const { userId: managerUserId, ready: authReady } = useManagerUserId();
  const scopeUserId = resolveManagerScopeUserId(managerUserId);
  const [tick, setTick] = useState(0);
  const [detailHeaderActions, setDetailHeaderActions] = useState<ReactNode>(null);
  const detailHeaderKeyRef = useRef<string | null>(null);
  const handlePropertyUpdated = useCallback(() => setTick((t) => t + 1), []);
  const handleAfterUnlist = useCallback(
    (propertyKey: string) => {
      onStageChange("unlisted");
      if (propertyKeyProp) {
        router.push(
          propertyDetailHref(propertiesBase, "unlisted", propertyKey, detailTabProp ?? "preview"),
          { scroll: false },
        );
      } else {
        router.push(propertyListHref(propertiesBase, "unlisted"), { scroll: false });
      }
    },
    [detailTabProp, onStageChange, propertiesBase, propertyKeyProp, router],
  );
  const handleDetailHeaderActions = useCallback((key: string, actions: ReactNode) => {
    if (key === "none") {
      detailHeaderKeyRef.current = null;
      setDetailHeaderActions(null);
      return;
    }
    if (detailHeaderKeyRef.current === key) return;
    detailHeaderKeyRef.current = key;
    setDetailHeaderActions(actions);
  }, []);

  const propCount = useMemo(() => {
    void tick;
    return countManagerManagedPropertiesForUser(scopeUserId);
  }, [tick, scopeUserId]);

  useEffect(() => {
    if (!scopeUserId) return;
    if (!isDemoModeActive()) {
      // The local-pipeline mirror is NOT run here. `ManagerProperties` — this
      // panel's only parent — already mirrors the same owner's rows on mount,
      // and the writes are sequential now, so a second run doubled the POSTs
      // per page load and toasted a plan refusal twice. One owner, one run.
      void syncManagerPortfolioFromServer(scopeUserId, { force: true }).then(() => {
        setTick((t) => t + 1);
      });
    } else {
      setTick((t) => t + 1);
    }
    const on = (e: Event) => {
      // Demo mode has no server, and a sync-originated event has already written
      // the fresh snapshot locally — in both cases just re-read local state.
      // Forcing a sync on the sync's own event is a request feedback loop.
      if (isDemoModeActive() || isServerSyncOriginatedEvent(e)) {
        setTick((t) => t + 1);
        return;
      }
      void syncManagerPortfolioFromServer(scopeUserId, { force: true }).then(() => setTick((t) => t + 1));
    };
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    window.addEventListener("axis-pro-relationships", on);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
      window.removeEventListener("axis-pro-relationships", on);
    };
  }, [scopeUserId]);


  const rows = useMemo(() => {
    void tick;
    if (!scopeUserId) return [] as Array<{ sourceBucket: AdminPropertyBucketIndex; row: AdminPropertyRow; linked: boolean }>;
    const stage = MANAGER_STAGES.find((item) => item.key === activeStage);
    if (!stage) return [];
    const linkedIds = collectLinkedPropertyIds(scopeUserId);
    const mapped = stage.buckets.flatMap((bucket) =>
      readAdminPropertyRows(bucket, scopeUserId).map((row) => {
        const pid = row.listingId?.trim() || row.adminRefId.trim();
        return {
          sourceBucket: bucket,
          row,
          linked: propertyIdIsLinked(pid, linkedIds),
        };
      }),
    );
    return [...mapped].sort((a, b) => compareAdminPropertyRowsForDisplay(a.row, b.row));
  }, [tick, scopeUserId, activeStage]);

  const propertyKeyFromRow = (row: AdminPropertyRow) =>
    row.listingId?.trim() || row.adminRefId.trim();

  const routePropertyEntry = useMemo(() => {
    if (!propertyKeyProp) return null;
    const decoded = decodeURIComponent(propertyKeyProp);
    return (
      rows.find(
        ({ row }) => propertyKeyFromRow(row) === decoded || row.adminRefId === decoded,
      ) ?? null
    );
  }, [propertyKeyProp, rows]);

  if (!authReady) {
    return <p className="text-sm text-muted">Loading your properties…</p>;
  }
  if (!scopeUserId) {
    return <p className="text-sm text-muted">Sign in to view and manage your properties.</p>;
  }

  const renderRowDetail = (sourceBucket: AdminPropertyBucketIndex, row: AdminPropertyRow, rowKey: string) => (
    <ManagerPropertyInlineDetails
      key={rowKey}
      bucket={sourceBucket}
      row={row}
      dataRevision={tick}
      onUpdated={handlePropertyUpdated}
      onAfterUnlist={handleAfterUnlist}
      showToast={showToast}
      managerUserId={managerUserId}
      skuTier={skuTier}
      skuLoaded={skuLoaded}
      propCount={propCount}
      onSendToProspect={onSendToProspect}
      propertiesBase={propertiesBase}
      stage={activeStage}
      detailTab={detailTabProp}
      calendarSubTab={calendarSubTabProp}
      onDetailHeaderActions={propertyKeyProp ? handleDetailHeaderActions : undefined}
    />
  );

  if (propertyKeyProp) {
    if (!routePropertyEntry) {
      return (
        <PortalDataTableEmpty
          message="Property not found."
          icon="default"
        />
      );
    }
    const { sourceBucket, row } = routePropertyEntry;
    const rowKey = row.adminRefId + (row.listingId ?? "");
    const address = `${row.address}${row.zip ? `, ${row.zip}` : ""}`;
    return (
      <PortalRecordDetailPage
        title={managerPropertyRowTitle(row, sourceBucket)}
        subtitle={address}
        backHref={`${propertiesBase}/properties/${activeStage}`}
        backLabel="Back to properties"
        hideBackText
        bareHeader
        dataAttrBack="property-detail-back"
        actions={detailHeaderActions}
        inlineActions
        suppressMobileActions
        pinScrollBody
        scrollBody={false}
      >
        {renderRowDetail(sourceBucket, row, rowKey)}
      </PortalRecordDetailPage>
    );
  }

  return (
    <>
      {rows.length === 0 ? (
        onAddProperty ? (
          <div className={`${PORTAL_LIST_ADD_ROW_WRAP_CLASS} pt-5 sm:pt-6`}>
            <PortalListAddRow
              label="Add"
              ariaLabel="Add property"
              icon={PORTAL_LIST_ADD_ICONS.property}
              onClick={onAddProperty}
              disabled={addPropertyDisabled}
              dataAttr="properties-list-add"
            />
          </div>
        ) : null
      ) : (
        <div className={PORTAL_LIST_PAGE_BODY}>
          {rows.map(({ sourceBucket, row }) => {
            const rowKey = row.adminRefId + (row.listingId ?? "");
            const address = `${row.address}${row.zip ? `, ${row.zip}` : ""}`;
            const summary = `${adminPropertyRentDisplayLabel(row)} · ${row.beds} bd / ${row.baths} ba · ${row.neighborhood}`;
            return (
              <PortalPropertyRecordRow
                key={rowKey}
                title={managerPropertyRowTitle(row, sourceBucket)}
                address={address}
                summary={summary}
                onOpen={() => {
                  const routeKey = propertyKeyFromRow(row);
                  router.push(
                    propertyDetailHref(
                      propertiesBase,
                      activeStage,
                      routeKey,
                      detailTabProp ?? "preview",
                    ),
                    { scroll: false },
                  );
                }}
                dataAttr="property-list-row"
              />
            );
          })}
          {onAddProperty ? (
            <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
              <PortalListAddRow
                label="Add"
                ariaLabel="Add property"
                icon={PORTAL_LIST_ADD_ICONS.property}
                onClick={onAddProperty}
                disabled={addPropertyDisabled}
                dataAttr="properties-list-add"
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
