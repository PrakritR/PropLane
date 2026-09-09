"use client";

import { useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  injectLeaseVisualEditDocument,
  serializeLeaseEditorDocument,
} from "@/lib/lease-html-sections";
import { sanitizeLeaseDocumentHtml } from "@/lib/lease-document-sanitizer";
import { cn } from "@/lib/utils";

type EditorMode = "visual" | "html";

type Props = {
  html: string;
  baselineHtml: string;
  onChange: (html: string) => void;
  onSectionFocus?: (sectionId: string) => void;
  /** The current HTML once its Visual document is readable; null while unavailable. */
  onPreviewReady?: (html: string | null) => void;
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
  onPreviewReady,
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
  const documentKeyRef = useRef<{
    frame: HTMLIFrameElement;
    html: string;
  } | null>(null);
  const callbacksRef = useRef({ onChange, onPreviewReady, onSectionFocus });
  const [previewState, setPreviewState] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const [retry, setRetry] = useState(0);
  const dirty = html.trim() !== baselineHtml.trim();

  // Inline parent callbacks change on ordinary renders (including acknowledgment).
  // They must not tear down the document's input listener or reload its contents.
  useEffect(() => {
    callbacksRef.current = { onChange, onPreviewReady, onSectionFocus };
  }, [onChange, onPreviewReady, onSectionFocus]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== "lease-visual-section-focus") return;
      const sectionId =
        typeof event.data.sectionId === "string" ? event.data.sectionId : "";
      if (sectionId) callbacksRef.current.onSectionFocus?.(sectionId);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    callbacksRef.current.onPreviewReady?.(null);
    if (mode !== "visual") {
      documentKeyRef.current = null;
      return;
    }
    const iframe = iframeRef.current;
    if (!iframe) return;
    let disposeInput: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frameRequest = 0;
    let settled = false;
    if (documentKeyRef.current?.frame !== iframe || documentKeyRef.current.html !== html) {
      setPreviewState("loading");
    }

    const fail = (
      reason:
        "document_unavailable" | "empty_document" | "viewport_unavailable",
    ) => {
      if (settled) return;
      settled = true;
      setPreviewState("failed");
      callbacksRef.current.onPreviewReady?.(null);
      try {
        // Never include the caught exception or source HTML: either may carry lease PII.
        posthog.captureException(new Error("Lease visual preview failed"), {
          reason,
        });
      } catch {
        /* analytics must not interrupt review */
      }
    };
    const checkReady = () => {
      if (settled) return;
      const doc = iframe.contentDocument;
      if (!doc?.body?.textContent?.trim()) return;
      const rect = iframe.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) return;
      // innerText excludes CSS-hidden text in real browsers. jsdom has no layout.
      if (typeof doc.body.innerText === "string" && !doc.body.innerText.trim())
        return;
      settled = true;
      setPreviewState("ready");
      callbacksRef.current.onPreviewReady?.(html);
    };
    // rAF and ResizeObserver are rendering-steps callbacks, which a hidden
    // document suspends — silence there is not evidence the lease is unreadable.
    const documentHidden = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden";
    let timeout = 0;
    const onDeadline = () => {
      timeout = 0;
      checkReady();
      if (settled || documentHidden()) return;
      fail(
        iframe.contentDocument?.body?.textContent?.trim()
          ? "viewport_unavailable"
          : "empty_document",
      );
    };
    const armDeadline = () => {
      if (timeout) window.clearTimeout(timeout);
      timeout = window.setTimeout(onDeadline, 4000);
    };
    const onVisibilityChange = () => {
      if (settled) return;
      checkReady();
      if (settled || documentHidden()) return;
      armDeadline();
    };
    armDeadline();
    document.addEventListener("visibilitychange", onVisibilityChange);
    try {
      const doc = iframe.contentDocument;
      if (!doc) throw new Error("Document unavailable");
      const win = iframe.contentWindow;
      const scrollY = win?.scrollY ?? 0;
      const current = documentKeyRef.current;
      if (current?.frame !== iframe || current.html !== html) {
        doc.open();
        doc.write(
          injectLeaseVisualEditDocument(sanitizeLeaseDocumentHtml(html) ?? ""),
        );
        doc.close();
        documentKeyRef.current = { frame: iframe, html };
        win?.scrollTo(0, scrollY);
      }
      doc.body.contentEditable = "true";
      doc.body.setAttribute("spellcheck", "true");
      doc.body.setAttribute("data-attr", "lease-document-visual-editor");
      doc.querySelectorAll("p[data-disclosure-rule]").forEach((el) => {
        el.setAttribute("contenteditable", "false");
        el.setAttribute(
          "title",
          "Required disclosure — edit the surrounding text only",
        );
      });
      const onInput = () => {
        const next = serializeLeaseEditorDocument(doc);
        // An echo of our own edit must not rewrite the iframe and lose the caret.
        documentKeyRef.current = { frame: iframe, html: next };
        callbacksRef.current.onPreviewReady?.(null);
        callbacksRef.current.onChange(next);
      };
      doc.body.addEventListener("input", onInput);
      disposeInput = () => doc.body.removeEventListener("input", onInput);
      iframe.addEventListener("load", checkReady);
      frameRequest = requestAnimationFrame(checkReady);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(checkReady);
        resizeObserver.observe(iframe);
      }
    } catch {
      fail("document_unavailable");
    }
    return () => {
      settled = true;
      if (timeout) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelAnimationFrame(frameRequest);
      resizeObserver?.disconnect();
      iframe.removeEventListener("load", checkReady);
      disposeInput?.();
    };
  }, [html, mode, retry]);

  return (
    <div
      // Default height FLOOR, not `min-h-0`. The Visual pane is an `absolute inset-0`
      // iframe, so it contributes no intrinsic height: a host that is itself
      // content-sized gives this box nothing to distribute, it resolves to 0, and the
      // lease renders as a blank white panel — while the HTML tab keeps working,
      // because a textarea has an intrinsic rows height. `cn` is tailwind-merge, so a
      // host that sizes the editor itself still overrides this.
      className={cn(
        "flex min-h-64 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card",
        className,
      )}
      data-attr="lease-html-direct-editor"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <LocalDestinationNav
          items={[
            {
              id: "visual",
              label: "Visual",
              dataAttr: "lease-document-mode-visual",
            },
            { id: "html", label: "HTML", dataAttr: "lease-document-mode-html" },
          ]}
          activeId={mode}
          onChange={(id) => setMode(id as EditorMode)}
          ariaLabel="Lease editor view"
        />
        {toolbarExtra ? (
          <div className="flex shrink-0 items-center gap-2">{toolbarExtra}</div>
        ) : null}
      </div>

      {persistError ? (
        <p className="shrink-0 px-3 py-1.5 text-sm text-rose-700">
          {persistError}
        </p>
      ) : null}

      {/* Give the document viewport its own floor, even in content-sized hosts.
          An ancestor's minimum height alone cannot size an absolute iframe. */}
      <div className="relative min-h-48 flex-1 overflow-hidden bg-white">
        {mode === "visual" ? (
          <iframe
            ref={iframeRef}
            title="Lease visual editor"
            sandbox="allow-same-origin allow-scripts"
            scrolling="auto"
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
        {mode === "visual" && previewState !== "ready" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-sm text-muted">
            <p role={previewState === "failed" ? "alert" : "status"}>
              {previewState === "failed"
                ? "We couldn’t display this lease."
                : "Loading lease preview…"}
            </p>
            {previewState === "failed" ? (
              <Button
                type="button"
                variant="outline"
                data-attr="lease-preview-retry"
                onClick={() => {
                  documentKeyRef.current = null;
                  setRetry((value) => value + 1);
                }}
              >
                Retry preview
              </Button>
            ) : null}
          </div>
        ) : null}
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
