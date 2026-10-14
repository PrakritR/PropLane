"use client";

/**
 * The house workspace frame for the two move-in form popups (the submission viewer and Send a
 * form): the same full-screen overlay, header (title, saved state, Ask PropLane, close), rail
 * with a context card, centre, right-hand panel and footer the New property wizard and
 * `AddWorkspace` use. Those two own their own step footer; a viewer needs a plain Done, and the
 * one-screen send is a `singleStep` door — no rail, no context card above it and Send alone on the
 * right — so this wraps the same `ListingWorkspace` shell directly.
 */
import { useEffect, type ReactNode } from "react";
import { SINGLE_STEP_NO_RAIL_CLASS, SINGLE_STEP_NO_RAIL_WITH_PANEL_CLASS } from "@/components/portal/add-workspace/index";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import { ListingWorkspace } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { cn } from "@/lib/utils";
import { FIELD_SELECT_MENU_DATA_ATTR } from "@/components/ui/field-select-portal-interaction";

export function MoveInFormFrame({
  title,
  subtitle,
  saveState,
  onClose,
  headerActions,
  rail = null,
  railHeader,
  sidePanel,
  footer,
  children,
  assistantContext,
  assistantScopeKey,
  dataAttr,
  singleStep = false,
}: {
  title: string;
  subtitle?: string;
  saveState?: ReactNode;
  onClose: () => void;
  /** Icon actions beside Ask PropLane (Download PDF, Open in new tab). */
  headerActions?: ReactNode;
  /** The step rail (the viewer). A `singleStep` door hides the whole nav, so it passes none. */
  rail?: ReactNode;
  /** The resident context card above the rail. Hidden with the nav on a `singleStep` door. */
  railHeader?: ReactNode;
  sidePanel?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  assistantContext: string;
  assistantScopeKey: string;
  dataAttr?: string;
  /** A one-step door draws no step rail (the same behaviour as `AddWorkspace`'s `singleStep`). */
  singleStep?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)) return;
      if (document.querySelector('[data-slot="modal-radix-dialog"], [data-slot="modal-vaul-drawer"]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <ListingWizardOverlay ariaLabel={title}>
      <div
        className={cn("relative h-full w-full", singleStep && (sidePanel ? SINGLE_STEP_NO_RAIL_WITH_PANEL_CLASS : SINGLE_STEP_NO_RAIL_CLASS))}
        data-attr={dataAttr}
        data-rail={singleStep ? "none" : undefined}
      >
        <ListingWorkspace
          title={title}
          subtitle={subtitle}
          saveState={saveState}
          onClose={onClose}
          headerAside={
            <>
              {headerActions}
              <ModalAssistantStrip contextHint={assistantContext} storageScopeKey={assistantScopeKey} />
            </>
          }
          rail={rail}
          railHeader={railHeader}
          sidePanel={sidePanel}
          footer={footer}
        >
          {children}
        </ListingWorkspace>
      </div>
    </ListingWizardOverlay>
  );
}

/** The resident card at the top of the rail: initials tile, name, property · room. */
export function MoveInFormResidentCard({ name, place, extra }: { name: string; place: string; extra?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return (
    <div className="mb-3 rounded-2xl border border-border bg-card p-3.5" data-attr="move-in-form-resident-card">
      <div className="mb-2 grid size-11 place-items-center rounded-[10px] bg-primary/[0.08] text-[15px] font-extrabold text-primary" aria-hidden>
        {initials || "?"}
      </div>
      <p className="text-[14px] font-bold text-foreground">{name}</p>
      {place ? <p className="text-[12.5px] text-muted">{place}</p> : null}
      {extra ? <p className="mt-2 text-[12.5px] text-foreground">{extra}</p> : null}
    </div>
  );
}
