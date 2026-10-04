"use client";

/**
 * Property › Move-in › Forms: this property's move-in forms as plain rows (title, fact line, ⋯; no
 * on/off state, like the Applications list), and the chooser + editor behind the header's round
 * blue "+". Whether a form sends itself is the form's own "Sends" setting. Definitions live on the property
 * (`listingSubmission.moveInFormTemplates`) and save through the same server-confirmed path
 * the Application tab uses for `propertyApplicationTemplates`; sent copies are resident rows
 * and never live here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DoorOpen, FileText, Link2, ListChecks, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MoveInFormChooser, type MoveInChooserPick, type MoveInCopySource } from "@/components/portal/move-in-forms/move-in-form-chooser";
import {
  MoveInFormEditorModal,
  type MoveInEditorRoom,
  type MoveInEditorSaveOptions,
} from "@/components/portal/move-in-forms/move-in-form-editor-modal";
import {
  copyTemplateToProperty,
  duplicateMoveInTemplate,
  moveInFormPreviewHtml,
  moveInFormRowFacts,
  type MoveInFormRowFactId,
  removeMoveInTemplate,
  templateFigure,
  upsertMoveInTemplate,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { usePortalSession } from "@/hooks/use-portal-session";
import { roomIndicesInListingOrder } from "@/lib/listing-floor-order";
import {
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmissionOnServer,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import {
  loadMoveInForms,
  MOVE_IN_FORMS_CHANGED,
  moveInFormTemplatePdfUrl,
  sendMoveInFormToCurrentResidents,
} from "@/lib/move-in-forms/client";
import { newMoveInFormTemplate, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import type { MoveInFormSummary, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { readExtraListingsForUser, readPendingManagerPropertiesForUser } from "@/lib/demo-property-pipeline";

const ROW_FACT_ICON: Record<MoveInFormRowFactId, typeof ListChecks> = {
  questions: ListChecks,
  audience: DoorOpen,
  sends: Send,
  source: FileText,
  linked: Link2,
};
const ROW_FACT_LABEL: Record<MoveInFormRowFactId, string> = {
  questions: "Questions",
  audience: "Audience",
  sends: "Sent",
  source: "Source",
  linked: "Linked to",
};

type EditorState = { mode: "add" | "edit"; template: MoveInFormTemplate; startStep: number } | null;

function templateRooms(sub: ManagerListingSubmissionV1): MoveInEditorRoom[] {
  if (isEntireHomeListing(sub)) return [];
  return roomIndicesInListingOrder(sub.rooms).map((index) => {
    const room = sub.rooms[index]!;
    return { id: room.id, label: room.name.trim() || `Room ${index + 1}` };
  });
}

/** Other properties of this manager that already have forms of their own saved. */
function useCopySources(managerUserId: string | null, currentPropertyId: string): MoveInCopySource[] {
  return useMemo(() => {
    if (!managerUserId) return [];
    const out: MoveInCopySource[] = [];
    const seen = new Set<string>([currentPropertyId]);
    const consider = (id: string, label: string, submission: unknown) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const raw = submission as { moveInFormTemplates?: unknown } | null | undefined;
      if (!raw || !Array.isArray(raw.moveInFormTemplates)) return;
      const templates = readMoveInFormTemplates(raw);
      if (templates.length === 0) return;
      out.push({ propertyId: id, label: label || id, templates });
    };
    for (const listing of readExtraListingsForUser(managerUserId)) {
      const sub = listing.listingSubmission ? normalizeManagerListingSubmissionV1(listing.listingSubmission) : null;
      consider(listing.id, sub?.buildingName || sub?.address || listing.buildingName || listing.address || "", sub);
    }
    for (const pending of readPendingManagerPropertiesForUser(managerUserId)) {
      const sub = pending.submission ? normalizeManagerListingSubmissionV1(pending.submission) : null;
      consider(pending.id, sub?.buildingName || sub?.address || "", sub);
    }
    return out;
    // The stores are read-through localStorage caches; the identity of the property is the only real input.
  }, [managerUserId, currentPropertyId]);
}

