"use client";

/**
 * Resident record › Move-in (every resident stage): a hub with four sub-tabs under the toolbar.
 *  - "Move-in info": what the resident received, exactly as the manager authored it on the property
 *    (house / room / spot instructions, photos + video, access and Wi-Fi, amenities).
 *  - "House rules": the property's rules and the other "For residents" sections.
 *  - "Roommates": the other approved residents placed at the property.
 *  - "Forms": EVERY form of the resident's property (its stored list), one flat row each, merged
 *    with the copies already sent (Not sent / Sent with its due date / Submitted), then the
 *    Inspections card. The toolbar carries Download all, Send a form and Add inspection.
 * Only facts that exist are shown; there is no "Opened" row because nothing records it.
 */
import { useMemo, useState, type ReactNode } from "react";
import { ClipboardCheck, Download, FileText, Pencil, Send } from "lucide-react";
import { ManagerResidentSectionToolbar } from "@/components/portal/manager-resident-section-toolbar";
import {
  MoveInCard,
  ResidentHouseRulesPanel,
  ResidentMoveInInfoPanel,
  ResidentRoommatesPanel,
  buildResidentMoveInHubData,
  deriveResidentRoommates,
} from "@/components/portal/move-in-forms/resident-record-move-in-info";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { Button } from "@/components/ui/button";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { MoveInFormViewer } from "@/components/portal/move-in-forms/move-in-form-viewer";
import { SendMoveInFormPopup } from "@/components/portal/move-in-forms/move-in-form-send-popup";
import { MoveInFormMenuItems, useMoveInFormRowActions } from "@/components/portal/move-in-forms/move-in-form-row-actions";
import { moveInFormEntryFacts } from "@/components/portal/move-in-forms/manager-move-in-forms-panel";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { useManagerMoveInForms } from "@/hooks/use-move-in-forms";
import { usePropertyPipelineTick } from "@/hooks/use-property-pipeline-tick";
import { track } from "@/lib/analytics/track-client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { RecordHeaderAction } from "@/lib/portals/record-sections";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { sendMoveInForm } from "@/lib/move-in-forms/client";
import { moveInFormTab } from "@/lib/move-in-forms/manager-rows";
import { readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormSummary, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { propertyDetailHref } from "@/lib/portal-detail-routes";

/** One form of the resident's property: its latest live copy, or none yet. */
export type ResidentMoveInFormRow = {
  /** The form's id; a copy of a deleted form keeps the id it was sent under. */
  formId: string;
  name: string;
  /** The property's form, or null when it was deleted after this copy went out. */
  template: MoveInFormTemplate | null;
  /** The copy to show: the waiting one if any, else the newest submitted. Null = Not sent. */
  copy: MoveInFormSummary | null;
};

/**
 * Every form of the property (stored order), each with this resident's copy when one exists,
 * then copies of forms the property no longer has. Cancelled copies are not copies.
 */
export function residentMoveInFormRows(templates: readonly MoveInFormTemplate[], copies: readonly MoveInFormSummary[]): ResidentMoveInFormRow[] {
  const live = copies.filter((form) => moveInFormTab(form) !== null);
  const stamp = (value: string | null | undefined) => (value ? new Date(value).getTime() || 0 : 0);
  const pick = (formId: string): MoveInFormSummary | null => {
    const mine = live.filter((form) => form.formId === formId);
    const waiting = mine.filter((form) => form.status === "sent").sort((a, b) => stamp(b.sentAt) - stamp(a.sentAt))[0];
    if (waiting) return waiting;
    return mine.sort((a, b) => stamp(b.submittedAt) - stamp(a.submittedAt))[0] ?? null;
  };
  const rows: ResidentMoveInFormRow[] = [];
  const seen = new Set<string>();
  for (const template of templates) {
    if (!template.name.trim() || seen.has(template.id)) continue;
    seen.add(template.id);
    rows.push({ formId: template.id, name: template.name.trim(), template, copy: pick(template.id) });
  }
  for (const form of live) {
    if (seen.has(form.formId)) continue;
    seen.add(form.formId);
    rows.push({ formId: form.formId, name: form.formName, template: null, copy: pick(form.formId) });
  }
  return rows;
}

export type MoveInDetailsReceived = {
  instructions: string;
  photos: string;
  video: string;
};

const NONE = "None added";

/** What the property's existing move-in data gives this resident. Facts only; blanks say so. */
export function describeMoveInDetails(
  resolved: {
    instructions: string | null;
    houseInstructions: string | null;
    roomLabel: string;
    moveInPhotoDataUrls: string[];
    houseMoveInPhotoDataUrls: string[];
    moveInVideoDataUrl: string | null;
    houseMoveInVideoDataUrl: string | null;
    residentSection: { instructions: string | null; photoDataUrls: string[]; videoDataUrl: string | null } | null;
  } | null,
  entireHome: boolean,
): MoveInDetailsReceived {
  if (!resolved) return { instructions: NONE, photos: NONE, video: NONE };
  const scopes: string[] = [];
  if (resolved.houseInstructions) scopes.push("The whole house");
  if (resolved.instructions) {
    const room = resolved.roomLabel.trim();
    scopes.push(entireHome || !room || /not assigned/i.test(room) ? "The whole house" : room);
  }
  if (resolved.residentSection?.instructions) scopes.push("Their own space");
  const photoCount =
    resolved.moveInPhotoDataUrls.length +
    resolved.houseMoveInPhotoDataUrls.length +
    (resolved.residentSection?.photoDataUrls.length ?? 0);
  const hasVideo = Boolean(resolved.moveInVideoDataUrl || resolved.houseMoveInVideoDataUrl || resolved.residentSection?.videoDataUrl);
  return {
    instructions: scopes.length ? [...new Set(scopes)].join(" · ") : NONE,
    photos: photoCount ? String(photoCount) : NONE,
    video: hasVideo ? "Added" : NONE,
  };
}

export type ResidentMoveInSubTab = "info" | "rules" | "roommates" | "forms";

const SUB_TAB_LABELS: Record<ResidentMoveInSubTab, string> = {
  info: "Move-in info",
  rules: "House rules",
  roommates: "Roommates",
  forms: "Forms",
};
const SUB_TABS = Object.keys(SUB_TAB_LABELS) as ResidentMoveInSubTab[];

export function ResidentRecordMoveInSection({
  userId,
  applicationId,
  residentName,
  residentEmail,
  propertyId,
  basePath = "/portal",
  inspectionsPanel,
  onAddInspection,
  propertyHref,
  houseDetailsHref,
  onOpenResident,
  currentResidentId,
  initialSubTab,
}: {
  userId: string;
  /** The application id the Residents routes use for this person. */
  applicationId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  basePath?: string;
  /** The Inspections list, shown in an "Inspections" card under the forms. */
  inspectionsPanel?: ReactNode;
  /** Adds the toolbar's "Add inspection" action on the Forms sub-tab. */
  onAddInspection?: () => void;
  /** The property's Move-in page; powers "Edit in property" on Move-in info. */
  propertyHref?: string;
  /** The property's House details page; powers "Edit in property" on House rules. */
  houseDetailsHref?: string;
  /** Opens another resident's record (a Roommates row). */
  onOpenResident?: (residentId: string) => void;
  /** This resident's own id when it differs from `applicationId`; never listed as a roommate. */
  currentResidentId?: string;
  initialSubTab?: ResidentMoveInSubTab;
}) {
  const navigate = usePortalNavigate();
  const actions = useMoveInFormRowActions();
  const { showToast } = useAppUi();
  const { list, loading, error, retry } = useManagerMoveInForms(userId, { applicationId });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<MoveInFormSummary | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [subTab, setSubTab] = useState<ResidentMoveInSubTab>(initialSubTab ?? "info");
  const [seenInitialSubTab, setSeenInitialSubTab] = useState(initialSubTab);
  if (initialSubTab !== seenInitialSubTab) {
    setSeenInitialSubTab(initialSubTab);
    if (initialSubTab) setSubTab(initialSubTab);
  }
  const demo = isDemoModeActive();
  const first = residentName.trim().split(/\s+/)[0] || "this resident";

  // Every form the property has, as the stored list says (nothing is added for the manager).
  const propertyTick = usePropertyPipelineTick();
  const templates = useMemo(() => {
    void propertyTick; // the property store changed: read the forms again
    const hit = propertyId ? resolveManagerListingSubmissionForPropertyId(userId, propertyId) : null;
    return hit ? readMoveInFormTemplates(hit.sub) : [];
  }, [userId, propertyId, propertyTick]);
  const rows = useMemo(
    () => residentMoveInFormRows(templates, list.forms.filter((form) => form.applicationId === applicationId)),
    [templates, list.forms, applicationId],
  );
  const now = useMemo(() => new Date(), []);
  const submitted = rows.flatMap((row) => (row.copy?.status === "submitted" ? [row.copy] : []));
  const selectedRow = selected.size === 1 ? rows.find((row) => selected.has(row.formId)) : undefined;
  // The server sends only to an approved resident placed at a property with an email on file.
  const canSend = useMemo(() => {
    const row = readManagerApplicationRows().find((r) => r.id === applicationId);
    return Boolean(row && row.bucket === "approved" && !row.withdrawnAt && residentEmail.trim() && propertyId);
  }, [applicationId, residentEmail, propertyId]);
  const [sending, setSending] = useState<string | null>(null);
  const sendForm = async (row: ResidentMoveInFormRow) => {
    if (!row.template || sending) return;
    setSending(row.formId);
    try {
      await sendMoveInForm({ applicationId, formId: row.formId });
      track("move_in_form_sent", { source: "resident_record_row" });
      showToast(`${row.name} sent to ${first}`);
      setSelected(new Set());
    } catch (caught) {
      showToast(caught instanceof Error && caught.message ? caught.message : "Could not send this form.");
    } finally {
      setSending(null);
    }
  };
  const rowFacts = (row: ResidentMoveInFormRow): PortalEntryRowFact[] =>
    row.copy ? moveInFormEntryFacts(row.copy, now) : [{ icon: Send, label: "Not sent" }];

  // The property's own move-in data, resolved for this resident, plus the other residents placed there.
  const hub = useMemo(() => {
    void propertyTick; // the property store changed: read it again
    const hit = propertyId ? resolveManagerListingSubmissionForPropertyId(userId, propertyId) : null;
    const sub = hit?.sub ?? null;
    const allRows = readManagerApplicationRows();
    return {
      data: buildResidentMoveInHubData({ propertyId, sub, row: allRows.find((r) => r.id === applicationId), residentEmail }),
      roommates: deriveResidentRoommates({ rows: allRows, propertyId, selfApplicationId: applicationId, selfResidentId: currentResidentId, sub, now: new Date() }),
    };
  }, [userId, applicationId, propertyId, residentEmail, currentResidentId, propertyTick]);

  const open = (form: MoveInFormSummary) => {
    track("move_in_form_opened", { status: form.status });
    setViewing(form);
  };

  const downloadAll = async () => {
    for (const form of submitted) await actions.download(form);
  };

  const toolbarActions: RecordHeaderAction[] = [];
  const editHref = subTab === "info" ? propertyHref : subTab === "rules" ? houseDetailsHref : undefined;
  if (editHref) toolbarActions.push({ id: "edit-in-property", label: "Edit in property", icon: Pencil });
  if (subTab === "forms") {
    if (!demo) {
      if (submitted.length > 0) toolbarActions.push({ id: "download-all", label: "Download all", icon: Download });
      toolbarActions.push({ id: "add-form", label: "Send a form", icon: Send, tone: "primary" });
    }
    if (onAddInspection) toolbarActions.push({ id: "add-inspection", label: "Add inspection", icon: ClipboardCheck });
  }
  const onToolbarAction = (id: string) => {
    if (id === "edit-in-property" && editHref) navigate(editHref);
    else if (id === "download-all") void downloadAll();
    else if (id === "add-form") setSendOpen(true);
    else if (id === "add-inspection") onAddInspection?.();
  };
  const addInProperty = (href?: string) => (href ? () => navigate(href) : undefined);

  return (
    <div className="min-w-0" data-attr="resident-record-move-in">
      <ManagerResidentSectionToolbar
        actions={toolbarActions}
        onAction={onToolbarAction}
        destinationRow={
          <LocalDestinationNav
            items={SUB_TABS.map((id) => ({
              id,
              label: SUB_TAB_LABELS[id],
              count: id === "roommates" && hub.roommates.length > 0 ? hub.roommates.length : undefined,
              dataAttr: `resident-move-in-subtab-${id}`,
            }))}
            activeId={subTab}
            onChange={(id: string) => setSubTab(id as ResidentMoveInSubTab)}
            ariaLabel="Move-in sections"
            appearance="command"
            className="w-full"
          />
        }
      />

      {subTab === "info" ? (
        <ResidentMoveInInfoPanel data={hub.data} first={first} onAddInProperty={addInProperty(propertyHref)} />
      ) : null}

      {subTab === "rules" ? <ResidentHouseRulesPanel data={hub.data} onAddInProperty={addInProperty(houseDetailsHref)} /> : null}

      {subTab === "roommates" ? <ResidentRoommatesPanel roommates={hub.roommates} onOpenResident={onOpenResident} /> : null}

      {subTab === "forms" ? (
        <>
          <MoveInCard title="Move-in forms" dataAttr="resident-record-move-in-forms">
            <PortalListGroupRowContext.Provider value>
            <PortalRecordListSurface
              className="!pb-0 max-lg:!pb-0 lg:!pb-0"
              isEmpty={rows.length === 0}
              loading={loading}
              loadError={error ? "Couldn't load move-in forms" : undefined}
              onRetry={retry}
              emptyCard={{
                title: "No move-in forms for this property",
                section: "move-in",
                actions:
                  demo || !propertyId
                    ? []
                    : [{ label: "Open Forms", onClick: () => navigate(propertyDetailHref(basePath, "all", propertyId, "move-in")), dataAttr: "resident-move-in-empty-open-forms" }],
              }}
              onBulkClear={() => setSelected(new Set())}
              bulkCount={selected.size}
              bulkActions={
                selectedRow ? (
                  <PortalSectionActionRow variant="header">
                    {selectedRow.copy ? (
                      <MoveInFormMenuItems form={selectedRow.copy} actions={actions} onOpen={open} includeResident={false} />
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className={PORTAL_BULK_BAR_BTN}
                        data-attr="resident-move-in-row-send"
                        disabled={!canSend || sending !== null}
                        title={canSend ? undefined : "Approve this resident's application first."}
                        onClick={() => void sendForm(selectedRow)}
                      >
                        Send
                      </Button>
                    )}
                  </PortalSectionActionRow>
                ) : undefined
              }
              dataAttr="resident-move-in-forms-list"
            >
              <div className="divide-y divide-border/70">
                {rows.map((row) => (
                  <PortalEntryRow
                    key={row.formId}
                    tile={{ kind: "glyph", icon: FileText }}
                    title={row.name}
                    facts={rowFacts(row)}
                    checked={selected.has(row.formId)}
                    onSelectedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(row.formId);
                        else next.delete(row.formId);
                        return next;
                      })
                    }
                    onOpen={row.copy ? () => open(row.copy!) : undefined}
                    omitActionView
                    selectLabel={row.name}
                    dataAttr="resident-move-in-form-row"
                  />
                ))}
              </div>
            </PortalRecordListSurface>
            </PortalListGroupRowContext.Provider>
          </MoveInCard>
          {inspectionsPanel ? (
            <MoveInCard title="Inspections" dataAttr="resident-record-move-in-inspections">
              {inspectionsPanel}
            </MoveInCard>
          ) : null}
        </>
      ) : null}

      {viewing ? <MoveInFormViewer form={viewing} actions={actions} onClose={() => setViewing(null)} /> : null}
      {sendOpen ? (
        <SendMoveInFormPopup
          userId={userId}
          presetApplicationId={applicationId}
          onClose={() => setSendOpen(false)}
          onOpenProperty={(id) => {
            setSendOpen(false);
            navigate(propertyDetailHref(basePath, "all", id, "move-in"));
          }}
        />
      ) : null}
    </div>
  );
}
