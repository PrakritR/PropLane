"use client";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

import { WORKSPACE_SELECTION_EVENT, activeWorkspaceScope, propertiesOutsideActiveWorkspace, workspaceContainsProperty } from "@/lib/workspaces/selection";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Copy, Eye, Home, Pencil, Share2, Trash2 } from "lucide-react";
import {
  propertyRowAddress,
  propertyRowAddressLine,
  propertyRowMeta,
  propertyRowThumbnail,
  propertyRowTitle,
} from "@/lib/property-row-summary";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import {
  propertyAttention,
  propertyAttentionParts,
  type PropertyAttention,
} from "@/lib/property-attention";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalDetailDestinationNav } from "@/components/portal/portal-detail-destination-nav";
import { PortalPropertyRail } from "@/components/portal/portal-property-rail";
import type { MockProperty } from "@/data/types";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { ListingStickySubnav } from "@/components/marketing/listing-detail-subnav";
import { getListingRichContent } from "@/data/listing-rich-content";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import { ManagerPropertyBookingsPanel } from "@/components/portal/pro-property-bookings-panel";
import { ManagerPropertyHouseDetailsPanel } from "@/components/portal/pro-property-house-details-panel";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/pro-property-room-move-in-panel";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { ManagerPropertyPromotionPanel } from "@/components/portal/pro-property-promotion-panel";
import { ManagerPropertyAiInfoPanel } from "@/components/portal/pro-property-ai-info-panel";
import { ManagerPropertyTourPanel } from "@/components/portal/pro-property-tour-panel";
import { ModalShell } from "@/components/ui/modal";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import { PortalPageChrome, PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { cn } from "@/lib/utils";
import {
  PortalPropertySectionList,
  type PortalPropertySectionItem,
} from "@/components/portal/portal-property-section-list";
import { PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS } from "@/components/portal/portal-property-detail-section";
import { PortalRecordActions, PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import {
  PROPERTY_DETAIL_TOP_TAB_DESCRIPTIONS,
  PROPERTY_DETAIL_TOP_TAB_LABELS,
  PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS,
  propertyDetailHref,
  propertyListHref,
  propertyTourListHref,
  propertyDetailTopNavId,
  parsePropertyDetailTab,
  type ManagerTourBucketId,
  type PropertyDetailTabId,
  type PropertyDetailTopTabId,
} from "@/lib/portal-detail-routes";
import { ManagerPropertyRequestsPanel } from "@/components/portal/pro-property-requests-panel";
import { PropertyResidentOnboardWizard } from "@/components/portal/property-resident-onboard-wizard";
import { PortalPropertyRecordRow, PortalRowStatusChip } from "@/components/portal/portal-record-row";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { LEASE_PIPELINE_EVENT } from "@/lib/lease-pipeline-storage";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useListingContactSmsPhone } from "@/hooks/use-listing-contact-sms-phone";
import { useListingContactWorkEmail } from "@/hooks/use-listing-contact-work-email";
import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import {
  compareAdminPropertyRowsForDisplay,
  deleteManagerPropertyDraft,
  deleteUnlistedManagerProperty,
  duplicateManagerPropertyDraftToServer,
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
import { withListingContactSmsPhone, withListingContactWorkEmail } from "@/lib/listing-contact-sms";
import { useConfirm } from "@/components/providers/app-ui-provider";

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

function listingSubmissionForDuplicate(
  row: AdminPropertyRow,
  managerUserId: string,
): ManagerListingSubmissionV1 {
  const listingId = row.listingId?.trim();
  if (listingId) {
    const ownerId = linkedPropertyOwnerId(managerUserId, listingId) ?? managerUserId;
    const owned = readExtraListingsForUser(ownerId).find((x) => x.id === listingId);
    if (owned) return submissionForListedEdit(owned);
    if (ownerId !== managerUserId) {
      const own = readExtraListingsForUser(managerUserId).find((x) => x.id === listingId);
      if (own) return submissionForListedEdit(own);
    }
  }
  return submissionForAdminRow(row);
}

function propertyRowCanDuplicate(
  managerUserId: string | null,
  entry: { linked: boolean; row: AdminPropertyRow },
): boolean {
  if (!managerUserId) return false;
  if (!entry.linked) return true;
  const pid = entry.row.listingId?.trim() || entry.row.adminRefId.trim();
  return hasLinkedPropertyModuleLevel(managerUserId, pid, "properties", "edit");
}

async function duplicatePropertyRowAsDraft(opts: {
  row: AdminPropertyRow;
  managerUserId: string | null;
  showToast: (message: string) => void;
  onOpenDraft: (draftId: string) => void;
  onUpdated: () => void;
}): Promise<void> {
  const { row, managerUserId, showToast, onOpenDraft, onUpdated } = opts;
  if (!managerUserId) {
    showToast("Could not duplicate.");
    return;
  }
  const id = await duplicateManagerPropertyDraftToServer(
    listingSubmissionForDuplicate(row, managerUserId),
    managerUserId,
    { onError: () => showToast("Could not duplicate.") },
  );
  if (!id) {
    showToast("Could not duplicate.");
    return;
  }
  onUpdated();
  showToast("Draft created.");
  onOpenDraft(id);
}

/** Lets the browser paint after click before heavy localStorage writes (better INP on delete/unlist). */
function deferCatalogMutation(fn: () => void) {
  requestAnimationFrame(() => {
    requestAnimationFrame(fn);
  });
}

/*
 * "Like Zillow all houses are there. When I need to list I just click."
 *
 * The three stage tabs put a house the manager took off the market on a different
 * screen from the one they are letting, so an unlisted home was simply not "there"
 * when they looked. All is the default now: every house, with its state shown on the
 * row and a switch to flip it. The three narrower tabs stay as filters.
 */
const MANAGER_STAGES = [
  { key: "all", label: "All", buckets: [2, 3, 5] as AdminPropertyBucketIndex[] },
  { key: "listed", label: "Listed", buckets: [2] as AdminPropertyBucketIndex[] },
  { key: "unlisted", label: "Unlisted", buckets: [3] as AdminPropertyBucketIndex[] },
  { key: "drafts", label: "Drafts", buckets: [5] as AdminPropertyBucketIndex[] },
] as const;

export type ManagerStageKey = (typeof MANAGER_STAGES)[number]["key"];

/**
 * A draft can be saved before it has a name — never render an empty title cell.
 * A blank or bare-number name falls back to the street (see `propertyRowTitle`);
 * only a home with no address at all shows the placeholder.
 */
function managerPropertyRowTitle(row: AdminPropertyRow, bucket: AdminPropertyBucketIndex): string {
  const title = propertyRowTitle(row);
  if (title !== "Untitled property") return title;
  return bucket === 5 ? "Untitled draft" : "Untitled property";
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
  return MANAGER_STAGES.some((stage) => stage.key === raw) ? (raw as ManagerStageKey) : "all";
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
  propertyTourBucket = "pending",
  propertyTourId,
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
  propertyTourBucket?: ManagerTourBucketId;
  propertyTourId?: string;
}) {
  const detailRouter = useRouter();
  const detailPathname = usePathname();
  const detailSearchParams = useSearchParams();
  const mock = useMemo(() => (row ? resolveAdminPropertyRowPreview(row) : null), [row]);
  const contactSmsPhone = useListingContactSmsPhone({
    listingId: row?.listingId,
    ownerManagerUserId: row?.managerUserId,
    viewerManagerUserId: managerUserId,
  });
  // The preview shows BOTH of the manager's doors — the work number and the
  // work email — resolved the way the public page resolves them, so a manager
  // checking "how renters see this home" sees the same Text / Email buttons.
  const contactWorkEmail = useListingContactWorkEmail({
    listingId: row?.listingId,
    ownerManagerUserId: row?.managerUserId,
    viewerManagerUserId: managerUserId,
  });
  const previewProperty = useMemo(
    () =>
      mock
        ? withListingContactWorkEmail(withListingContactSmsPhone(mock, contactSmsPhone), contactWorkEmail)
        : null,
    [mock, contactSmsPhone, contactWorkEmail],
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
  const [duplicateBusy, setDuplicateBusy] = useState(false);
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
  const canDuplicateAction = Boolean(row && managerUserId && canEditLevel);
  const runDuplicateProperty = () => {
    if (!row || duplicateBusy || !canDuplicateAction) return;
    setDuplicateBusy(true);
    void duplicatePropertyRowAsDraft({
      row,
      managerUserId,
      showToast,
      onUpdated,
      onOpenDraft: (id) => {
        detailRouter.push(
          `${propertyDetailHref(propertiesBase, "all", id, "preview")}?edit=1`,
          { scroll: false },
        );
      },
    }).finally(() => setDuplicateBusy(false));
  };
  const duplicateFooterAction = (): PortalAdaptiveAction => ({
    id: "duplicate-listing",
    node: (
      <Button
        type="button"
        variant="outline"
        className={propertyDetailFooterBtn}
        data-attr="listing-duplicate"
        aria-label="Duplicate"
        title="Duplicate"
        disabled={duplicateBusy}
        onClick={() => runDuplicateProperty()}
      >
        <Copy className="size-4" aria-hidden />
        <span className="sr-only">Duplicate</span>
      </Button>
    ),
    menuItem: (
      <DropdownMenuItem
        data-attr="listing-duplicate"
        disabled={duplicateBusy}
        onSelect={() => runDuplicateProperty()}
      >
        Duplicate
      </DropdownMenuItem>
    ),
  });
  useEffect(() => {
    if (detailSearchParams.get("edit") !== "1") return;
    if (bucket === 5) {
      setDraftEditorOpen(true);
    } else if (canEditAction) {
      setListingEditorOpen(true);
    } else if (!canEditListing) {
      return;
    }
    detailRouter.replace(detailPathname, { scroll: false });
  }, [bucket, canEditAction, canEditListing, detailPathname, detailRouter, detailSearchParams]);
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
            title: "Delete",
            description: `Delete ${propertyShareLabel}? Your saved progress will be removed.`,
            confirmLabel: "Delete",
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
        /* Publishing an EDIT writes the listing in place — there is no new id to follow. */
        onPublished: () => {
          setListingEditorOpen(false);
          onUpdated();
        },
        onSaved: () => {
          onUpdated();
        },
        showToast,
        skuTier,
        userId: managerUserId,
        propertyCount: propCount,
        initialSubmission: portalSub.sub,
        editListingId: portalSub.saveId,
        editListingOwnerUserId: portalSub.ownerUserId ?? null,
      }
    : null;

  // Resume a saved draft in the full wizard. On final submit the wizard publishes
  // this draft in place (draft → live) and removes it from the drafts bucket.
  const draftFormProps =
    bucket === 5 && managerUserId
      ? {
          onClose: () => setDraftEditorOpen(false),
          onPublished: (listingId?: string) => {
            setDraftEditorOpen(false);
            showToast("Listing submitted and published.");
            onUpdated();
            // This detail page IS the draft's URL, and publishing moves the row
            // out of the Drafts bucket — staying put rendered "Property not
            // found." as the reward for finishing the wizard. Follow the record
            // to its Listed URL instead; the id is unchanged by publishing
            // (draft → live is the same record), so the link is stable (PRP-429).
            const published = listingId?.trim();
            if (published) {
              detailRouter.replace(
                propertyDetailHref(propertiesBase, "listed", published, "preview"),
                { scroll: false },
              );
            }
          },
          onSaved: () => onUpdated(),
          showToast,
          skuTier,
          userId: managerUserId,
          propertyCount: propCount,
          initialSubmission: managerSubmission,
          initialDraftId: row?.adminRefId ?? null,
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
          ? ["preview", "house-details", "move-in", "application", "lease", "tours", "bookings", "requests", "promotion", "ai-info"]
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
      const href =
        tab === "tours"
          ? propertyTourListHref(propertiesBase, stage, propertyRouteKey, "pending")
          : propertyDetailHref(propertiesBase, stage, propertyRouteKey, tab);
      items.push({
        id,
        label: PROPERTY_DETAIL_TOP_TAB_LABELS[id],
        shortLabel: PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS[id],
        href,
        dataAttr: `property-detail-tab-${id}`,
      });
    };

    pushTopTab("preview", "preview");
    pushTopTab("house-details", "house-details");
    pushTopTab("move-in", "move-in");
    pushTopTab("tours", "tours");
    pushTopTab("bookings", "bookings");
    pushTopTab("application", "application");
    pushTopTab("lease", "lease");
    pushTopTab("requests", "requests");
    pushTopTab("promotion", "promotion");
    pushTopTab("ai-info", "ai-info");
    return items;
  }, [availableTabs, propertiesBase, propertyRouteKey, stage]);
  /**
   * The same nine destinations as `topNavItems`, but NONE are dropped: a
   * section this home cannot use yet stays on the list and says why. The strip
   * hid them, which is how three features became invisible on a phone.
   */
  const sectionListItems = useMemo<PortalPropertySectionItem[]>(() => {
    const order: Array<[PropertyDetailTopTabId, PropertyDetailTabId]> = [
      ["preview", "preview"],
      ["house-details", "house-details"],
      ["move-in", "move-in"],
      ["tours", "tours"],
      ["bookings", "bookings"],
      ["application", "application"],
      ["lease", "lease"],
      ["requests", "requests"],
      ["promotion", "promotion"],
      ["ai-info", "ai-info"],
    ];
    return order.map(([id, tab]) => {
      const available = availableTabs.includes(tab);
      const href =
        tab === "tours"
          ? propertyTourListHref(propertiesBase, stage, propertyRouteKey, "pending")
          : propertyDetailHref(propertiesBase, stage, propertyRouteKey, tab);
      return {
        id,
        label: PROPERTY_DETAIL_TOP_TAB_LABELS[id],
        description: PROPERTY_DETAIL_TOP_TAB_DESCRIPTIONS[id],
        href,
        dataAttr: `property-section-row-${id}`,
        unavailableReason: available ? undefined : "Available once this home is listed",
      } satisfies PortalPropertySectionItem;
    });
  }, [availableTabs, propertiesBase, propertyRouteKey, stage]);

  const activeTopNavId = propertyDetailTopNavId(activeDetailTab);
  const isListingPreview = activeDetailTab === "preview";

  const propertyTabFooterActions = useMemo(() => {
    if (isListingPreview) {
      const actions: PortalAdaptiveAction[] = [];

      if (bucket === 2 && listingId) {
        actions.push({
          id: "view-listing",
          node: (
            <Button
              type="button"
              variant="outline"
              className={propertyDetailFooterBtn}
              data-attr="listing-view"
              aria-label="View"
              title="View"
              onClick={() => window.open(`/rent/listings/${encodeURIComponent(listingId)}`, "_blank", "noopener")}
            >
              <Eye className="size-4" aria-hidden />
              <span className="sr-only">View</span>
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="listing-view"
              onSelect={() => window.open(`/rent/listings/${encodeURIComponent(listingId)}`, "_blank", "noopener")}
            >
              View
            </DropdownMenuItem>
          ),
        });
        if (canEditAction) {
          actions.push({
            id: "edit-listing",
            node: (
              <Button
                type="button"
                variant="primary"
                className={propertyDetailFooterBtn}
                data-attr="listing-edit-full"
                aria-label="Edit"
                title="Edit"
                onClick={() => openFullListingEditor()}
              >
                <Pencil className="size-4" aria-hidden />
                <span className="sr-only">Edit</span>
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                data-attr="listing-edit-full"
                onSelect={() => openFullListingEditor()}
              >
                Edit
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
              aria-label="Send"
              title="Send"
              onClick={() => onSendToProspect?.(listingId)}
            >
              <Share2 className="size-4" aria-hidden />
              <span className="sr-only">Send</span>
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="listing-send-listing"
              onSelect={() => onSendToProspect?.(listingId)}
            >
              Send
            </DropdownMenuItem>
          ),
        });
        if (canDuplicateAction) actions.push(duplicateFooterAction());
        actions.push({
          id: "unlist",
          node: (
            <Button
              type="button"
              variant="outline"
              className={dangerBtnClass}
              data-attr="listing-unlist"
              aria-label="Unlist"
              title="Unlist"
              onClick={() => setPendingDestructiveAction("unlist")}
            >
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only">Unlist</span>
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
              Relist
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
              Relist
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
                Edit
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                data-attr="listing-edit-full"
                onSelect={() => openFullListingEditor()}
              >
                Edit
              </DropdownMenuItem>
            ),
          });
        }
        if (canDuplicateAction) actions.push(duplicateFooterAction());
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
                Delete
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                data-attr="listing-delete"
                onSelect={() => setPendingDestructiveAction("delete-queue")}
              >
                Delete
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
              aria-label="Edit"
              title="Edit"
              onClick={() => {
                if (!skuLoaded) {
                  showToast("Loading subscription…");
                  return;
                }
                setDraftEditorOpen(true);
              }}
            >
              {/* A draft has two actions: the title row shows a pencil and a
                  trash can at every width (see iconTitleActions); the words
                  live in the aria-label and the tooltip. */}
              <Pencil className="size-4" aria-hidden />
              <span className="sr-only">Edit</span>
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
              Edit
            </DropdownMenuItem>
          ),
        });
        if (canDuplicateAction) actions.push(duplicateFooterAction());
        actions.push({
          id: "delete-draft",
          node: (
            <Button
              type="button"
              variant="outline"
              className={dangerBtnClass}
              data-attr="draft-delete"
              aria-label="Delete"
              title="Delete"
              onClick={() => setPendingDestructiveAction("delete-draft")}
            >
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only">Delete</span>
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem
              data-attr="draft-delete"
              onSelect={() => setPendingDestructiveAction("delete-draft")}
            >
              Delete
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
    canDuplicateAction,
    duplicateBusy,
    sharePropertyId,
    openFullListingEditor,
    runDuplicateProperty,
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
    activeDetailTab === "bookings" ||
    activeDetailTab === "application" ||
    activeDetailTab === "lease";

  // Every hook above runs unconditionally. This guard used to sit ~470 lines earlier, so a
  // row/mock/submission flipping between renders changed the hook COUNT, which is the
  // rules-of-hooks violation React throws "rendered more hooks than during the previous
  // render" on. It gates rendering only.
  if (!row || !mock || !managerSubmission) return null;

  return (
    <div className="flex min-h-0 flex-1 lg:flex-row">
      <PortalPropertyRail
        items={topNavItems}
        activeId={activeTopNavId}
        backHref={propertyListHref(propertiesBase, stage)}
        showBackLink={false}
        showTitleBlock={false}
        title={managerPropertyRowTitle(row, bucket)}
        subtitle={row.address}
        className="lg:mr-5 lg:rounded-xl lg:border lg:bg-card"
      />
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PortalPageChrome>
        <div
          className="border-b border-border/40 bg-background"
          data-portal-property-detail-chrome
        >
          {/* Desktop keeps the listing section tabs pinned at the top of the
              preview pane. A phone gets them in the scrolling body instead,
              under the sections disclosure and on top of the preview they
              jump around — see the copy below. */}
          {isListingPreview && hasPreview ? (
            <div className="hidden w-full border-t border-border/60 bg-accent/30 px-1 py-1 lg:block">
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
          hasPinnedPropertyFooter && "pb-3",
        )}
      >
      {/*
        Phones get the list, not the strip. It sits in the SCROLLING body, not
        the pinned chrome: the chrome is a fixed band, so a disclosure opening
        inside it expanded to nothing at all. Open on the landing tab so
        arriving at a property shows everything it can do; collapsed on a deeper
        tab so the nav never buries the content. Desktop keeps its left rail.
      */}
      <details
        className="group mb-3 lg:hidden"
        open={activeDetailTab === "preview"}
        data-attr="property-sections-disclosure"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg border border-border bg-card px-3 text-[13.5px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 truncate">
            {PROPERTY_DETAIL_TOP_TAB_LABELS[activeTopNavId]}
          </span>
          <span className="text-[12px] font-medium text-muted">All sections</span>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <PortalPropertySectionList
          items={sectionListItems}
          activeId={activeTopNavId}
          className="mt-2"
        />
      </details>
      {/*
        Phone: the Floors · Lease · Amenities tabs belong to the preview, not to
        the page. They sit right under the sections disclosure and stick to the
        top of the scroller once the preview is under way, so a section is one
        tap away while reading.
      */}
      {isListingPreview && hasPreview ? (
        // The wrapper eats the scroller's top padding so nothing peeks out
        // above the strip once it is stuck to the top edge.
        <div className="sticky -top-3 z-[45] -mt-3 bg-background pb-3 pt-3 lg:hidden">
          <ListingStickySubnav
            mode="portal"
            appearance="portal"
            className="rounded-lg border !border-border bg-card px-0.5"
          />
        </div>
      ) : null}
      {isListingPreview ? (
        hasPreview ? (
          <>
            {/* The preview IS the public page (PLAN-0914-2124): the same
                component the renter sees, with one manager extra — the empty
                photo band's "Add photos" button opens the listing editor. */}
            <ListingDetailSections
              property={previewProperty!}
              rich={rich!}
              portalEmbedded
              expandSectionsOnMobile
              managerPreviewChrome
              hidePortalSubnav
              onAddPhotos={
                bucket === 5
                  ? () => {
                      if (!skuLoaded) {
                        showToast("Loading subscription…");
                        return;
                      }
                      setDraftEditorOpen(true);
                    }
                  : canEditListing
                    ? () => openFullListingEditor()
                    : undefined
              }
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
          propertyId={stablePropertyId}
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
          settingsPropertyId={listingId ?? stablePropertyId}
          settingsPropertyLabel={propertyShareLabel}
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
          settingsPropertyId={listingId ?? stablePropertyId}
          settingsPropertyLabel={propertyShareLabel}
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
          propertiesBase={propertiesBase}
          stage={stage}
          propertyRouteKey={propertyRouteKey}
          tourBucket={propertyTourBucket}
          tourId={propertyTourId}
        />
      ) : null}

      {/* Bookings for THIS house, beside its Tours tab (PRP-165). The panel
          already existed and was complete — room filter, Airbnb link, footer bar
          — but nothing rendered it, so the only way to see one house's occupancy
          was to leave it for the portfolio Bookings page and filter back down. */}
      {activeDetailTab === "bookings" && bucket === 2 && listingId ? (
        <ManagerPropertyBookingsPanel
          propertyId={listingId}
          propertyLabel={propertyShareLabel}
          submission={managerSubmission}
          managerUserId={managerUserId}
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

      {activeDetailTab === "ai-info" && bucket === 2 && listingId ? (
        <ManagerPropertyAiInfoPanel
          propertyId={listingId}
          managerUserId={managerUserId}
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
        <PortalRecordActions omitSpacer>{propertyTabFooterActions}</PortalRecordActions>
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

      {/*
        Edit opens the SAME editor the ADD flow uses — the
        redesigned workspace. They used to mount the original form directly, so
        a listing created in one editor reopened in the other: two surfaces for
        one record, and every pricing change had to be made twice.
      */}
      {listingEditorOpen && listingFormProps ? (
        <ListingWizardOverlay>
          <ListingWizardV2 {...listingFormProps} />
        </ListingWizardOverlay>
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
        <ListingWizardOverlay>
          <ListingWizardV2 {...draftFormProps} />
        </ListingWizardOverlay>
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
        initialTab="tours"
        scopedTitle="Tour"
      />
    </div>
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
  propertyTourBucket = "pending",
  propertyTourId,
  onAddProperty,
  addPropertyDisabled = false,
  searchQuery = "",
  onClearSearch,
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
  propertyTourBucket?: ManagerTourBucketId;
  propertyTourId?: string;
  onAddProperty?: () => void;
  addPropertyDisabled?: boolean;
  /** Free-text match against the row title, address, and neighborhood (list view only). */
  searchQuery?: string;
  /** Clears the parent-owned search box from the no-match card. */
  onClearSearch?: () => void;
}) {
  const router = useRouter();
  const { userId: managerUserId, ready: authReady } = useManagerUserId();
  const scopeUserId = resolveManagerScopeUserId(managerUserId);
  const [tick, setTick] = useState(0);
  /**
   * Whether the portfolio behind this list has actually been loaded. The rows
   * below are read from the local store, which starts EMPTY on every fresh page
   * load, so a routed property detail rendered "Property not found." for the
   * whole first paint — and kept saying it when the sync failed outright. It is
   * three states, not a boolean, because "still loading" and "could not load"
   * are different answers and neither of them is "does not exist" (PRP-429).
   */
  const [portfolioLoad, setPortfolioLoad] = useState<"pending" | "ready" | "failed">("pending");
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
      void syncManagerPortfolioFromServer(scopeUserId, { force: true }).then((synced) => {
        setPortfolioLoad(synced ? "ready" : "failed");
        setTick((t) => t + 1);
      });
    } else {
      setPortfolioLoad("ready");
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
      void syncManagerPortfolioFromServer(scopeUserId, { force: true }).then((synced) => {
        if (synced) setPortfolioLoad("ready");
        setTick((t) => t + 1);
      });
    };
    // Workspace membership decides which rows show; when it is re-read (a home
    // created in this session just became a member) the rows must be re-read
    // too, without another server round trip.
    const onWorkspace = () => setTick((t) => t + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    window.addEventListener("axis-pro-relationships", on);
    // A lease signed elsewhere re-ranks its row (open rooms feed the attention score).
    window.addEventListener(LEASE_PIPELINE_EVENT, on);
    window.addEventListener(WORKSPACE_SELECTION_EVENT, onWorkspace);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
      window.removeEventListener("axis-pro-relationships", on);
      window.removeEventListener(LEASE_PIPELINE_EVENT, on);
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, onWorkspace);
    };
  }, [scopeUserId]);


  /*
   * The applications behind every row, so a row can say what it needs.
   *
   * Synced the same way the dashboard syncs them, and re-read on the store's own
   * event — never re-fetched on that event, which would be a request loop.
   */
  const [appTick, setAppTick] = useState(0);
  useEffect(() => {
    if (!scopeUserId || isDemoModeActive()) return;
    void syncManagerApplicationsFromServer({ managerUserId: scopeUserId }).then(() => setAppTick((t) => t + 1));
    const on = () => setAppTick((t) => t + 1);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, on);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, on);
  }, [scopeUserId]);
  const applications = useMemo(() => {
    void appTick;
    if (!scopeUserId) return [];
    return readManagerApplicationRows().filter((a) => applicationVisibleToPortalUser(a, scopeUserId));
  }, [appTick, scopeUserId]);

  /** Which "needs you" chip is narrowing the list, if any. */

  const rows = useMemo(() => {
    void tick;
    if (!scopeUserId) return [] as Array<{ sourceBucket: AdminPropertyBucketIndex; row: AdminPropertyRow; linked: boolean; attention: PropertyAttention }>;
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
          attention: propertyAttention(row, applications),
        };
      }),
    );
    const needle = searchQuery.trim().toLowerCase();
    return mapped
      .filter(({ row }) => propertyKeyProp || workspaceContainsProperty(row.listingId?.trim() || row.adminRefId.trim()))
      .filter(({ row, sourceBucket }) => {
        if (!needle) return true;
        const haystack = [managerPropertyRowTitle(row, sourceBucket), row.address, row.zip, row.neighborhood]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      })
      // The property that needs the manager most comes first; ties keep the
      // stable name order every other list uses.
      .sort((a, b) => b.attention.score - a.attention.score || compareAdminPropertyRowsForDisplay(a.row, b.row));
  }, [tick, scopeUserId, activeStage, propertyKeyProp, searchQuery, applications]);


  /** Rows per stage, for the empty state's "n drafts · open Drafts" link. */
  const stageCounts = useMemo(() => {
    void tick;
    const counts: Record<string, number> = {};
    if (!scopeUserId) return counts;
    for (const stage of MANAGER_STAGES) {
      counts[stage.key] = stage.buckets.reduce<number>(
        (n, bucket) =>
          n +
          readAdminPropertyRows(bucket, scopeUserId).filter((row) =>
            propertyKeyProp || workspaceContainsProperty(row.listingId?.trim() || row.adminRefId.trim()),
          ).length,
        0,
      );
    }
    return counts;
  }, [tick, scopeUserId, propertyKeyProp]);

  const propertyRowKey = (row: AdminPropertyRow) => row.adminRefId + (row.listingId ?? "");
  const propertyKeyFromRow = (row: AdminPropertyRow) =>
    row.listingId?.trim() || row.adminRefId.trim();

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(activeStage);
  const selectedPropertyEntries = useMemo(
    () => rows.filter(({ row }) => selectedIds.has(propertyRowKey(row))),
    [rows, selectedIds],
  );

  const canBulkEdit = selectedPropertyEntries.length === 1;
  const canBulkDuplicate =
    selectedPropertyEntries.length === 1 &&
    propertyRowCanDuplicate(managerUserId, selectedPropertyEntries[0]!);
  // Share is NOT gated on a single selection the way Edit is. The share modal's
  // `listing` and `apply` kinds are multi-select by design — several listings
  // become a filtered browse link — so requiring exactly one hid the multi-send
  // the modal already supported (AXI-140).
  const canBulkShareProperties =
    Boolean(onSendToProspect) &&
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every(({ sourceBucket }) => sourceBucket === 2);
  const canBulkUnlist =
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every(
      ({ sourceBucket, row }) => sourceBucket === 2 && Boolean(row.listingId?.trim()),
    );
  const canBulkRelist =
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every(({ sourceBucket }) => sourceBucket === 3);
  const canBulkDeleteQueue =
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every((entry) => propertyRowDeleteFromQueueAllowed(managerUserId, entry));
  const canBulkDeleteDrafts =
    selectedPropertyEntries.length > 0 &&
    selectedPropertyEntries.every(({ sourceBucket }) => sourceBucket === 5);

  const openSelectedPropertyDetail = useCallback(() => {
    const first = selectedPropertyEntries[0];
    if (!first) return;
    router.push(
      `${propertyDetailHref(
        propertiesBase,
        activeStage,
        propertyKeyFromRow(first.row),
        detailTabProp ?? "preview",
      )}?edit=1`,
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

  const runDuplicateSelected = useCallback(() => {
    const first = selectedPropertyEntries[0];
    if (!first || !canBulkDuplicate) return;
    void duplicatePropertyRowAsDraft({
      row: first.row,
      managerUserId,
      showToast,
      onUpdated: handlePropertyUpdated,
      onOpenDraft: (id) => {
        clearSelection();
        router.push(
          `${propertyDetailHref(propertiesBase, "all", id, "preview")}?edit=1`,
          { scroll: false },
        );
      },
    });
  }, [
    canBulkDuplicate,
    clearSelection,
    handlePropertyUpdated,
    managerUserId,
    propertiesBase,
    router,
    selectedPropertyEntries,
    showToast,
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
  const confirm = useConfirm();

  /**
   * The one-tap switch on a row. Listed -> off the market asks once, because it
   * removes the home from the public site; off the market -> listed runs the same
   * plan-limit check the Relist button does. A draft has no switch: it has never
   * been published, so there is nothing to flip — opening it is the next step.
   */
  const toggleRowListed = useCallback(
    async (entry: { sourceBucket: AdminPropertyBucketIndex; row: AdminPropertyRow }) => {
      const { sourceBucket, row } = entry;
      const label = managerPropertyRowTitle(row, sourceBucket);
      if (sourceBucket === 2) {
        const listingId = row.listingId?.trim();
        if (!listingId) {
          showToast("Could not unlist.");
          return;
        }
        const ok = await confirm({
          title: "Take off the market?",
          description: `${label} will leave the public site and wait under Unlisted until you list it again.`,
          confirmLabel: "Unlist",
        });
        if (!ok) return;
        deferCatalogMutation(() => {
          if (!unlistManagerListing(listingId, managerUserId)) {
            showToast("Could not unlist.");
            return;
          }
          handlePropertyUpdated();
          showToast("Off the market.");
        });
        return;
      }
      if (sourceBucket === 3) {
        if (!skuLoaded) {
          showToast("Loading subscription…");
          return;
        }
        if (managerTierPropertyLimitReached(skuTier, propCount)) {
          showToast(managerPropertyLimitMessage(skuTier, { omitUpgradeCta: isNativeRuntimeSync() }));
          return;
        }
        deferCatalogMutation(() => {
          if (!listAdminRow(row, managerUserId)) {
            showToast("Could not relist.");
            return;
          }
          handlePropertyUpdated();
          showToast("Listing is live again.");
        });
      }
    },
    [confirm, handlePropertyUpdated, managerUserId, propCount, showToast, skuLoaded, skuTier],
  );

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

  /**
   * The stage in the URL and the bucket the record actually sits in can
   * disagree — publishing a draft, unlisting, relisting, or simply following an
   * old bookmark all move a record between buckets while its id (and therefore
   * its detail URL) stays the same. `rows` only ever holds the URL's stage, so
   * every one of those read as "Property not found." Find the record's real
   * stage and send the manager there instead (PRP-429).
   */
  const routePropertyStageElsewhere = useMemo(() => {
    void tick;
    if (!propertyKeyProp || routePropertyEntry || !scopeUserId) return null;
    const decoded = decodeURIComponent(propertyKeyProp);
    for (const stage of MANAGER_STAGES) {
      if (stage.key === activeStage) continue;
      for (const bucket of stage.buckets) {
        const hit = readAdminPropertyRows(bucket, scopeUserId).some(
          (row) => (row.listingId?.trim() || row.adminRefId.trim()) === decoded || row.adminRefId === decoded,
        );
        if (hit) return stage.key;
      }
    }
    return null;
  }, [activeStage, propertyKeyProp, routePropertyEntry, scopeUserId, tick]);

  useEffect(() => {
    if (!routePropertyStageElsewhere || !propertyKeyProp) return;
    router.replace(
      propertyDetailHref(
        propertiesBase,
        routePropertyStageElsewhere,
        decodeURIComponent(propertyKeyProp),
        detailTabProp ?? "preview",
      ),
      { scroll: false },
    );
  }, [detailTabProp, propertiesBase, propertyKeyProp, router, routePropertyStageElsewhere]);

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
      propertyTourBucket={propertyTourBucket}
      propertyTourId={propertyTourId}
    />
  );

  if (propertyKeyProp) {
    if (!routePropertyEntry) {
      // Only the loaded-and-really-absent case is a missing property. While the
      // portfolio is still arriving — or when it failed to arrive at all — say
      // that instead, so a slow first paint stops reading as a deleted listing.
      if (routePropertyStageElsewhere || portfolioLoad === "pending") {
        return <p className="text-sm text-muted">Loading this property…</p>;
      }
      if (portfolioLoad === "failed") {
        return (
          <PortalDataTableEmpty
            message="Could not load your properties. Check your connection and try again."
            icon="default"
          />
        );
      }
      return (
        <PortalDataTableEmpty
          message="Property not found."
          icon="default"
        />
      );
    }
    const { sourceBucket, row } = routePropertyEntry;
    const rowKey = row.adminRefId + (row.listingId ?? "");
    const address = propertyRowAddress(row);
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
        iconTitleActions={
          sourceBucket === 5 || (sourceBucket === 2 && (detailTabProp ?? "preview") === "preview")
        }
        pinScrollBody
        scrollBody={false}
      >
        {renderRowDetail(sourceBucket, row, rowKey)}
      </PortalRecordDetailPage>
    );
  }

  /**
   * The empty state (§15): what this stage holds, the stage that has rows,
   * and the one action. No bare dashed box.
   */
  const renderEmptyState = () => {
    const sibling = portalEmptySibling(
      MANAGER_STAGES.map((s) => ({ id: s.key, label: s.label, count: stageCounts[s.key], href: propertyListHref(propertiesBase, s.key) })),
      activeStage,
    );
    const copy = portalEmptyCopy(`properties.${activeStage}` as PortalEmptyCopyKey);
    /*
     * A workspace that holds nothing while the account holds homes elsewhere is
     * not "no homes yet" — the homes are one switch away. Name the workspace and
     * point at where they are, rather than inviting the manager to add a home
     * the plan meter may already refuse (which is exactly how this read before).
     */
    const scope = activeWorkspaceScope();
    const elsewhere = propertiesOutsideActiveWorkspace();
    const emptyWorkspace = scope && !searchQuery.trim() && scope.propertyCount === 0 && elsewhere > 0;
    if (searchQuery.trim()) {
      return (
        <PortalListEmptyCard
          workspaceAware={false}
          tone="muted"
          section="properties"
          title={portalEmptyNoMatchTitle("homes", searchQuery)}
          clear={onClearSearch ? { label: "Clear search", onClick: onClearSearch, dataAttr: "manager-properties-empty-clear-search" } : null}
          dataAttr="manager-properties-empty"
        />
      );
    }
    return (
      <PortalListEmptyCard
        // Properties writes its own workspace copy: it is the one list where
        // adding a home in the empty workspace is exactly the right next step.
        workspaceAware={false}
        section="properties"
        title={emptyWorkspace ? `Nothing in ${scope.name} yet` : copy.title}
        sibling={
          emptyWorkspace
            ? {
                label: `${elsewhere} ${elsewhere === 1 ? "home" : "homes"} in other workspaces`,
                href: "/portal/profile?tab=workspaces",
                dataAttr: "manager-properties-empty-workspaces",
              }
            : sibling
              ? { ...sibling, dataAttr: `manager-properties-empty-sibling` }
              : null
        }
        actions={
          onAddProperty
            ? [
                // One way in: Create opens the editor, and importing a file is
                // a strip at the top of its Basics step.
                {
                  label: "Create",
                  onClick: onAddProperty,
                  disabled: addPropertyDisabled,
                  reason: addPropertyDisabled ? "Loading your plan…" : undefined,
                  dataAttr: "manager-properties-create",
                },
              ]
            : []
        }
        dataAttr="manager-properties-empty"
      />
    );
  };

  return (
    <>
      <PortalRecordListSurface className="mt-0" onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={selectedIds.size > 0 ? (
        <>
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
            {canBulkDuplicate ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="properties-bulk-duplicate"
                onClick={runDuplicateSelected}
              >
                Duplicate
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
                onClick={async () => {
                  if (
                    !(await confirm({
                      description: `Delete ${selectedPropertyEntries.length} draft${selectedPropertyEntries.length === 1 ? "" : "s"}?`,
                    }))
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
                Delete
              </Button>
            ) : null}
          </div>
        </>
      ) : null}><div className={PORTAL_LIST_PAGE_BODY}>
        {rows.map(({ sourceBucket, row, linked, attention }) => {
          const rowKey = row.adminRefId + (row.listingId ?? "");
          const thumb = propertyRowThumbnail(row);
          const attentionParts = sourceBucket === 2 ? propertyAttentionParts(attention) : [];
          return (
            <PortalPropertyRecordRow
              key={rowKey}
              title={managerPropertyRowTitle(row, sourceBucket)}
              address={propertyRowAddressLine(row)}
              meta={propertyRowMeta(row)}
              trailing={
                sourceBucket === 5 ? (
                  activeStage === "all" ? (
                    <PortalRowStatusChip tone="neutral" dataAttr="property-row-stage">Draft</PortalRowStatusChip>
                  ) : undefined
                ) : (
                  /* No rent figure and no Listed switch on the row: the tabs say
                     where a home is, and List / Unlist lives in the ⋯ menu with its
                     confirmation. */
                  undefined
                )
              }
              chip={
                // Under All the row has to say its own state — the tab no longer
                // does. No occupancy count on the row: the glyph line already
                // says how many rooms there are.
                sourceBucket === 3 ? (
                  <PortalRowStatusChip tone="neutral" dataAttr="property-row-stage">
                    Off the market
                  </PortalRowStatusChip>
                ) : undefined
              }
              leading={
                thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt=""
                    className="h-[4.125rem] w-[5.5rem] rounded-[10px] object-cover max-md:h-[3.125rem] max-md:w-16"
                  />
                ) : (
                  // "No photo yet" is a house, not a broken image — the crossed-out
                  // frame read as an error on every draft.
                  <div
                    aria-hidden
                    className="grid h-[4.125rem] w-[5.5rem] place-items-center rounded-[10px] bg-accent/60 text-muted/80 max-md:h-[3.125rem] max-md:w-16"
                  >
                    <Home className="size-[22px]" strokeWidth={1.5} />
                  </div>
                )
              }
              checked={selectedIds.has(rowKey)}
              onSelectedChange={() => toggleSelected(rowKey)}
              badge={
                linked || attentionParts.length > 0 ? (
                  <span className="flex flex-wrap gap-1.5">
                    {attentionParts.map((part) => (
                      <Badge key={part.text} tone={part.tone}>
                        {part.text}
                      </Badge>
                    ))}
                    {linked ? <Badge tone="info">Co-managed</Badge> : null}
                  </span>
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
        {rows.length === 0 ? renderEmptyState() : null}
      </div></PortalRecordListSurface>

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
