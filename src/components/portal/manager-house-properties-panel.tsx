"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
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
import { ManagerPropertyTourPanel } from "@/components/portal/manager-property-tour-panel";
import { ModalShell } from "@/components/ui/modal";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import { PortalPageChrome, PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { cn } from "@/lib/utils";
import { PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS } from "@/components/portal/portal-property-detail-section";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import {
  PROPERTY_DETAIL_TOP_TAB_LABELS,
  PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS,
  propertyDetailHref,
  propertyListHref,
  propertyDetailTopNavId,
  parsePropertyDetailTab,
  type PropertyDetailTabId,
  type PropertyDetailTopTabId,
} from "@/lib/portal-detail-routes";
import { ManagerPropertyRequestsPanel } from "@/components/portal/manager-property-requests-panel";
import { PropertyResidentOnboardWizard } from "@/components/portal/property-resident-onboard-wizard";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
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

/**
 * Stand-in for the listing wizard while its listing is still resolving from the
 * local mirror (AXI-141).
 *
 * It mirrors the wizard's own shell — same `ModalShell`, same panel shape — so
 * the swap to the real form is a content change rather than a modal that closes
 * and reopens. Closable, because a hydration that never lands must not trap the
 * manager in a spinner.
 */
function ListingEditorLoadingModal({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell
      open
      onClose={onClose}
      panelClassName="modal-panel relative z-10 flex max-h-[calc(100svh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-border shadow-2xl"
    >
      <div
        className="flex min-h-[16rem] flex-col items-center justify-center gap-3 px-6 py-16"
        role="status"
        aria-live="polite"
        data-attr="listing-editor-loading"
      >
        <span
          className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary"
          aria-hidden
        />
        <p className="text-sm font-medium text-muted">Opening listing…</p>
      </div>
    </ModalShell>
  );
}

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

function propertyRowDeleteFromQueueAllowed(
  managerUserId: string | null,
  entry: { sourceBucket: AdminPropertyBucketIndex; row: AdminPropertyRow; linked: boolean },
): boolean {
  if (entry.sourceBucket !== 3) return false;
  if (!entry.linked) return true;
  const stablePropertyId = entry.row.listingId?.trim() || entry.row.adminRefId.trim() || null;
  if (!managerUserId || !stablePropertyId) return false;
  return hasLinkedPropertyModuleLevel(managerUserId, stablePropertyId, "properties", "delete");
}

type PropertyListDestructiveAction = "delete-queue" | "delete-draft" | "unlist";

function propertyListDestructiveActionForEntry(
  managerUserId: string | null,
  entry: { sourceBucket: AdminPropertyBucketIndex; row: AdminPropertyRow; linked: boolean },
): PropertyListDestructiveAction | null {
  if (entry.sourceBucket === 5) return "delete-draft";
  if (entry.sourceBucket === 3 && propertyRowDeleteFromQueueAllowed(managerUserId, entry)) {
    return "delete-queue";
  }
  if (entry.sourceBucket === 2 && entry.row.listingId?.trim()) return "unlist";
  return null;
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
  onSendToProspect?: (listingIds: string | string[]) => void;
  propertiesBase: string;
  stage: ManagerStageKey;
  detailTab?: PropertyDetailTabId;
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
  const [portalSettingsOpen, setPortalSettingsOpen] = useState(false);
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


  const propertyDetailFooterBtn = PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS;
  const canEditListing = Boolean(displaySub && portalSub);
  // Show Edit only with write (`edit`) level and Delete only with `delete` level.
  // Own properties always qualify; a linked property is gated by the grant.
  const canEditAction = canEditListing && canEditLevel;
  const canDeleteAction = canEditListing && canDeleteLevel;
  // Listing edits/deletes for a linked property must mutate the OWNER's record.
  const listingOwnerUserId = portalSub?.ownerUserId ?? managerUserId;

  const openFullListingEditor = () => setListingEditorOpen(true);
  const dangerBtnClass = `${propertyDetailFooterBtn} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`;

  const leaseAddHandlerRef = useRef<(() => void) | null>(null);
  const registerLeaseAddHandler = useCallback((handler: (() => void) | null) => {
    leaseAddHandlerRef.current = handler;
  }, []);

  const applicationAddHandlerRef = useRef<(() => void) | null>(null);
  const registerApplicationAddHandler = useCallback((handler: (() => void) | null) => {
    applicationAddHandlerRef.current = handler;
  }, []);

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
  // Memoized so `topNavItems` below has a stable dependency. Rebuilt inline it
  // was a fresh array every render, which the compiler reads as a value that may
  // be mutated later and refuses to preserve the manual memo around.
  const availableTabs = useMemo<PropertyDetailTabId[]>(
    () =>
      bucket === 3 || bucket === 5
        ? ["preview"]
        : bucket === 2 && listingId
          ? ["preview", "house-details", "move-in", "application", "lease", "tours", "requests", "promotion"]
          : ["preview", "house-details", "move-in", "application", "lease"],
    [bucket, listingId],
  );
  const activeDetailTab = availableTabs.includes(detailTab) ? detailTab : availableTabs[0]!;
  const topNavItems = useMemo(() => {
    const items: Array<{
      id: string;
      label: string;
      shortLabel?: string;
      href: string;
      dataAttr: string;
    }> = [];
    const pushTopTab = (id: PropertyDetailTopTabId, tab: PropertyDetailTabId) => {
      if (!availableTabs.includes(tab)) return;
      items.push({
        id,
        label: PROPERTY_DETAIL_TOP_TAB_LABELS[id],
        shortLabel: PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS[id],
        href: propertyDetailHref(propertiesBase, stage, propertyRouteKey, tab),
        dataAttr: `property-detail-tab-${id}`,
      });
    };

    pushTopTab("preview", "preview");
    pushTopTab("house-details", "house-details");
    pushTopTab("move-in", "move-in");
    pushTopTab("tours", "tours");
    pushTopTab("application", "application");
    pushTopTab("lease", "lease");
    pushTopTab("requests", "requests");
    pushTopTab("promotion", "promotion");
    return items;
  }, [availableTabs, propertiesBase, propertyRouteKey, stage]);
  const activeTopNavId = propertyDetailTopNavId(activeDetailTab);
  const isListingPreview = activeDetailTab === "preview";

  const propertyTabFooterActions = useMemo(() => {
    if (isListingPreview) {
      const actions: PortalAdaptiveAction[] = [];

      if (bucket === 2 && listingId) {
        if (canEditAction) {
          actions.push({
            id: "edit-listing",
            node: (
              <Button
                type="button"
                variant="primary"
                className={propertyDetailFooterBtn}
                data-attr="listing-edit-full"
                onClick={() => openFullListingEditor()}
              >
                Edit listing
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                data-attr="listing-edit-full"
                onSelect={() => openFullListingEditor()}
              >
                Edit listing
              </DropdownMenuItem>
            ),
          });
        }
        actions.push({
          id: "send-listing",
          node: (
            <Button
              type="button"
              variant="outline"
              className={propertyDetailFooterBtn}
              data-attr="listing-send-listing"
              onClick={() => onSendToProspect?.(listingId)}
            >
              Send listing
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="listing-send-listing"
              onSelect={() => onSendToProspect?.(listingId)}
            >
              Send listing
            </DropdownMenuItem>
          ),
        });
        actions.push({
          id: "unlist",
          node: (
            <Button
              type="button"
              variant="outline"
              className={propertyDetailFooterBtn}
              data-attr="listing-unlist"
              onClick={() => setPendingDestructiveAction("unlist")}
            >
              Unlist
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="listing-unlist"
              onSelect={() => setPendingDestructiveAction("unlist")}
            >
              Unlist
            </DropdownMenuItem>
          ),
        });
      }

      if (bucket === 3) {
        actions.push({
          id: "relist",
          node: (
            <Button
              type="button"
              variant="primary"
              className={propertyDetailFooterBtn}
              data-attr="listing-relist"
              onClick={() => {
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
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="listing-relist"
              onSelect={() => {
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
            </DropdownMenuItem>
          ),
        });
        if (canEditListing && canEditAction) {
          actions.push({
            id: "edit-listing",
            node: (
              <Button
                type="button"
                variant="outline"
                className={propertyDetailFooterBtn}
                data-attr="listing-edit-full"
                onClick={() => openFullListingEditor()}
              >
                Edit listing
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                data-attr="listing-edit-full"
                onSelect={() => openFullListingEditor()}
              >
                Edit listing
              </DropdownMenuItem>
            ),
          });
        }
        if (canDeleteAction) {
          actions.push({
            id: "delete-queue",
            node: (
              <Button
                type="button"
                variant="outline"
                className={dangerBtnClass}
                data-attr="listing-delete"
                onClick={() => setPendingDestructiveAction("delete-queue")}
              >
                Delete from queue
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                data-attr="listing-delete"
                onSelect={() => setPendingDestructiveAction("delete-queue")}
              >
                Delete from queue
              </DropdownMenuItem>
            ),
          });
        }
      }

      if (bucket === 5) {
        actions.push({
          id: "continue-draft",
          node: (
            <Button
              type="button"
              variant="primary"
              className={propertyDetailFooterBtn}
              data-attr="draft-continue-editing"
              onClick={() => {
                if (!skuLoaded) {
                  showToast("Loading subscription…");
                  return;
                }
                setDraftEditorOpen(true);
              }}
            >
              Continue editing
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="draft-continue-editing"
              onSelect={() => {
                if (!skuLoaded) {
                  showToast("Loading subscription…");
                  return;
                }
                setDraftEditorOpen(true);
              }}
            >
              Continue editing
            </DropdownMenuItem>
          ),
        });
        actions.push({
          id: "delete-draft",
          node: (
            <Button
              type="button"
              variant="outline"
              className={dangerBtnClass}
              data-attr="draft-delete"
              onClick={() => setPendingDestructiveAction("delete-draft")}
            >
              Delete draft
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="draft-delete"
              onSelect={() => setPendingDestructiveAction("delete-draft")}
            >
              Delete draft
            </DropdownMenuItem>
          ),
        });
      }

      if (actions.length === 0) return null;
      return (
        <>
          {actions.map((action) => (
            <Fragment key={action.id}>{action.node}</Fragment>
          ))}
        </>
      );
    }
    return null;
  }, [
    isListingPreview,
    activeDetailTab,
    bucket,
    listingId,
    row,
    managerUserId,
    stablePropertyId,
    canEditAction,
    canEditListing,
    canDeleteAction,
    sharePropertyId,
    openFullListingEditor,
    onSendToProspect,
    showToast,
    onUpdated,
    skuLoaded,
    skuTier,
    propCount,
    dangerBtnClass,
  ]);

  const hasPinnedPropertyFooter =
    Boolean(propertyTabFooterActions) ||
    activeDetailTab === "house-details" ||
    activeDetailTab === "move-in" ||
    activeDetailTab === "tours";

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
            appearance="command"
          />
          {isListingPreview && hasPreview ? (
            <div className="w-full border-t border-border/60 bg-accent/30 px-1 py-1">
              <ListingStickySubnav
                mode="portal"
                appearance="portal"
                pinned
                className="mb-0 w-full max-w-full border-0 bg-transparent py-0 shadow-none"
              />
            </div>
          ) : null}
        </div>
      </PortalPageChrome>

      <PortalPageScrollBody
        className={cn(
          "min-w-0 max-w-full pt-3",
          hasPinnedPropertyFooter &&
            "pb-[calc(2.75rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))] lg:pb-3",
        )}
      >
      {isListingPreview ? (
        hasPreview ? (
          <>
            <ListingDetailSections
              property={previewProperty!}
              rich={rich!}
              portalEmbedded
              expandSectionsOnMobile
              managerPreviewChrome
              hidePortalSubnav
            />
          </>
        ) : bucket === 3 || bucket === 5 ? (
          <p className="text-sm text-muted">
            {bucket === 5
              ? "Finish the draft wizard to see a public preview."
              : "Relist this property to restore the public preview."}
          </p>
        ) : null
      ) : null}

      {activeDetailTab === "house-details" && bucket !== 3 && bucket !== 5 ? (
        <ManagerPropertyHouseDetailsPanel
          noteKey={noteKey}
          sub={managerSubmission}
          saveTarget={houseSaveTarget}
          managerUserId={managerUserId}
          onUpdated={onUpdated}
          showToast={showToast}
        />
      ) : null}

      {activeDetailTab === "move-in" && bucket !== 3 && bucket !== 5 ? (
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

      {activeDetailTab === "tours" && bucket === 2 && listingId ? (
        <ManagerPropertyTourPanel
          listingId={listingId}
          managerUserId={managerUserId}
          propertyLabel={propertyShareLabel}
          showToast={showToast}
        />
      ) : null}

      {activeDetailTab === "promotion" && bucket === 2 && listingId ? (
        <ManagerPropertyPromotionPanel
          listingId={listingId}
          showToast={showToast}
          onUpdated={onUpdated}
        />
      ) : null}

      {activeDetailTab === "requests" && bucket === 2 && stablePropertyId ? (
        <ManagerPropertyRequestsPanel
          sub={managerSubmission}
          saveTarget={houseSaveTarget}
          managerUserId={managerUserId}
          onUpdated={onUpdated}
          showToast={showToast}
        />
      ) : null}

      </PortalPageScrollBody>

      {propertyTabFooterActions ? (
        <PortalPageFooterActions pinned rowVariant="header" omitSpacer>
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

      {/*
        Edit resolves its listing from the local mirror, which can still be
        hydrating on the first click. Until then `listingFormProps` is null and
        this rendered NOTHING — the manager tapped Edit and the screen sat there
        for a beat with no acknowledgement, which is what AXI-141 reports. The
        placeholder makes the click land immediately and is replaced by the real
        wizard the moment the listing resolves.
      */}
      {listingEditorOpen && !listingFormProps ? (
        <ListingEditorLoadingModal onClose={() => setListingEditorOpen(false)} />
      ) : null}

      {draftEditorOpen && draftFormProps ? (
        <ManagerAddListingForm {...draftFormProps} wizardScope="full" />
      ) : null}

      {draftEditorOpen && !draftFormProps ? (
        <ListingEditorLoadingModal onClose={() => setDraftEditorOpen(false)} />
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

      <ManagerPortalSettingsModal
        open={portalSettingsOpen}
        onClose={() => setPortalSettingsOpen(false)}
        initialTab="calendar"
        scopedTitle="Tour"
      />
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
  onAddProperty,
  addPropertyDisabled = false,
}: {
  showToast: (m: string) => void;
  activeStage: ManagerStageKey;
  onStageChange: (stage: ManagerStageKey) => void;
  onSendToProspect?: (listingIds: string | string[]) => void;
  skuTier: string | null;
  skuLoaded: boolean;
  propertiesBase: string;
  propertyKey?: string;
  detailTab?: PropertyDetailTabId;
  onAddProperty?: () => void;
  addPropertyDisabled?: boolean;
}) {
  const router = useRouter();
  const { userId: managerUserId, ready: authReady } = useManagerUserId();
  const scopeUserId = resolveManagerScopeUserId(managerUserId);
  const [tick, setTick] = useState(0);
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

  const propertyRowKey = (row: AdminPropertyRow) => row.adminRefId + (row.listingId ?? "");
  const propertyKeyFromRow = (row: AdminPropertyRow) =>
    row.listingId?.trim() || row.adminRefId.trim();

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(activeStage);
  const selectedPropertyEntries = useMemo(
    () => rows.filter(({ row }) => selectedIds.has(propertyRowKey(row))),
    [rows, selectedIds],
  );

  const canBulkEdit = selectedPropertyEntries.length === 1;
  // Share is NOT gated on a single selection the way Edit is. The share modal's
  // `listing` and `apply` kinds are multi-select by design — several listings
  // become a filtered browse link — so requiring exactly one hid the multi-send
  // the modal already supported (AXI-140).
  const canBulkShareProperties =
    Boolean(onSendToProspect) && activeStage === "listed" && selectedPropertyEntries.length > 0;
  const canBulkUnlist =
    activeStage === "listed" &&
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every(
      ({ sourceBucket, row }) => sourceBucket === 2 && Boolean(row.listingId?.trim()),
    );
  const canBulkRelist =
    activeStage === "unlisted" &&
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every(({ sourceBucket }) => sourceBucket === 3);
  const canBulkDeleteQueue =
    activeStage === "unlisted" &&
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every((entry) => propertyRowDeleteFromQueueAllowed(managerUserId, entry));
  const canBulkDeleteDrafts =
    activeStage === "drafts" &&
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every(({ sourceBucket }) => sourceBucket === 5);

  const openSelectedPropertyDetail = useCallback(() => {
    const first = selectedPropertyEntries[0];
    if (!first) return;
    router.push(
      propertyDetailHref(
        propertiesBase,
        activeStage,
        propertyKeyFromRow(first.row),
        detailTabProp ?? "preview",
      ),
      { scroll: false },
    );
    clearSelection();
  }, [
    activeStage,
    clearSelection,
    detailTabProp,
    propertiesBase,
    propertyKeyFromRow,
    router,
    selectedPropertyEntries,
  ]);

  const runBulkRelist = useCallback(() => {
    if (!canBulkRelist) return;
    if (!skuLoaded) {
      showToast("Loading subscription…");
      return;
    }
    if (managerTierPropertyLimitReached(skuTier, propCount)) {
      showToast(managerPropertyLimitMessage(skuTier, { omitUpgradeCta: isNativeRuntimeSync() }));
      return;
    }
    deferCatalogMutation(() => {
      let relisted = 0;
      for (const { row } of selectedPropertyEntries) {
        const id = listAdminRow(row, managerUserId);
        if (id) relisted += 1;
      }
      clearSelection();
      if (relisted === 0) {
        showToast("Could not relist.");
        return;
      }
      handlePropertyUpdated();
      showToast(
        relisted === 1 ? "Listing is live again." : `${relisted} properties relisted.`,
      );
    });
  }, [
    canBulkRelist,
    clearSelection,
    handlePropertyUpdated,
    managerUserId,
    propCount,
    selectedPropertyEntries,
    showToast,
    skuLoaded,
    skuTier,
  ]);

  const [pendingBulkDestructive, setPendingBulkDestructive] = useState<
    "delete-queue" | "unlist" | null
  >(null);
  const [bulkDestructiveBusy, setBulkDestructiveBusy] = useState(false);

  const confirmBulkDestructive = useCallback(() => {
    if (!pendingBulkDestructive || selectedPropertyEntries.length === 0) return;
    const action = pendingBulkDestructive;
    setBulkDestructiveBusy(true);
    deferCatalogMutation(() => {
      if (action === "delete-queue") {
        let removed = 0;
        for (const { row } of selectedPropertyEntries) {
          if (deleteUnlistedManagerProperty(row.adminRefId, managerUserId)) removed += 1;
        }
        setBulkDestructiveBusy(false);
        setPendingBulkDestructive(null);
        clearSelection();
        if (removed === 0) {
          showToast("Action could not be completed.");
          return;
        }
        handlePropertyUpdated();
        showToast(
          removed === 1 ? "Removed from queue." : `${removed} properties removed from queue.`,
        );
        return;
      }
      if (action === "unlist") {
        let unlisted = 0;
        let lastPropertyKey: string | null = null;
        for (const { row } of selectedPropertyEntries) {
          const listingId = row.listingId?.trim();
          if (!listingId) continue;
          if (unlistManagerListing(listingId, managerUserId)) {
            unlisted += 1;
            lastPropertyKey = listingId || row.adminRefId.trim();
          }
        }
        setBulkDestructiveBusy(false);
        setPendingBulkDestructive(null);
        clearSelection();
        if (unlisted === 0) {
          showToast("Could not unlist.");
          return;
        }
        handlePropertyUpdated();
        showToast(unlisted === 1 ? "Listing unlisted." : `${unlisted} listings unlisted.`);
        if (lastPropertyKey && unlisted === 1) {
          handleAfterUnlist(lastPropertyKey);
        } else if (unlisted > 1) {
          onStageChange("unlisted");
          router.push(propertyListHref(propertiesBase, "unlisted"), { scroll: false });
        }
      }
    });
  }, [
    clearSelection,
    handleAfterUnlist,
    handlePropertyUpdated,
    managerUserId,
    onStageChange,
    pendingBulkDestructive,
    propertiesBase,
    router,
    selectedPropertyEntries,
    showToast,
  ]);

  const bulkDestructiveModalCopy =
    pendingBulkDestructive === "delete-queue"
      ? {
          title: "Delete from queue",
          description:
            selectedPropertyEntries.length === 1
              ? `Remove ${managerPropertyRowTitle(selectedPropertyEntries[0]!.row, selectedPropertyEntries[0]!.sourceBucket)} from your unlisted queue permanently?`
              : `Remove ${selectedPropertyEntries.length} properties from your unlisted queue permanently?`,
          confirmLabel: "Delete from queue",
          dataAttr: "properties-bulk-delete-queue-confirm",
        }
      : pendingBulkDestructive === "unlist"
        ? {
            title: selectedPropertyEntries.length === 1 ? "Unlist property" : "Unlist properties",
            description:
              selectedPropertyEntries.length === 1
                ? `Unlist ${managerPropertyRowTitle(selectedPropertyEntries[0]!.row, selectedPropertyEntries[0]!.sourceBucket)}? It will be removed from the public listing and moved to your unlisted queue.`
                : `Unlist ${selectedPropertyEntries.length} properties? They will be removed from public listings and moved to your unlisted queue.`,
            confirmLabel: "Unlist",
            dataAttr: "properties-bulk-unlist-confirm",
          }
        : null;

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
        suppressMobileActions
        pinScrollBody
        scrollBody={false}
      >
        {renderRowDetail(sourceBucket, row, rowKey)}
      </PortalRecordDetailPage>
    );
  }

  const hasRows = rows.length > 0;
  const renderAddPropertyRow = () =>
    onAddProperty ? (
      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
        <PortalListAddRow
          label="Add property"
          ariaLabel="Add property"
          icon={PORTAL_LIST_ADD_ICONS.property}
          onClick={onAddProperty}
          disabled={addPropertyDisabled}
          dataAttr="manager-properties-create"
          className="portal-list-add-row--property min-h-[11rem] sm:min-h-[12.5rem] sm:py-14 [&>svg]:h-10 [&>svg]:w-10 [&_span_span]:text-xs sm:[&_span_span]:text-sm"
        />
      </div>
    ) : null;

  return (
    <>
      {hasRows ? (
        <div className={PORTAL_LIST_PAGE_BODY}>
          {rows.map(({ sourceBucket, row, linked }) => {
            const rowKey = row.adminRefId + (row.listingId ?? "");
            const address = `${row.address}${row.zip ? `, ${row.zip}` : ""}`;
            const summary = `${adminPropertyRentDisplayLabel(row)} · ${row.beds} bd / ${row.baths} ba · ${row.neighborhood}`;
            return (
              <PortalPropertyRecordRow
                key={rowKey}
                title={managerPropertyRowTitle(row, sourceBucket)}
                address={address}
                summary={summary}
                checked={selectedIds.has(rowKey)}
                onSelectedChange={() => toggleSelected(rowKey)}
                badge={
                  linked ? (
                    <Badge tone="info">
                      Co-managed
                    </Badge>
                  ) : undefined
                }
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
          {renderAddPropertyRow()}
        </div>
      ) : (
        <div className={PORTAL_LIST_PAGE_BODY}>{renderAddPropertyRow()}</div>
      )}
      {selectedIds.size > 0 ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            {canBulkEdit ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="properties-bulk-edit"
                onClick={openSelectedPropertyDetail}
              >
                Edit
              </Button>
            ) : null}
            {canBulkShareProperties ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="properties-bulk-share"
                onClick={() => {
                  if (!onSendToProspect) return;
                  const keys = selectedPropertyEntries
                    .map(({ row }) => propertyKeyFromRow(row))
                    .filter(Boolean);
                  if (keys.length === 0) return;
                  onSendToProspect(keys.length === 1 ? keys[0]! : keys);
                  clearSelection();
                }}
              >
                {selectedPropertyEntries.length > 1
                  ? `Share ${selectedPropertyEntries.length}`
                  : "Share"}
              </Button>
            ) : null}
            {canBulkUnlist ? (
              <Button
                type="button"
                variant="outline"
                className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
                data-attr="properties-bulk-unlist"
                onClick={() => setPendingBulkDestructive("unlist")}
              >
                Unlist
              </Button>
            ) : null}
            {canBulkRelist ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="properties-bulk-relist"
                onClick={runBulkRelist}
              >
                Relist
              </Button>
            ) : null}
            {canBulkDeleteQueue ? (
              <Button
                type="button"
                variant="outline"
                className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
                data-attr="properties-bulk-delete-queue"
                onClick={() => setPendingBulkDestructive("delete-queue")}
              >
                Delete
              </Button>
            ) : null}
            {canBulkDeleteDrafts ? (
              <Button
                type="button"
                variant="outline"
                className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
                data-attr="properties-bulk-delete-draft"
                onClick={() => {
                  if (
                    !window.confirm(
                      `Delete ${selectedPropertyEntries.length} draft${selectedPropertyEntries.length === 1 ? "" : "s"}?`,
                    )
                  ) {
                    return;
                  }
                  void (async () => {
                    for (const { row } of selectedPropertyEntries) {
                      await deleteManagerPropertyDraft(row.adminRefId, scopeUserId ?? undefined);
                    }
                    clearSelection();
                    handlePropertyUpdated();
                    showToast(
                      selectedPropertyEntries.length === 1
                        ? "Draft deleted."
                        : `${selectedPropertyEntries.length} drafts deleted.`,
                    );
                  })();
                }}
              >
                Delete draft
              </Button>
            ) : null}
          </div>
        </BulkActionBar>
      ) : null}
      {bulkDestructiveModalCopy ? (
        <ConfirmDeleteModal
          open={pendingBulkDestructive !== null}
          title={bulkDestructiveModalCopy.title}
          description={bulkDestructiveModalCopy.description}
          confirmLabel={bulkDestructiveModalCopy.confirmLabel}
          busy={bulkDestructiveBusy}
          dataAttr={bulkDestructiveModalCopy.dataAttr}
          onClose={() => {
            if (!bulkDestructiveBusy) setPendingBulkDestructive(null);
          }}
          onConfirm={confirmBulkDestructive}
        />
      ) : null}
    </>
  );
}
