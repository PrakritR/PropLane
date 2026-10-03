"use client";

import { useMemo, useRef, useState } from "react";
import { Bold, List, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import {
  applyLeaseSectionBodyEdits,
  extractLeaseDocumentStyles,
  insertLeaseHtmlSectionAfter,
  parseLeaseHtmlSections,
  removeLeaseHtmlSection,
  renameLeaseHtmlSectionTitle,
  scopeLeaseDocumentStyles,
  type LeaseHtmlSection,
} from "@/lib/lease-html-sections";
import { cn } from "@/lib/utils";

const HEADER_ID = "lease-document-header";

type Props = {
  html: string;
  onChange: (html: string) => void;
  className?: string;
  detectedFieldCount?: number;
};

function execOnBody(bodyEl: HTMLDivElement, command: string, value?: string) {
  bodyEl.focus();
  try {
    document.execCommand(command, false, value);
  } catch {
    /* jsdom / unsupported */
  }
}

export function PropertyLeaseClausePaperEditor({ html, onChange, className, detectedFieldCount }: Props) {
  const sections = useMemo(() => parseLeaseHtmlSections(html), [html]);
  const scopedCss = useMemo(() => {
    const raw = extractLeaseDocumentStyles(html);
    return raw ? scopeLeaseDocumentStyles(raw, ".lease-clause-paper") : "";
  }, [html]);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const bodyRefs = useRef(new Map<string, HTMLDivElement>());

  const patchBody = (sectionId: string, bodyHtml: string) => {
    onChange(applyLeaseSectionBodyEdits(html, { [sectionId]: bodyHtml }));
  };

  const clauseSections = sections.filter((s) => s.id !== HEADER_ID);
  const headerSection = sections.find((s) => s.id === HEADER_ID);

  const renderClause = (section: LeaseHtmlSection) => {
    const isRenaming = renameId === section.id;
    return (
      <div key={section.id} className="group relative rounded-lg border border-transparent px-2 py-2 hover:border-border hover:bg-accent/20">
        <div className="mb-1 flex items-start gap-2">
          {isRenaming ? (
            <Input
              autoFocus
              value={renameDraft}
              className="h-9 flex-1 text-sm font-semibold"
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => {
                if (renameDraft.trim()) onChange(renameLeaseHtmlSectionTitle(html, section.id, renameDraft));
                setRenameId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            <h2
              className="flex-1 text-sm font-semibold text-foreground"
              dangerouslySetInnerHTML={{ __html: section.headingHtml || section.title }}
            />
          )}
          <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
            <Button
              type="button"
              variant="outline"
              className="h-8 min-w-8 px-2"
              aria-label="Bold"
              data-attr="lease-clause-bold"
              onClick={() => {
                const el = bodyRefs.current.get(section.id);
                if (el) execOnBody(el, "bold");
              }}
            >
              <Bold className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-8 min-w-8 px-2"
              aria-label="Bulleted list"
              data-attr="lease-clause-list"
              onClick={() => {
                const el = bodyRefs.current.get(section.id);
                if (el) execOnBody(el, "insertUnorderedList");
              }}
            >
              <List className="size-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={RECORD_ACTION_TRIGGER_BUTTON_CLASS} aria-label="Clause actions">
                  <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setRenameId(section.id);
                    setRenameDraft(section.title);
                  }}
                >
                  Rename clause
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-rose-700 focus:text-rose-700"
                  onSelect={() => onChange(removeLeaseHtmlSection(html, section.id))}
                >
                  Remove clause
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="outline"
              className="h-8 min-w-8 px-2 text-rose-700"
              aria-label="Remove clause"
              data-attr="lease-clause-remove"
              onClick={() => onChange(removeLeaseHtmlSection(html, section.id))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        <div
          ref={(node) => {
            if (node) bodyRefs.current.set(section.id, node);
            else bodyRefs.current.delete(section.id);
          }}
          className="lease-clause-body min-h-[2rem] rounded-md px-1 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary/30"
          contentEditable
          suppressContentEditableWarning
          data-attr="lease-clause-body"
          data-lease-section-id={section.id}
          dangerouslySetInnerHTML={{ __html: section.bodyHtml }}
          onInput={(e) => patchBody(section.id, (e.currentTarget as HTMLDivElement).innerHTML)}
        />
        <button
          type="button"
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-sm font-medium text-muted hover:border-primary hover:text-primary"
          data-attr="lease-clause-add-after"
          onClick={() =>
            onChange(
              insertLeaseHtmlSectionAfter(html, section.id, {
                title: "New clause",
                bodyHtml: "<p>Clause text</p>",
              }),
            )
          }
        >
          + Add clause
        </button>
      </div>
    );
  };

  return (
    <div
      className={cn(
        "lease-clause-paper flex min-h-[min(420px,55vh)] flex-col overflow-auto rounded-2xl border border-border bg-card p-4",
        className,
      )}
      data-attr="property-lease-clause-paper-editor"
    >
      {scopedCss ? <style>{scopedCss}</style> : null}
      {typeof detectedFieldCount === "number" && detectedFieldCount > 0 ? (
        <p className="mb-3 text-sm text-muted" data-attr="property-lease-detected-fields-inline">
          <span className="font-semibold text-foreground">{detectedFieldCount} PDF fields detected</span>
        </p>
      ) : null}
      {headerSection ? (
        <div className="mb-4 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: headerSection.bodyHtml }} />
      ) : null}
      <div className="space-y-1">{clauseSections.map((section) => renderClause(section))}</div>
      <button
        type="button"
        className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-3 text-sm font-semibold text-foreground hover:border-primary hover:text-primary"
        data-attr="lease-clause-add-section-row"
        onClick={() =>
          onChange(
            insertLeaseHtmlSectionAfter(html, clauseSections.at(-1)?.id ?? null, {
              title: "New clause",
              bodyHtml: "<p>Clause text</p>",
            }),
          )
        }
      >
        + Add clause
      </button>
    </div>
  );
}
