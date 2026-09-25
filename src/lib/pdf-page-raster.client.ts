"use client";

/**
 * Shared browser-side PDF page rasterizer (night/custom-lease). Same approach
 * as `uploaded-lease-pdf-preview.tsx`'s `renderPdfPagesInBrowser` (unpdf's
 * bundled pdf.js, dynamically imported, one reused canvas, JPEG object URLs —
 * never base64 in React state) but returns each page's rendered pixel size
 * too, which the signature-field placement editor and the signing-view
 * preview both need to position an overlay box correctly.
 *
 * Field coordinates are stored normalized (0..1 of the page's own width/
 * height), so which raster scale this used never matters downstream — pdf-lib
 * re-derives the real page size in points at stamping time.
 */

const MAX_RENDERED_PAGES = 48;
const MAX_CANVAS_EDGE = 2000;
const BASE_RENDER_SCALE = 1.5;

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(",") ? (dataUrl.split(",")[1] ?? "") : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
    } catch {
      resolve(null);
    }
  });
}

export type RasterPage = { url: string; width: number; height: number };

/**
 * Rasterizes up to `MAX_RENDERED_PAGES` pages, calling `onPage` as each one is
 * ready. Returns the total page count. A page that fails to render or encode
 * is simply skipped — one bad page must not cost the reader the rest.
 */
export async function rasterizeLeasePdfPages(
  dataUrl: string,
  onPage: (page: RasterPage, index: number, totalPages: number) => void,
  isCancelled: () => boolean = () => false,
): Promise<number> {
  const pdfjs = await import("unpdf/pdfjs");
  if (isCancelled()) return 0;

  const source = dataUrl.startsWith("data:") ? { data: dataUrlToBytes(dataUrl) } : { url: dataUrl };
  const loadingTask = pdfjs.getDocument({ ...source, disableAutoFetch: true });

  try {
    const pdf = await loadingTask.promise;
    if (isCancelled()) return 0;

    const totalPages = pdf.numPages;
    const limit = Math.min(totalPages, MAX_RENDERED_PAGES);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable.");

    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      if (isCancelled()) return totalPages;
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
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          if (isCancelled()) return totalPages;

          const blob = await canvasToJpegBlob(canvas);
          if (isCancelled()) return totalPages;
          if (blob) {
            onPage({ url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height }, pageNumber - 1, totalPages);
          }
        } finally {
          page.cleanup();
        }
      } catch {
        /* skip this page, keep going */
      }
      await yieldToBrowser();
    }

    canvas.width = 0;
    canvas.height = 0;
    return totalPages;
  } finally {
    void loadingTask.destroy().catch(() => {});
  }
}
