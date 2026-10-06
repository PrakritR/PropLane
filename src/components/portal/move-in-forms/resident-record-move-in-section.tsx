"use client";

/**
 * Resident record › Move in (every resident stage). One section header card ("Move in", then the
 * same sub-tabs, in the same order and words, the resident sees in My home: Forms · Placement ·
 * Move-in details · Roommates · Inspections), and one body per sub-tab:
 *  - Forms: EVERY form of the resident's property (its stored list), one flat row each, merged with
 *    the copies already sent: Not sent (⋯ Send), Sent with its due date (⋯ Remind / Preview /
 *    Cancel) or Submitted (⋯ Open / Download PDF / Send again). A copy whose form was since deleted
 *    still shows under the name it was sent with. Download all and the round + that opens the send
 *    popup already pointed at this resident sit in the header card.
 *  - Placement: the property, room and dates this resident is placed at.
 *  - Move-in details: what the resident received (instructions, photos, video) plus the house
 *    info, rules, Wi-Fi, instructions and amenities their own Move-in details tab shows.
 *  - Roommates: the other residents of the house, as the resident sees them — loaded from the
 *    server, which re-derives this manager's access to the record and redacts each peer by that
 *    peer's own sharing preferences.
 *  - Inspections: this resident's move-in / move-out inspections (`InspectionsPanel`).
 * Only facts that exist are shown; there is no "Opened" row because nothing records it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, FileText, Pencil, Send } from "lucide-react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { ManagerResidentSectionToolbar } from "@/components/portal/manager-resident-section-toolbar";
import { InspectionsPanel } from "@/components/portal/inspections-panel";
import {
  AmenitiesSection,
  HousematesTabContent,
  InfoTabContent,
  InstructionsTabContent,
} from "@/components/portal/resident-move-in-view";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { RecordFactRow } from "@/components/portal/portal-record-overview-kit";
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
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { sendMoveInForm } from "@/lib/move-in-forms/client";
import { moveInFormTab } from "@/lib/move-in-forms/manager-rows";
import { readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormSummary, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  propertyDetailHref,
  RESIDENT_MOVE_IN_TABS,
  RESIDENT_MOVE_IN_TAB_LABELS,
  type ResidentMoveInTabId,
} from "@/lib/portal-detail-routes";
import {
  resolveResidentMoveInFromApplications,
  type ResidentMoveInHousemate,
} from "@/lib/resident-move-in-resolve";
import { sharedGet } from "@/lib/shared-get-cache";

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

function Card({ title, actions, children, dataAttr }: { title?: string; actions?: ReactNode; children: ReactNode; dataAttr: string }) {
  return (
    <section className="mb-4 flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      {title ? (
        <div className="flex items-center gap-1 border-b border-border/70 px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ResidentRecordMoveInSection({
  userId,
  applicationId,
  residentName,
  residentEmail,
  propertyId,
  basePath = "/portal",
  subTab,
  onSubTabChange,
  placement,
}: {
  userId: string;
  /** The application id the Residents routes use for this person. */
  applicationId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  basePath?: string;
  /** The open sub-tab (the record keeps it in the URL). Omitted = the section keeps it itself, opening on Forms. */
  subTab?: ResidentMoveInTabId;
  onSubTabChange?: (tab: ResidentMoveInTabId) => void;
  /** Where this resident is placed, for the Placement sub-tab. */
  placement?: { propertyLabel?: string; roomLabel?: string; moveInDate?: string; moveOutDate?: string };
}) {
  const [localTab, setLocalTab] = useState<ResidentMoveInTabId>("forms");
  const activeTab = subTab ?? localTab;
  const changeTab = onSubTabChange ?? setLocalTab;
  const navigate = usePortalNavigate();
  const actions = useMoveInFormRowActions();
  const { showToast } = useAppUi();
  const { list, loading, error, retry } = useManagerMoveInForms(userId, { applicationId });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<MoveInFormSummary | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
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

  // What this resident's own Move-in tabs would resolve to: the property's move-in copy and house
  // info. Resolved from THIS record's own application row — passing every row for the email let
  // the resolver pick an approved tenancy at another property and describe that one instead.
  const { resolved, entireHome } = useMemo(() => {
    const hit = propertyId ? resolveManagerListingSubmissionForPropertyId(userId, propertyId) : null;
    const row: DemoApplicantRow | undefined = readManagerApplicationRows().find((r) => r.id === applicationId);
    const property = hit
      ? ({ id: propertyId, title: "", buildingName: "", listingSubmission: hit.sub } as unknown as MockProperty)
      : undefined;
    const found =
      row && residentEmail && property
        ? resolveResidentMoveInFromApplications(residentEmail, [row], { [propertyId]: property })
        : null;
    return { resolved: found, entireHome: hit ? isEntireHomeListing(hit.sub) : false };
  }, [userId, applicationId, propertyId, residentEmail]);

  // Roommates come from the server: the household is the manager's whole set of current residents
  // at this property, which the browser's own copy of the application rows cannot be trusted to
  // scope or redact. The read is issued only when the Roommates sub-tab is open — it costs the
  // server a paged sweep of the manager's application rows — and is stamped with the record it
  // answered for, so moving to another resident never shows the previous one's household. A failed
  // read stays `failed`, never an empty list: "we could not look" is not "nobody lives here".
  const [loadedHousemates, setLoadedHousemates] = useState<
    { applicationId: string; list: ResidentMoveInHousemate[] } | { applicationId: string; failed: true } | null
  >(null);
  const householdRead = loadedHousemates?.applicationId === applicationId ? loadedHousemates : null;
  // Only the retry button passes `force`, and only for the press that asked for it: a counter held
  // in state stayed true for the component's life, so one Try again made every later open of
  // Roommates — for any resident — bypass the shared-GET cache and re-run the paged sweep.
  const readHousehold = useCallback(
    (force: boolean) => {
      if (!applicationId || demo) return () => {};
      let cancelled = false;
      void sharedGet(`/api/manager-applications/${encodeURIComponent(applicationId)}/housemates`, { force }).then(
        (result) => {
          if (cancelled) return;
          if (!result.ok) {
            setLoadedHousemates({ applicationId, failed: true });
            return;
          }
          const list = (result.data as { housemates?: unknown } | null)?.housemates;
          setLoadedHousemates({ applicationId, list: Array.isArray(list) ? (list as ResidentMoveInHousemate[]) : [] });
        },
      );
      return () => {
        cancelled = true;
      };
    },
    [applicationId, demo],
  );
  useEffect(() => {
    if (activeTab !== "housemates") return;
    return readHousehold(false);
  }, [activeTab, readHousehold]);
  const details = useMemo(() => describeMoveInDetails(resolved, entireHome), [resolved, entireHome]);

  const open = (form: MoveInFormSummary) => {
    track("move_in_form_opened", { status: form.status });
    setViewing(form);
  };

  const downloadAll = async () => {
    for (const form of submitted) await actions.download(form);
  };

  const tabItems = RESIDENT_MOVE_IN_TABS.map((id) => ({
    id,
    label: id === "placement" ? "Placement" : RESIDENT_MOVE_IN_TAB_LABELS[id],
    count: id === "forms" ? rows.length : undefined,
    dataAttr: `resident-move-in-tab-${id}`,
  }));
  const openPropertyMoveIn = () => navigate(propertyDetailHref(basePath, "all", propertyId, "move-in"));
  const headerActions =
    activeTab === "forms" && !demo ? [{ id: "send-form", label: "Add form", icon: Send, tone: "primary" as const }] : [];
  const headerExtras =
    activeTab === "forms" && !demo ? (
      <PortalIconAction
        icon={Download}
        label="Download all"
        disabled={submitted.length === 0}
        data-attr="resident-move-in-download-all"
        onClick={() => void downloadAll()}
      />
    ) : activeTab === "info" && propertyId ? (
      <PortalIconAction
        icon={Pencil}
        label="Edit move-in details"
        data-attr="resident-move-in-open-property"
        onClick={openPropertyMoveIn}
      />
    ) : null;
  const placementProperty = resolved?.propertyLabel?.trim() || placement?.propertyLabel?.trim() || "";
  const placementRoom = resolved?.roomLabel?.trim() || placement?.roomLabel?.trim() || "";
  const placementMoveIn = resolved?.earliestMoveInDateLabel?.trim() || placement?.moveInDate?.trim() || "";

  return (
    <div className="min-w-0" data-attr="resident-record-move-in" data-move-in-tab={activeTab}>
      <ManagerResidentSectionToolbar
        actions={headerActions}
        onAction={(id) => {
          if (id === "send-form") setSendOpen(true);
        }}
        overflowMenu={headerExtras}
        destinationRow={
          <LocalDestinationNav
            items={tabItems}
            activeId={activeTab}
            onChange={(id) => changeTab(id as ResidentMoveInTabId)}
            ariaLabel="Move in sections"
            appearance="command"
            className="w-full"
          />
        }
      />

      {activeTab === "forms" ? (
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
                  : [{ label: "Open Forms", onClick: openPropertyMoveIn, dataAttr: "resident-move-in-empty-open-forms" }],
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
      ) : null}

      {activeTab === "placement" ? (
        <Card dataAttr="resident-record-move-in-placement">
          <RecordFactRow label="Property" value={placementProperty || "Not set yet"} />
          {resolved?.addressLine ? <RecordFactRow label="Address" value={resolved.addressLine} /> : null}
          <RecordFactRow label="Room" value={placementRoom || "Not assigned yet"} />
          <RecordFactRow label="Move-in date" value={placementMoveIn || "Not set yet"} />
          {placement?.moveOutDate?.trim() ? <RecordFactRow label="Move-out date" value={placement.moveOutDate.trim()} /> : null}
        </Card>
      ) : null}

      {activeTab === "info" ? (
        <>
          <Card title={`Move-in details ${first} received`} dataAttr="resident-record-move-in-details">
            <RecordFactRow label="Instructions" value={details.instructions} />
            <RecordFactRow label="Photos" value={details.photos} />
            <RecordFactRow label="Video" value={details.video} />
          </Card>
          {resolved ? (
            <div className="space-y-3" data-attr="resident-record-move-in-house-info">
              <InfoTabContent resolved={resolved} forManager />
              <InstructionsTabContent resolved={resolved} forManager />
              <AmenitiesSection resolved={resolved} forManager />
            </div>
          ) : null}
        </>
      ) : null}

      {activeTab === "housemates" ? (
        <div data-attr="resident-record-move-in-roommates">
          {demo || !applicationId ? (
            <PortalDataTableEmpty icon="residents" message="No other residents are listed for this household yet." />
          ) : householdRead === null ? (
            <PortalDataTableEmpty icon="residents" message="Loading this household…" />
          ) : "failed" in householdRead ? (
            <div
              role="alert"
              className="rounded-2xl border border-border bg-card p-6 text-center"
              data-attr="resident-move-in-roommates-error"
            >
              <p className="mb-3 text-sm">Couldn&apos;t load this household.</p>
              <Button variant="outline" onClick={() => readHousehold(true)}>
                Try again
              </Button>
            </div>
          ) : (
            <HousematesTabContent
              housemates={householdRead.list}
              emptyMessage="No other residents are listed for this household yet."
            />
          )}
        </div>
      ) : null}

      {activeTab === "inspections" ? (
        <InspectionsPanel
          role="manager"
          applicationId={applicationId}
          embeddedInResident
          embeddedToolbar={(nav) => (
            <div className="mb-2 rounded-xl border border-border bg-card px-1 shadow-sm" data-attr="resident-move-in-inspections-tabs">
              {nav}
            </div>
          )}
        />
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
