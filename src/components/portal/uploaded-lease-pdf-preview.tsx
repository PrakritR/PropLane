"use client";

import { useEffect, useRef, useState } from "react";

const MAX_RENDERED_PAGES = 48;
/** Cap the raster edge so a phone never allocates a canvas iOS will silently blank. */
const MAX_CANVAS_EDGE = 2000;
const BASE_RENDER_SCALE = 1.5;

function prefersRasterPreview(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios || document.documentElement.hasAttribute("data-native");
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(",") ? (dataUrl.split(",")[1] ?? "") : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Yield to the event loop so main-thread page rendering cannot lock up the UI. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `toBlob` reports failure by handing back `null`, and throws outright where it is unimplemented. */
function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
    } catch {
      resolve(null);
    }
  });
}

type RasterResult = { totalPages: number; failedPages: number[] };

/**
 * Rasterize a PDF to page images in the BROWSER.
 *
 * iOS WKWebView (and therefore the Capacitor shell) does not render PDFs inside
 * an iframe/embed/object, so the native app needs real pixels. pdf.js ships
 * inside `unpdf`, which we already depend on for server-side PDF work, and its
 * bundle carries the worker inline — so it runs with no separate worker asset
 * and no new dependency. It is imported dynamically, so the ~1.6 MB minified
 * chunk is fetched only when a lease PDF preview actually mounts.
 *
 * Each page is drawn into ONE reused canvas and immediately handed off as a JPEG
 * object URL: keeping 48 live canvases would blow past the per-tab canvas memory
 * limit on a phone, and base64 data URLs for the same pages would pin 15–35 MB of
 * unevictable string in React state. An object URL costs a handle, and the caller
 * owns revoking it.
 *
 * A page that cannot be rendered or encoded is reported in `failedPages` and the
 * rest of the document still renders — one bad page object must not cost the
 * reader the other 47.
 */
async function renderPdfPagesInBrowser(
  dataUrl: string,
  onPage: (pageUrl: string, totalPages: number) => void,
  isCancelled: () => boolean,
): Promise<RasterResult> {
  const failedPages: number[] = [];
  const pdfjs = await import("unpdf/pdfjs");
  if (isCancelled()) return { totalPages: 0, failedPages };

  const source = dataUrl.startsWith("data:") ? { data: dataUrlToBytes(dataUrl) } : { url: dataUrl };
  const loadingTask = pdfjs.getDocument({ ...source, disableAutoFetch: true });

  try {
    const pdf = await loadingTask.promise;
    if (isCancelled()) return { totalPages: 0, failedPages };

    const totalPages = pdf.numPages;
    const limit = Math.min(totalPages, MAX_RENDERED_PAGES);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable.");

    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      if (isCancelled()) return { totalPages, failedPages };
      try {
        const page = await pdf.getPage(pageNumber);
        try {
          const base = page.getViewport({ scale: 1 });
          const density = Math.min(window.devicePixelRatio || 1, 2);
          const wanted = BASE_RENDER_SCALE * density;
          const fit = MAX_CANVAS_EDGE / Math.max(base.width, base.height);
          const viewport = page.getViewport({ scale: Math.min(wanted, fit) });

          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          // PDF pages are transparent; without this text renders onto black in JPEG.
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          if (isCancelled()) return { totalPages, failedPages };

          const blob = await canvasToJpegBlob(canvas);
          if (isCancelled()) return { totalPages, failedPages };
          if (blob) onPage(URL.createObjectURL(blob), totalPages);
          else failedPages.push(pageNumber);
        } finally {
          page.cleanup();
        }
      } catch {
        failedPages.push(pageNumber);
      }
      await yieldToBrowser();
    }

    canvas.width = 0;
    canvas.height = 0;
    return { totalPages, failedPages };
  } finally {
    void loadingTask.destroy().catch(() => {});
  }
}

/**
 * Scrollable preview for manager- or resident-uploaded lease PDFs.
 * Desktop keeps the browser's own embedded PDF viewer; iOS / native WebViews
 * rasterize pages in-page because those engines do not render embedded PDFs.
 */
