"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { injectLeaseVisualEditDocument, serializeLeaseEditorDocument } from "@/lib/lease-html-sections";
import { cn } from "@/lib/utils";

type EditorMode = "visual" | "html";

type Props = {
  html: string;
  baselineHtml: string;
  onChange: (html: string) => void;
  onSectionFocus?: (sectionId: string) => void;
  className?: string;
  /** When false, hide the bottom save/reset bar (parent owns persistence). */
  showPersistBar?: boolean;
  onPersist?: () => void;
  persistLabel?: string;
  persistDisabled?: boolean;
  persistSaving?: boolean;
  persistError?: string | null;
  toolbarExtra?: React.ReactNode;
};

/** Full-lease direct editor with Visual / HTML modes — reusable outside the lease pipeline. */
export function LeaseHtmlDirectEditor({
  html,
  baselineHtml,
  onChange,
  onSectionFocus,
  className,
  showPersistBar = true,
  onPersist,
  persistLabel = "Save changes",
  persistDisabled = false,
  persistSaving = false,
  persistError = null,
  toolbarExtra,
}: Props) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const skipExternalSyncRef = useRef(false);
  const documentKeyRef = useRef<string | null>(null);
  const prevModeRef = useRef<EditorMode>(mode);
  const dirty = html.trim() !== baselineHtml.trim();

  const bindEditor = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return undefined;

    doc.body.contentEditable = "true";
    doc.body.setAttribute("spellcheck", "true");
    doc.body.setAttribute("data-attr", "lease-document-visual-editor");
    doc.querySelectorAll("p[data-disclosure-rule]").forEach((el) => {
      el.setAttribute("contenteditable", "false");
      el.setAttribute("title", "Required disclosure — edit the surrounding text only");
    });

    const onInput = () => {
      skipExternalSyncRef.current = true;
      onChange(serializeLeaseEditorDocument(doc));
    };
    doc.body.addEventListener("input", onInput);
    return () => doc.body.removeEventListener("input", onInput);
  }, [onChange]);

  const loadDocument = useCallback(
    (sourceHtml: string, opts?: { preserveScroll?: boolean }) => {
      const iframe = iframeRef.current;
      const doc = iframe?.contentDocument;
      const win = iframe?.contentWindow;
      if (!iframe || !doc) return;
      const scrollX = opts?.preserveScroll && win ? win.scrollX : 0;
      const scrollY = opts?.preserveScroll && win ? win.scrollY : 0;
      const prepared = injectLeaseVisualEditDocument(sourceHtml);
      doc.open();
      doc.write(prepared);
      doc.close();
      documentKeyRef.current = sourceHtml;
      if (opts?.preserveScroll && win) {
        win.scrollTo(scrollX, scrollY);
      }
      return bindEditor();
    },
    [bindEditor],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "lease-visual-section-focus") return;
      const sectionId = typeof event.data.sectionId === "string" ? event.data.sectionId : "";
      if (sectionId) onSectionFocus?.(sectionId);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSectionFocus]);

  useEffect(() => {
    const fromHtml = prevModeRef.current === "html" && mode === "visual";
    const firstLoad = mode === "visual" && documentKeyRef.current === null;
    if (firstLoad || fromHtml) {
      loadDocument(html);
    }
    prevModeRef.current = mode;
  }, [html, loadDocument, mode]);

  useEffect(() => {
    if (mode !== "visual") return;
    if (skipExternalSyncRef.current) {
      skipExternalSyncRef.current = false;
      documentKeyRef.current = html;
      return;
    }
    if (documentKeyRef.current === html) return;
    const cleanup = loadDocument(html, { preserveScroll: true });
    return () => cleanup?.();
  }, [html, loadDocument, mode]);

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card", className)}
      data-attr="lease-html-direct-editor"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <LocalDestinationNav
          items={[
            { id: "visual", label: "Visual", dataAttr: "lease-document-mode-visual" },
            { id: "html", label: "HTML", dataAttr: "lease-document-mode-html" },
          ]}
          activeId={mode}
          onChange={(id) => setMode(id as EditorMode)}
          ariaLabel="Lease editor view"
        />
        {toolbarExtra ? <div className="flex shrink-0 items-center gap-2">{toolbarExtra}</div> : null}
      </div>

      {persistError ? <p className="shrink-0 px-3 py-1.5 text-sm text-rose-700">{persistError}</p> : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {mode === "visual" ? (
          <iframe
            ref={iframeRef}
            title="Lease visual editor"
            sandbox="allow-same-origin allow-scripts"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : (
          <Textarea
            value={html}
            onChange={(e) => onChange(e.target.value)}
            className="h-full min-h-0 resize-none rounded-none border-0 bg-white font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0"
            aria-label="Lease HTML editor"
            data-attr="lease-document-html-editor"
          />
        )}
      </div>

      {showPersistBar ? (
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-3 py-3">
          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            disabled={!dirty || persistSaving || persistDisabled}
            onClick={() => onChange(baselineHtml)}
          >
            Reset
          </Button>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            disabled={!dirty || persistSaving || persistDisabled || !onPersist}
            onClick={onPersist}
            data-attr="lease-document-save"
          >
            {persistSaving ? "Saving…" : persistLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
