"use client";

/**
 * The "+" on Property › Move-in › Forms: Build a form, Upload a PDF, Start from a template,
 * or copy one from another of the manager's properties. Picking opens the builder; this
 * dialog only decides what the builder starts from.
 */
import { useState } from "react";
import { Copy, ListChecks, Upload } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { questionCountLabel } from "@/components/portal/move-in-forms/move-in-form-model";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MOVE_IN_FORM_STARTERS } from "@/lib/move-in-forms/templates";
import type { MoveInFormStarterKey, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { cn } from "@/lib/utils";

export type MoveInCopySource = { propertyId: string; label: string; templates: MoveInFormTemplate[] };

export type MoveInChooserPick =
  | { kind: "build" }
  | { kind: "upload" }
  | { kind: "starter"; starterKey: MoveInFormStarterKey }
  | { kind: "copy"; template: MoveInFormTemplate };

type View = "main" | "starters";

const CHOICE_CLASS =
  "group flex min-h-[112px] flex-col items-start justify-between gap-4 rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-(--motion-base) ease-(--motion-crossfade) hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 motion-reduce:transition-none";

function ChoiceTile({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid size-10 place-items-center rounded-xl bg-accent text-primary transition-transform duration-(--motion-base) ease-(--motion-nudge) group-hover:scale-105">
      {children}
    </span>
  );
}

export function MoveInFormChooser({
  open,
  onClose,
  copySources,
  onPick,
  canUploadPdf = true,
}: {
  open: boolean;
  onClose: () => void;
  copySources: readonly MoveInCopySource[];
  onPick: (pick: MoveInChooserPick) => void;
  /** Only the property's owner stores the original PDF; a co-manager can still build and copy forms. */
  canUploadPdf?: boolean;
}) {
  const [view, setView] = useState<View>("main");
  const [sourceId, setSourceId] = useState("");
  const source = copySources.find((item) => item.propertyId === sourceId) ?? null;

  const close = () => {
    setView("main");
    setSourceId("");
    onClose();
  };
  const pick = (next: MoveInChooserPick) => {
    setView("main");
    setSourceId("");
    onPick(next);
  };

  return (
    <PortalDialog
      open={open}
      onClose={close}
      title={view === "starters" ? "Start from a template" : "New move-in form"}
      onBack={view === "starters" ? () => setView("main") : undefined}
      primaryAction={null}
      // A pick-one chooser has no form values to snapshot: no empty left column, no "Preview: No changes".
      contextPanel={null}
      preview={null}
      // Three tiles and an optional copy picker: a content-sized dialog, not the full popup frame.
      fullScreenMobile={false}
      dataAttr="move-in-form-chooser"
    >
      {view === "main" ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <button type="button" className={CHOICE_CLASS} onClick={() => pick({ kind: "build" })} data-attr="move-in-form-choose-build">
              <ChoiceTile>
                <ListChecks className="size-5" aria-hidden />
              </ChoiceTile>
              <b className="text-[14.5px] text-foreground">Build a form</b>
            </button>
            <button
              type="button"
              className={cn(CHOICE_CLASS, !canUploadPdf && "pointer-events-none opacity-50")}
              disabled={!canUploadPdf}
              title={canUploadPdf ? undefined : "Only the property owner can upload the form's PDF."}
              onClick={() => pick({ kind: "upload" })}
              data-attr="move-in-form-choose-upload"
            >
              <ChoiceTile>
                <Upload className="size-5" aria-hidden />
              </ChoiceTile>
              <b className="text-[14.5px] text-foreground">Upload a PDF</b>
            </button>
            <button type="button" className={CHOICE_CLASS} onClick={() => setView("starters")} data-attr="move-in-form-choose-template">
              <ChoiceTile>
                <Copy className="size-5" aria-hidden />
              </ChoiceTile>
              <b className="text-[14.5px] text-foreground">Start from a template</b>
            </button>
          </div>
          {copySources.length > 0 ? (
            <div className="space-y-3 border-t border-border/70 pt-4">
              <FieldSingleSelect
                label="Copy from another property"
                labelClassName="mb-2 block text-sm font-semibold text-foreground"
                value={sourceId}
                onChange={setSourceId}
                placeholder="Choose a property"
                options={copySources.map((item) => ({
                  value: item.propertyId,
                  label: `${item.label} · ${item.templates.length} form${item.templates.length === 1 ? "" : "s"}`,
                }))}
                dataAttr="move-in-form-copy-property"
              />
              {source ? (
                <FieldSingleSelect
                  label="Form"
                  labelClassName="mb-2 block text-sm font-semibold text-foreground"
                  value=""
                  onChange={(id) => {
                    const template = source.templates.find((item) => item.id === id);
                    if (template) pick({ kind: "copy", template });
                  }}
                  placeholder="Choose a form"
                  options={source.templates.map((item) => ({ value: item.id, label: item.name || "Untitled form" }))}
                  dataAttr="move-in-form-copy-form"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-2">
          {MOVE_IN_FORM_STARTERS.map((starter) => (
            <li key={starter.id}>
              <button
                type="button"
                onClick={() => starter.starterKey && pick({ kind: "starter", starterKey: starter.starterKey })}
                data-attr={`move-in-form-starter-${starter.starterKey}`}
                className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-[transform,box-shadow,border-color] duration-(--motion-base) ease-(--motion-crossfade) hover:-translate-y-px hover:border-primary/40 hover:shadow-md motion-reduce:transition-none"
              >
                <span className="text-[14.5px] font-semibold text-foreground">{starter.name}</span>
                <span className="shrink-0 text-xs text-muted">{questionCountLabel(starter.questions.length)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </PortalDialog>
  );
}