export function UploadedLeasePdfPreview({
  dataUrl,
  title,
  fileName,
  className,
  embeddedInFlex = false,
  documentFlow = false,
}: {
  dataUrl: string;
  title: string;
  fileName?: string;
  className?: string;
  embeddedInFlex?: boolean;
  /** Stack pages in the page scroll instead of a nested preview scroller. */
  documentFlow?: boolean;
}) {
  const [useRaster, setUseRaster] = useState(() => prefersRasterPreview() || documentFlow);
  const [pages, setPages] = useState<string[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    setUseRaster(prefersRasterPreview() || documentFlow);
  }, [documentFlow]);

  useEffect(() => {
    if (!useRaster) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    setLoading(true);
    setError(null);
    setPages([]);
    setTotalPages(0);
    void renderPdfPagesInBrowser(
      dataUrl,
      (pageUrl, count) => {
        // A page can land after cancellation; nothing will render it, so free it here.
        if (cancelled) {
          URL.revokeObjectURL(pageUrl);
          return;
        }
        pageUrlsRef.current.push(pageUrl);
        // Show each page as it finishes rather than blocking on the whole document.
        setTotalPages(count);
        setPages((prev) => [...prev, pageUrl]);
      },
      isCancelled,
    )
      .then(({ totalPages: count, failedPages }) => {
        if (cancelled) return;
        if (count) setTotalPages(count);
        if (!failedPages.length) return;
        setError(
          failedPages.length === 1
            ? `Page ${failedPages[0]} could not be rendered in the preview.`
            : `${failedPages.length} pages could not be rendered in the preview.`,
        );
      })
      .catch(() => {
        if (!cancelled) setError("Could not render this PDF in the preview.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      const stale = pageUrlsRef.current;
      pageUrlsRef.current = [];
      // Drop the <img> nodes first, then revoke a tick later: revoking a URL an
      // element is still fetching would blank a page mid-load.
      setPages([]);
      setTotalPages(0);
      setTimeout(() => {
        for (const url of stale) URL.revokeObjectURL(url);
      }, 0);
    };
  }, [dataUrl, useRaster]);

  const scrollClass = documentFlow
    ? ""
    : embeddedInFlex
      ? "min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
      : "max-h-[min(80dvh,900px)] overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]";

  const header = (
    <div className="border-b border-border bg-card px-3 py-2 text-xs">
      <a
        href={dataUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        Open full document{fileName ? ` — ${fileName}` : ""}
      </a>
      {totalPages > 1 ? (
        <span className="ml-2 text-muted">
          · {totalPages} page{totalPages === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );

  if (!useRaster) {
    return (
      <div className={className}>
        {header}
        <iframe
          title={title}
          src={dataUrl}
          className={`block w-full border-0 bg-white ${embeddedInFlex ? "min-h-[70dvh] flex-1" : documentFlow ? "min-h-[50rem]" : "min-h-[min(80dvh,900px)]"}`}
        />
      </div>
    );
  }

  return (
    <div className={className}>
      {header}
      <div className={scrollClass || undefined}>
        {error && !pages.length ? (
          <div className="space-y-2 px-4 py-8 text-center text-sm text-muted">
            <p>{error}</p>
            <p>Use Open full document above to view the complete file.</p>
          </div>
        ) : !pages.length && loading ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Loading lease pages…</p>
        ) : (
          <div className="space-y-2 bg-white p-2">
            {pages.map((src, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${title}-page-${index + 1}`}
                src={src}
                alt={`${title} — page ${index + 1}`}
                className="block w-full rounded border border-border/60 bg-white"
              />
            ))}
            {error ? (
              <p className="px-2 py-3 text-center text-xs text-muted">
                {error} Use Open full document above to view the complete file.
              </p>
            ) : loading ? (
              <p className="px-2 py-3 text-center text-xs text-muted">Loading more pages…</p>
            ) : totalPages > pages.length ? (
              <p className="px-2 py-3 text-center text-xs text-muted">
                Preview shows the first {Math.min(pages.length, MAX_RENDERED_PAGES)} pages. Open the full
                document to read the rest.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
