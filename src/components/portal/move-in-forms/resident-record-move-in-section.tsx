"use client";

/**
 * Resident record › Move-in (every resident stage). Two cards, per docs/agents/record-page.md:
 *  - "Move-in forms": EVERY form of the resident's property (its stored list), one flat row each,
 *    merged with the copies already sent: Not sent (⋯ Send), Sent with its due date (⋯ Remind /
 *    Preview / Cancel) or Submitted (⋯ Open / Download PDF / Send again). A copy whose form was
 *    since deleted still shows under the name it was sent with. Download all and the round + that
 *    opens the send popup already pointed at this resident stay.
 *  - "Move-in details <first name> received": the property's existing move-in instructions,
 *    photos and video as plain facts, with an icon link to the property's Move-in tab.
 * Only facts that exist are shown; there is no "Opened" row because nothing records it.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Download, ExternalLink, FileText, Send } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
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
import { propertyDetailHref } from "@/lib/portal-detail-routes";
import { resolveResidentMoveInFromApplications } from "@/lib/resident-move-in-resolve";

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

function Card({ title, actions, children, dataAttr }: { title: string; actions?: ReactNode; children: ReactNode; dataAttr: string }) {
  return (
    <section className="mb-4 flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      <div className="flex items-center gap-1 border-b border-border/70 px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {actions}
      </div>
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
}: {
  userId: string;
  /** The application id the Residents routes use for this person. */
  applicationId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  basePath?: string;
}) {
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

  const details = useMemo(() => {
    const hit = propertyId ? resolveManagerListingSubmissionForPropertyId(userId, propertyId) : null;
    const row: DemoApplicantRow | undefined = readManagerApplicationRows().find((r) => r.id === applicationId);
    const property = hit
      ? ({ id: propertyId, title: "", buildingName: "", listingSubmission: hit.sub } as unknown as MockProperty)
      : undefined;
    const resolved =
      row && residentEmail && property
        ? resolveResidentMoveInFromApplications(residentEmail, [row], { [propertyId]: property })
        : null;
    return describeMoveInDetails(resolved, hit ? isEntireHomeListing(hit.sub) : false);
  }, [userId, applicationId, propertyId, residentEmail]);

  const open = (form: MoveInFormSummary) => {
    track("move_in_form_opened", { status: form.status });
    setViewing(form);
  };

  const downloadAll = async () => {
    for (const form of submitted) await actions.download(form);
  };

  return (
    <div className="min-w-0" data-attr="resident-record-move-in">
      <Card
        title="Move-in forms"
        dataAttr="resident-record-move-in-forms"
        actions={
          demo ? null : (
            <>
              <PortalIconAction
                icon={Download}
                label="Download all"
                disabled={submitted.length === 0}
                data-attr="resident-move-in-download-all"
                onClick={() => void downloadAll()}
              />
              <PortalPrimaryIconAction label="Send a form" data-attr="resident-move-in-send" onClick={() => setSendOpen(true)} />
            </>
          )
        }
      >
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
      </Card>

      <Card
        title={`Move-in details ${first} received`}
        dataAttr="resident-record-move-in-details"
        actions={
          propertyId ? (
            <PortalIconAction
              icon={ExternalLink}
              label="Open property Move-in"
              data-attr="resident-move-in-open-property"
              onClick={() => navigate(propertyDetailHref(basePath, "all", propertyId, "move-in"))}
            />
          ) : null
        }
      >
        <RecordFactRow label="Instructions" value={details.instructions} />
        <RecordFactRow label="Photos" value={details.photos} />
        <RecordFactRow label="Video" value={details.video} />
      </Card>

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
