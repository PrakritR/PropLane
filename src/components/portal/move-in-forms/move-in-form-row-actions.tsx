"use client";

/**
 * The ⋯ menus for a move-in form row, shared by the sidebar list and the resident record.
 *
 * Submitted: Open · Download PDF · Open resident · Send again.
 * Waiting:   Remind · Preview form · Open resident · Cancel request (destructive, confirmed).
 *
 * Handlers go through `client.ts`, which clears the list cache and fires MOVE_IN_FORMS_CHANGED
 * on every write, so every list on screen re-reads on its own. Analytics events carry the form's
 * status only: never a name, an email or an id.
 */
import { useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { track } from "@/lib/analytics/track-client";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { residentDetailHref } from "@/lib/portal-detail-routes";
import {
  cancelMoveInForm,
  downloadMoveInFormPdf,
  remindMoveInForm,
  sendMoveInForm,
} from "@/lib/move-in-forms/client";
import type { MoveInFormSummary } from "@/lib/move-in-forms/types";

function firstName(form: Pick<MoveInFormSummary, "residentName">): string {
  return form.residentName.trim().split(/\s+/)[0] || "the resident";
}

function failure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function moveInFormPdfFileName(form: Pick<MoveInFormSummary, "formName" | "residentName">): string {
  const base = `${form.formName} - ${form.residentName}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `${base || "Move-in form"}.pdf`;
}

export type MoveInFormRowActionHandlers = {
  remind: (form: MoveInFormSummary) => Promise<void>;
  download: (form: MoveInFormSummary) => Promise<void>;
  sendAgain: (form: MoveInFormSummary) => Promise<void>;
  cancel: (form: MoveInFormSummary) => Promise<void>;
  openResident: (form: MoveInFormSummary) => void;
};

export function useMoveInFormRowActions(): MoveInFormRowActionHandlers {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const portalBase = usePaidPortalBasePath();

  const remind = useCallback(
    async (form: MoveInFormSummary) => {
      try {
        await remindMoveInForm(form.id);
        track("move_in_form_reminded", { status: form.status });
        showToast(`Reminder sent to ${firstName(form)}`);
      } catch (error) {
        showToast(failure(error, "Could not send the reminder."));
      }
    },
    [showToast],
  );

  const download = useCallback(
    async (form: MoveInFormSummary) => {
      try {
        await downloadMoveInFormPdf("manager", form.id, moveInFormPdfFileName(form));
        track("move_in_form_downloaded", { status: form.status });
      } catch (error) {
        showToast(failure(error, "Could not download this form."));
      }
    },
    [showToast],
  );

  const sendAgain = useCallback(
    async (form: MoveInFormSummary) => {
      try {
        await sendMoveInForm({ applicationId: form.applicationId, formId: form.formId });
        track("move_in_form_sent", { source: "send_again" });
        showToast(`${form.formName} sent to ${firstName(form)} again`);
      } catch (error) {
        showToast(failure(error, "Could not send this form."));
      }
    },
    [showToast],
  );

  const cancel = useCallback(
    async (form: MoveInFormSummary) => {
      const ok = await confirm({
        title: "Cancel this request?",
        description: `${form.formName} will no longer be waiting on ${firstName(form)}.`,
        confirmLabel: "Cancel request",
        note: null,
        tone: "danger",
        dataAttr: "move-in-form-cancel-confirm",
      });
      if (!ok) return;
      try {
        await cancelMoveInForm(form.id);
        track("move_in_form_cancelled", { status: form.status });
        showToast("Request cancelled");
      } catch (error) {
        showToast(failure(error, "Could not cancel this request."));
      }
    },
    [confirm, showToast],
  );

  const openResident = useCallback(
    (form: MoveInFormSummary) => {
      navigate(residentDetailHref(portalBase, "current", form.applicationId, "overview"));
    },
    [navigate, portalBase],
  );

  return { remind, download, sendAgain, cancel, openResident };
}

/**
 * The menu leaves for one row, in the plan's order. `onOpen` shows the form (the viewer);
 * `includeResident` is false on the resident's own record, where "Open resident" would go nowhere.
 */
export function MoveInFormMenuItems({
  form,
  actions,
  onOpen,
  includeResident = true,
}: {
  form: MoveInFormSummary;
  actions: MoveInFormRowActionHandlers;
  onOpen: (form: MoveInFormSummary) => void;
  includeResident?: boolean;
}): ReactNode {
  const item = (label: string, dataAttr: string, onClick: () => void | Promise<unknown>, variant: "outline" | "danger" = "outline") => (
    <Button key={dataAttr} type="button" variant={variant} className={PORTAL_BULK_BAR_BTN} data-attr={dataAttr} onClick={onClick}>
      {label}
    </Button>
  );
  if (form.status === "submitted") {
    return (
      <>
        {item("Open", "move-in-form-open", () => onOpen(form))}
        {item("Download PDF", "move-in-form-download", () => actions.download(form))}
        {includeResident ? item("Open resident", "move-in-form-open-resident", () => actions.openResident(form)) : null}
        {item("Send again", "move-in-form-send-again", () => actions.sendAgain(form))}
      </>
    );
  }
  return (
    <>
      {item("Remind", "move-in-form-remind", () => actions.remind(form))}
      {item("Preview form", "move-in-form-preview", () => onOpen(form))}
      {includeResident ? item("Open resident", "move-in-form-open-resident", () => actions.openResident(form)) : null}
      {item("Cancel request", "move-in-form-cancel", () => actions.cancel(form), "danger")}
    </>
  );
}