export function PropertyMoveInFormsPanel({
  sub,
  saveTarget,
  managerUserId,
  canEdit,
  onUpdated,
  showToast,
  chooserOpen,
  onChooserOpenChange,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget | null;
  managerUserId: string | null;
  canEdit: boolean;
  onUpdated: () => void;
  showToast: (message: string) => void;
  chooserOpen: boolean;
  onChooserOpenChange: (open: boolean) => void;
}) {
  const { userId: viewerId } = usePortalSession();
  const propertyId = saveTarget?.saveId ?? "";
  // Originals are stored under the property owner's prefix, so only the owner uploads a PDF. Unknown
  // identity is treated as the owner; the server enforces it either way.
  const canUploadPdf = !viewerId || !managerUserId || viewerId === managerUserId;
  const templates = useMemo(() => readMoveInFormTemplates(sub), [sub]);
  const rooms = useMemo(() => templateRooms(sub), [sub]);
  const applicationTemplates = useMemo(
    () => readPropertyApplicationTemplates(sub).map((item) => ({ id: item.id, label: item.label.trim() || "Application" })),
    [sub],
  );
  const leaseTemplates = useMemo(
    () => readPropertyLeaseTemplates(sub).map((item) => ({ id: item.id, label: item.label.trim() || "Lease" })),
    [sub],
  );
  const copySources = useCopySources(managerUserId, propertyId);
  const [editor, setEditor] = useState<EditorState>(null);
  const confirm = useConfirm();
  const [sent, setSent] = useState<MoveInFormSummary[]>([]);

  const refreshSent = useCallback(
    async (force = false) => {
      if (!viewerId || !propertyId) return;
      try {
        const result = await loadMoveInForms(viewerId, "manager", { propertyId }, force);
        setSent(result.forms);
      } catch {
        // The figures are a convenience; a failed load leaves them at "0 sent".
      }
    },
    [viewerId, propertyId],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on mount; state is set after the awaited fetch
    void refreshSent();
    const refresh = () => void refreshSent(true);
    window.addEventListener(MOVE_IN_FORMS_CHANGED, refresh);
    return () => window.removeEventListener(MOVE_IN_FORMS_CHANGED, refresh);
  }, [refreshSent]);

  /** The stored list is exactly what the manager added; saving writes it back as is. */
  const persist = async (list: MoveInFormTemplate[], message: string): Promise<boolean> => {
    const next = list;
    if (!managerUserId || !saveTarget || !canEdit) {
      showToast("Could not save move-in forms.");
      return false;
    }
    const ok = await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, { ...sub, moveInFormTemplates: next });
    if (!ok) {
      showToast("Could not save move-in forms.");
      return false;
    }
    showToast(message);
    onUpdated();
    return true;
  };

  const onPick = (pick: MoveInChooserPick) => {
    onChooserOpenChange(false);
    if (pick.kind === "upload") {
      setEditor({ mode: "add", template: newMoveInFormTemplate("upload"), startStep: 0 });
    } else if (pick.kind === "starter") {
      setEditor({ mode: "add", template: newMoveInFormTemplate("built", pick.starterKey), startStep: 0 });
    } else if (pick.kind === "copy") {
      setEditor({ mode: "add", template: copyTemplateToProperty(pick.template, newMoveInFormTemplate(pick.template.source).id), startStep: 0 });
    } else {
      setEditor({ mode: "add", template: newMoveInFormTemplate("built"), startStep: 0 });
    }
  };

  const saveFromEditor = async (template: MoveInFormTemplate, options: MoveInEditorSaveOptions): Promise<boolean> => {
    const adding = editor?.mode === "add";
    const ok = await persist(upsertMoveInTemplate(templates, template), adding ? "Form created." : "Form saved.");
    if (!ok) return false;
    if (options.sendToCurrent && propertyId) {
      try {
        const result = await sendMoveInFormToCurrentResidents({ propertyId, formId: template.id });
        showToast(
          result.sent > 0
            ? `${adding ? "Form created" : "Form saved"}. Sent to ${result.sent} resident${result.sent === 1 ? "" : "s"}.`
            : `${adding ? "Form created" : "Form saved"}. No one to send it to yet.`,
        );
      } catch {
        showToast("Form saved. Could not send it to current residents.");
      }
    }
    void refreshSent(true);
    return true;
  };

  const openInNewTab = (template: MoveInFormTemplate) => {
    if (template.source === "upload") {
      if (!template.pdf) {
        showToast("No PDF uploaded yet.");
        return;
      }
      window.open(moveInFormTemplatePdfUrl("manager", template.id, propertyId), "_blank", "noopener,noreferrer");
      return;
    }
    const url = URL.createObjectURL(new Blob([moveInFormPreviewHtml(template)], { type: "text/html" }));
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const duplicate = async (template: MoveInFormTemplate) => {
    const { list, copy } = duplicateMoveInTemplate(templates, template.id, newMoveInFormTemplate(template.source).id);
    if (!copy) return;
    await persist(list, template.source === "upload" ? "Duplicated. Upload its PDF before sending it." : "Duplicated. The copy is sent only when you send it.");
  };

  const deleteTemplate = (template: MoveInFormTemplate): Promise<boolean> => persist(removeMoveInTemplate(templates, template.id), "Form deleted.");

  const confirmAndDelete = async (template: MoveInFormTemplate) => {
    const label = template.name.trim() || "Untitled form";
    if (await confirm({ description: `Delete ${label}?` })) await deleteTemplate(template);
  };

  if (!saveTarget) return null;

  return (
    <>
      <PortalRecordListSurface className="mt-0 pb-0 max-lg:pb-0" dataAttr="property-move-in-forms">
        {templates.length === 0 ? (
          <PortalListEmptyCard
            title="No move-in forms for this property"
            icon={<ListChecks className="size-[22px]" strokeWidth={1.6} aria-hidden />}
            workspaceAware={false}
            dataAttr="property-move-in-forms-empty"
          />
        ) : (
          <div role="list" aria-label="Move-in forms">
            {templates.map((template) => {
              const name = template.name.trim() || "Untitled form";
              return (
                <RecordActionContext.Provider
                  key={template.id}
                  value={{
                    scope: template.id,
                    clear: () => {},
                    actions: (
                      <>
                        <Button type="button" variant="outline" data-attr="move-in-form-row-preview" onClick={() => setEditor({ mode: "edit", template, startStep: 1 })}>
                          Preview
                        </Button>
                        {canEdit ? (
                          <Button type="button" variant="outline" data-attr="move-in-form-row-edit" onClick={() => setEditor({ mode: "edit", template, startStep: 0 })}>
                            Edit
                          </Button>
                        ) : null}
                        <Button type="button" variant="outline" data-attr="move-in-form-row-open-tab" onClick={() => openInNewTab(template)}>
                          Open in new tab
                        </Button>
                        {canEdit ? (
                          <Button type="button" variant="outline" data-attr="move-in-form-row-duplicate" onClick={() => void duplicate(template)}>
                            Duplicate
                          </Button>
                        ) : null}
                        {canEdit ? (
                          <Button type="button" variant="danger" data-attr="move-in-form-row-delete" onClick={() => void confirmAndDelete(template)}>
                            Delete
                          </Button>
                        ) : null}
                      </>
                    ),
                  }}
                >
                  <div role="listitem" className="transition-transform duration-(--motion-base) ease-(--motion-crossfade) hover:-translate-y-px motion-reduce:transition-none" data-attr="move-in-form-row">
                    <PortalPropertyRecordRow
                      title={name}
                      facts={moveInFormRowFacts(template, rooms, applicationTemplates, leaseTemplates).map((fact) => (
                        <PortalRowFact key={fact.id} icon={ROW_FACT_ICON[fact.id]} srLabel={ROW_FACT_LABEL[fact.id]}>
                          {fact.text}
                        </PortalRowFact>
                      ))}
                      leading={
                        <div className="flex size-11 items-center justify-center bg-accent text-foreground/80">
                          {template.source === "upload" ? (
                            <FileText className="size-[22px]" strokeWidth={1.6} aria-hidden />
                          ) : (
                            <ListChecks className="size-[22px]" strokeWidth={1.6} aria-hidden />
                          )}
                        </div>
                      }
                      leadingShape="square"
                      amount={templateFigure(template, sent) || undefined}
                      selectLabel={name}
                      onOpen={() => setEditor({ mode: "edit", template, startStep: 0 })}
                      onSelectedChange={() => {}}
                      omitActionView
                      dataAttr="move-in-form-row-open"
                    />
                  </div>
                </RecordActionContext.Provider>
              );
            })}
          </div>
        )}
      </PortalRecordListSurface>

      <MoveInFormChooser open={chooserOpen} onClose={() => onChooserOpenChange(false)} copySources={copySources} onPick={onPick} canUploadPdf={canUploadPdf} />

      {editor ? (
        <MoveInFormEditorModal
          key={editor.template.id}
          mode={editor.mode}
          initial={editor.template}
          rooms={rooms}
          applicationTemplates={applicationTemplates}
          leaseTemplates={leaseTemplates}
          propertyId={propertyId}
          startStep={editor.startStep}
          onSave={saveFromEditor}
          onDelete={editor.mode === "edit" && canEdit ? deleteTemplate : undefined}
          onClose={() => setEditor(null)}
          canUploadPdf={canUploadPdf}
        />
      ) : null}
    </>
  );
}
