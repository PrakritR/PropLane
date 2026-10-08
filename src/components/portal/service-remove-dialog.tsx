"use client";

/**
 * The one popup behind a service record's red trash icon (plan admin-money-1008, D8). Cancel and Delete used to
 * be two controls; they are one question now, answered with two radio choices:
 *
 *  - Cancel service (the default, and the only choice offered once the service is finished): keeps the history,
 *    moves the service to Completed as Cancelled and withdraws open vendor requests.
 *  - Delete permanently: removes the service. A destructive confirm, so it is the press-and-hold button every
 *    delete uses; Cancel service is a plain tap.
 *
 * What each choice does is read off the preview beside the radios, never a sentence under them.
 */
import { useEffect, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PopupRecordPreview, PopupSubjectCard } from "@/components/portal/popup-live-preview";

export type ServiceRemoveChoice = "cancel" | "delete";

export const SERVICE_REMOVE_LABEL: Record<ServiceRemoveChoice, string> = {
  cancel: "Cancel service",
  delete: "Delete permanently",
};

export function ServiceRemoveDialog({
  open,
  title,
  lines,
  canCancel = true,
  busy = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** The service's title. */
  title: string;
  /** The subject card's lines (resident, property). */
  lines?: ReadonlyArray<string | null | undefined>;
  /** False once the service is finished: there is nothing left to cancel, only to delete. */
  canCancel?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (choice: ServiceRemoveChoice) => void;
}) {
  const [choice, setChoice] = useState<ServiceRemoveChoice>(canCancel ? "cancel" : "delete");
  useEffect(() => {
    if (open) setChoice(canCancel ? "cancel" : "delete");
  }, [open, canCancel]);
  const choices: ServiceRemoveChoice[] = canCancel ? ["cancel", "delete"] : ["delete"];
  const deleting = choice === "delete";

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Remove service"
      tone={deleting ? "danger" : "default"}
      dismissBlocked={busy}
      dataAttr="service-remove-dialog"
      contextPanel={<PopupSubjectCard title={title || "Service"} lines={lines} />}
      previewLabel="What happens"
      preview={
        deleting ? (
          <PopupRecordPreview
            rows={[
              { label: "Service", value: title || "Service" },
              { label: "Removes", value: "The service and its history" },
            ]}
          />
        ) : (
          <PopupRecordPreview
            rows={[
              { label: "Service", value: title || "Service" },
              { label: "Moves to", value: "Completed as Cancelled" },
              { label: "Vendor requests", value: "Withdrawn" },
            ]}
          />
        )
      }
      primaryAction={{
        label: SERVICE_REMOVE_LABEL[choice],
        onClick: () => onConfirm(choice),
        disabled: busy,
        loading: busy,
        dataAttr: deleting ? "service-remove-delete" : "service-remove-cancel",
        ...(deleting ? { confirmGuard: "hold" as const } : {}),
      }}
    >
      <fieldset className="space-y-2" data-attr="service-remove-choices">
        <legend className="sr-only">Remove service</legend>
        {choices.map((id) => (
          <label
            key={id}
            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-accent/30"
          >
            <input
              type="radio"
              name="service-remove-choice"
              value={id}
              checked={choice === id}
              onChange={() => setChoice(id)}
              disabled={busy}
              className="h-4 w-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
              data-attr={`service-remove-choice-${id}`}
            />
            <span className={id === "delete" ? "text-danger" : undefined}>{SERVICE_REMOVE_LABEL[id]}</span>
          </label>
        ))}
      </fieldset>
    </PortalDialog>
  );
}
