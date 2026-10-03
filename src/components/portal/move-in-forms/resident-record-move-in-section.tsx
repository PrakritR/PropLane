"use client";

/**
 * Resident record › Move-in. Two cards, per docs/agents/record-page.md:
 *  - "Move-in forms": every form sent to this resident as flat rows (the sidebar list's facts and
 *    ⋯, minus "Open resident"), with Download all and the round + that opens the send popup
 *    already pointed at this resident.
 *  - "Move-in details <first name> received": the property's existing move-in instructions,
 *    photos and video as plain facts, with an icon link to the property's Move-in tab.
 * Only facts that exist are shown; there is no "Opened" row because nothing records it.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { MoveInFormViewer } from "@/components/portal/move-in-forms/move-in-form-viewer";
import { SendMoveInFormPopup } from "@/components/portal/move-in-forms/move-in-form-send-popup";
import { MoveInFormMenuItems, useMoveInFormRowActions } from "@/components/portal/move-in-forms/move-in-form-row-actions";
import { moveInFormEntryFacts } from "@/components/portal/move-in-forms/manager-move-in-forms-panel";
import { useManagerMoveInForms } from "@/hooks/use-move-in-forms";
import { track } from "@/lib/analytics/track-client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { moveInFormTab } from "@/lib/move-in-forms/manager-rows";
import type { MoveInFormSummary } from "@/lib/move-in-forms/types";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { propertyDetailHref } from "@/lib/portal-detail-routes";
import { resolveResidentMoveInFromApplications } from "@/lib/resident-move-in-resolve";

/** Submitted first, oldest to newest as filed, then what is still waiting by due date. */
export function orderResidentMoveInForms(forms: MoveInFormSummary[]): MoveInFormSummary[] {
  const stamp = (value: string | null) => value ?? "9999-12-31";
  return forms
    .filter((form) => moveInFormTab(form) !== null)
    .sort((a, b) => {
      const aTab = moveInFormTab(a) === "submitted" ? 0 : 1;
      const bTab = moveInFormTab(b) === "submitted" ? 0 : 1;
      if (aTab !== bTab) return aTab - bTab;
      return aTab === 0
        ? stamp(a.submittedAt).localeCompare(stamp(b.submittedAt))
        : stamp(a.dueAt).localeCompare(stamp(b.dueAt)) || stamp(a.sentAt).localeCompare(stamp(b.sentAt));
    });
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
  const { list, loading, error, retry } = useManagerMoveInForms(userId, { applicationId });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<MoveInFormSummary | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const demo = isDemoModeActive();
  const first = residentName.trim().split(/\s+/)[0] || "this resident";

  const forms = useMemo(() => orderResidentMoveInForms(list.forms.filter((form) => form.applicationId === applicationId)), [list.forms, applicationId]);
  const now = useMemo(() => new Date(), []);
  const submitted = forms.filter((form) => form.status === "submitted");
  const selectedForm = selected.size === 1 ? forms.find((form) => selected.has(form.id)) : undefined;

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
            isEmpty={forms.length === 0}
            loading={loading}
            loadError={error ? "Couldn't load move-in forms" : undefined}
            onRetry={retry}
            emptyCard={{
              title: `No move-in forms sent to ${first}`,
              section: "move-in",
              actions: demo ? [] : [{ label: "Send a form", onClick: () => setSendOpen(true), dataAttr: "resident-move-in-empty-send" }],
            }}
            onBulkClear={() => setSelected(new Set())}
            bulkCount={selected.size}
            bulkActions={
              selectedForm ? (
                <PortalSectionActionRow variant="header">
                  <MoveInFormMenuItems form={selectedForm} actions={actions} onOpen={open} includeResident={false} />
                </PortalSectionActionRow>
              ) : undefined
            }
            dataAttr="resident-move-in-forms-list"
          >
            <div className="divide-y divide-border/70">
              {forms.map((form) => (
                <PortalEntryRow
                  key={form.id}
                  tile={{ kind: "glyph", icon: FileText }}
                  title={form.formName}
                  facts={moveInFormEntryFacts(form, now)}
                  checked={selected.has(form.id)}
                  onSelectedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(form.id);
                      else next.delete(form.id);
                      return next;
                    })
                  }
                  onOpen={() => open(form)}
                  omitActionView
                  selectLabel={form.formName}
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
