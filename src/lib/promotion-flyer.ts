/**
 * Shared promotion / flyer model + on-brand HTML flyer renderer.
 *
 * Framework-agnostic (no `window`, no React) so it is importable from the client
 * store, the server generation route, and the flyer preview component. The flyer
 * is rendered as a self-contained HTML document (inlined CSS, Axis brand tokens)
 * so it can be shown in an isolated <iframe>, printed, or saved to PDF via the
 * browser with no image-generation API and no extra dependency.
 *
 * Layouts are template-driven: {@link PROMOTION_TEMPLATE_OPTIONS} lists the
 * available flyer formats (modeled on real rental-marketing flyers — photo hero,
 * split sidebar, amenity grid, bold banner, minimal) and {@link buildFlyerHtml}
 * renders the row's chosen template. Uploaded property photos are carried as
 * data URLs in `inputs.images` and embedded per template.
 */

import type { PromotionTextCopy, PromotionTextEntry } from "@/lib/promotion-text";
import {
  PROPLANE_MARK_PATHS,
  PROPLANE_MARK_STROKE_WIDTH,
  PROPLANE_MARK_VIEWBOX_SIZE,
} from "@/lib/brand/proplane-mark";

export type PromotionTheme = "cobalt" | "sunset" | "forest" | "slate";

export type PromotionStatus = "draft" | "generated";

/** Output format / canvas the flyer is rendered at. */
export type FlyerSize = "letter" | "a4" | "ig_post" | "ig_story";

/** Flyer layout template (visual format, independent of color theme). */
export type PromotionTemplate =
  | "showcase"
  | "listing_sheet"
  | "photo_hero"
  | "split"
  | "feature_grid"
  | "bold_banner"
  | "minimal";

/** Raw inputs the manager sets in the form (untrusted free text). */
export type PromotionInputs = {
  headline: string;
  /** Newline- or comma-separated key selling points / amenities. */
  sellingPoints: string;
  price: string;
  /** Promo offer, e.g. "First month free". */
  promo: string;
  /** Call to action, e.g. "Book a tour today". */
  cta: string;
  /** Contact line, e.g. "leasing@proplane.ai · (206) 555-0142". */
  contact: string;
  /** Copy tone, e.g. "Warm & welcoming". */
  tone: string;
  /** Street address, prefilled from the property record — shown as the listing-sheet headline. */
  address?: string;
  /**
   * Free-form custom property details typed on the "Custom" path (address,
   * features, neighborhood notes). Fed to the AI as additional facts to
   * advertise. Empty when a saved property was picked from the dropdown.
   */
  customDetails: string;
  /**
   * Uploaded property photos as downscaled `data:image/...` URLs (client-side
   * resized before storing). Max {@link FLYER_IMAGE_LIMIT}. Never sent to the
   * AI copy route — embedded straight into the flyer HTML per template.
   */
  images?: string[];
  /** Public tour/scheduling URL — embedded in flyer CTA and promotion text when set. */
  schedulingUrl?: string;
  /** When true, autofill and exports include the scheduling link. Defaults true when URL is set. */
  includeSchedulingLink?: boolean;
};

/** AI-composed (or fallback-composed) flyer copy. Facts stay from inputs. */
export type FlyerCopy = {
  headline: string;
  subheadline: string;
  sellingPoints: string[];
  promoLine: string;
  ctaText: string;
  closingLine: string;
};

export type ManagerPromotionRow = {
  id: string;
  managerUserId: string | null;
  propertyId: string | null;
  /** Denormalized property/listing label for the table + flyer. */
  propertyLabel: string;
  /** Short promotion title (table column). */
  title: string;
  theme: PromotionTheme;
  /** Output size / format the flyer is rendered at. Defaults to Letter. */
  flyerSize: FlyerSize;
  /** Layout template. Absent on rows saved before templates existed. */
  template?: PromotionTemplate;
  status: PromotionStatus;
  inputs: PromotionInputs;
  /** null until copy has been generated. */
  copy: FlyerCopy | null;
  /** Channel-specific marketing text (social, email, SMS). Legacy — prefer {@link textCopies}. */
  textCopy?: PromotionTextCopy | null;
  /** Multiple channel-specific marketing texts per promotion. */
  textCopies?: PromotionTextEntry[];
  /**
   * Multiple flyer variants per promotion. When absent, the legacy top-level
   * `copy`/`template`/`theme`/`flyerSize`/`inputs` describe the single flyer;
   * {@link readFlyerEntries} migrates that shape into one entry.
   */
  flyerCopies?: FlyerEntry[];
  /** Manager-uploaded promotion files (image or PDF), not AI-generated. */
  uploadCopies?: import("@/lib/promotion-upload").PromotionUploadEntry[];
  createdAt: string;
  updatedAt: string;
};

/** One flyer variant (design + copy) within a promotion. Multiple per promotion. */
export type FlyerEntry = {
  id: string;
  /** Label shown on the flyer's dropdown box. */
  title: string;
  copy: FlyerCopy;
  template: PromotionTemplate;
  theme: PromotionTheme;
  flyerSize: FlyerSize;
  inputs: PromotionInputs;
  createdAt: string;
  updatedAt: string;
};

export function makeFlyerEntryId(): string {
  return `flyer-${crypto.randomUUID()}`;
}

/** Default collapsible header label for the Nth flyer (1-based). */
export function defaultFlyerEntryTitle(sequenceNumber: number): string {
  return `Flyer ${sequenceNumber}`;
}

/** Prefer a manager-set title; otherwise numbered "Flyer N". */
export function flyerEntryDisplayTitle(entry: Pick<FlyerEntry, "title">, index: number): string {
  const trimmed = entry.title?.trim();
  return trimmed || defaultFlyerEntryTitle(index + 1);
}

export function createFlyerEntry(
  args: {
    title: string;
    copy: FlyerCopy;
    template: PromotionTemplate;
    theme: PromotionTheme;
    flyerSize: FlyerSize;
    inputs: PromotionInputs;
  },
  now = new Date().toISOString(),
): FlyerEntry {
  return { id: makeFlyerEntryId(), ...args, createdAt: now, updatedAt: now };
}

function isFlyerEntry(raw: unknown): raw is FlyerEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as FlyerEntry;
  return Boolean(e.id && e.copy && typeof e.copy.headline === "string");
}

/** Read flyer variants from a promotion row, migrating the legacy single `copy`. */
export function readFlyerEntries(row: ManagerPromotionRow): FlyerEntry[] {
  // Once `flyerCopies` exists — even as `[]` — the row is on the multi-flyer
  // model. Never fall back to legacy `copy` here or deleting the last variant
  // resurrects it on the next sync/render.
  if (Array.isArray(row.flyerCopies)) {
    return row.flyerCopies.filter(isFlyerEntry);
  }
  if (row.copy) {
    return [
      {
        // Deterministic id so migration is stable across renders (used as a React key).
        id: `${row.id}::flyer-0`,
        title: "",
        copy: row.copy,
        template: normalizePromotionTemplate(row.template),
        theme: row.theme,
        flyerSize: row.flyerSize,
        inputs: row.inputs,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    ];
  }
  return [];
}

/** Newest entry — kept in sync with the row's legacy top-level fields. */
export function primaryFlyerEntry(entries: FlyerEntry[]): FlyerEntry | null {
  return entries[0] ?? null;
}

/**
 * Build a render-ready row for a single flyer variant. {@link buildFlyerHtml},
 * {@link PromotionFlyerPreview}, and the download helper all take a full row, so
 * this projects a variant's fields onto the row without changing the renderer.
 */
export function flyerRowForEntry(row: ManagerPromotionRow, entry: FlyerEntry): ManagerPromotionRow {
  return {
    ...row,
    title: entry.title,
    copy: entry.copy,
    template: entry.template,
    theme: entry.theme,
    flyerSize: entry.flyerSize,
    inputs: entry.inputs,
  };
}

export const PROMOTION_THEME_OPTIONS: { id: PromotionTheme; label: string }[] = [
  { id: "cobalt", label: "PropLane Cobalt" },
  { id: "sunset", label: "Sunset" },
  { id: "forest", label: "Forest" },
  { id: "slate", label: "Slate" },
];

export const PROMOTION_TONE_OPTIONS = [
  "Warm & welcoming",
  "Modern & upscale",
  "Bold & energetic",
  "Calm & professional",
];

export const PROMOTION_SIZE_OPTIONS: { id: FlyerSize; label: string }[] = [
  { id: "letter", label: 'Letter — 8.5" × 11"' },
  { id: "a4", label: "A4 — 210 × 297 mm" },
  { id: "ig_post", label: "Instagram post — 1080 × 1080" },
  { id: "ig_story", label: "Instagram story — 1080 × 1920" },
];

export const PROMOTION_TEMPLATE_DEFAULT: PromotionTemplate = "showcase";

/**
 * Flyer layout templates, modeled on common professional rental-flyer formats:
 * a high-impact showcase with circular photo cutouts and dotted accents, a
 * clean single-listing sheet, large hero photo with overlaid headline, split
 * image+details sidebar, amenity checklist grid, bold FOR-RENT/price banner,
 * and a minimal typography-led layout.
 */
export const PROMOTION_TEMPLATE_OPTIONS: {
  id: PromotionTemplate;
  label: string;
  description: string;
}[] = [
  {
    id: "showcase",
    label: "Showcase",
    description: "Circular hero photo, dotted accents and a bold price badge — high-impact marketing style.",
  },
  {
    id: "listing_sheet",
    label: "Listing Sheet",
    description: "Clean professional listing sheet — bold address headline, price sidebar and photo strip.",
  },
  {
    id: "photo_hero",
    label: "Photo Hero",
    description: "Big photo up top with the headline overlaid — the classic listing flyer.",
  },
  {
    id: "split",
    label: "Split Panel",
    description: "Color sidebar with photo, price and contact next to the details.",
  },
  {
    id: "feature_grid",
    label: "Feature Grid",
    description: "Photo band plus an amenity checklist grid — detail-forward.",
  },
  {
    id: "bold_banner",
    label: "Bold Banner",
    description: "FOR RENT banner and an oversized price callout — high impact.",
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Elegant, type-led layout with generous whitespace.",
  },
];

/** Max property photos stored on a promotion (kept small — data URLs live in the row). */
export const FLYER_IMAGE_LIMIT = 3;

/** Coerce any stored/client value to a known template id (old rows have none). */
export function normalizePromotionTemplate(value: unknown): PromotionTemplate {
  return PROMOTION_TEMPLATE_OPTIONS.some((t) => t.id === value)
    ? (value as PromotionTemplate)
    : PROMOTION_TEMPLATE_DEFAULT;
}

/** Public `listing-photos` objects managers upload for listings — safe to embed in flyer HTML. */
const LISTING_PHOTO_PUBLIC_MARKER = "/storage/v1/object/public/listing-photos/";

/** Base64 uploads from the promotion form, or durable listing gallery URLs. */
export function isEmbeddableFlyerImageUrl(src: string): boolean {
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(src)) return true;
  const trimmed = src.trim();
  return trimmed.startsWith("https://") && trimmed.includes(LISTING_PHOTO_PUBLIC_MARKER);
}

/**
 * Keep only safe, embeddable images: base64 `data:image/*` URLs and public
 * `listing-photos` gallery URLs (the property's main listing photos). No other
 * remote URLs and no SVG — they can carry script. Capped at {@link FLYER_IMAGE_LIMIT}.
 */
export function sanitizeFlyerImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((src): src is string => typeof src === "string" && isEmbeddableFlyerImageUrl(src))
    .slice(0, FLYER_IMAGE_LIMIT);
}

/** CSS canvas spec per flyer size, used by {@link buildFlyerHtml}. */
type SizeSpec = {
  width: string;
  minHeight: string;
  page: string;
  heroPad: string;
  bodyPad: string;
  /** Horizontal page padding (used for edge-to-edge bands/footers). */
  padX: string;
  /** Font/spacing multiplier — Instagram canvases are px-larger than print. */
  scale: number;
};

const SIZE_SPECS: Record<FlyerSize, SizeSpec> = {
  letter: { width: "8.5in", minHeight: "11in", page: "letter portrait", heroPad: "0.85in 0.8in 0.7in", bodyPad: "0.6in 0.8in 0.5in", padX: "0.8in", scale: 1 },
  a4: { width: "210mm", minHeight: "297mm", page: "A4 portrait", heroPad: "22mm 20mm 18mm", bodyPad: "16mm 20mm 14mm", padX: "20mm", scale: 1 },
  ig_post: { width: "1080px", minHeight: "1080px", page: "1080px 1080px", heroPad: "72px 72px 56px", bodyPad: "48px 72px 40px", padX: "72px", scale: 1.3 },
  ig_story: { width: "1080px", minHeight: "1920px", page: "1080px 1920px", heroPad: "120px 80px 72px", bodyPad: "64px 80px 56px", padX: "80px", scale: 1.42 },
};

export function sizeSpecFor(size: FlyerSize | undefined): SizeSpec {
  return SIZE_SPECS[size ?? "letter"] ?? SIZE_SPECS.letter;
}

type ThemePalette = { from: string; to: string; accent: string; ink: string };

const THEME_PALETTES: Record<PromotionTheme, ThemePalette> = {
  // Axis brand gradient (globals.css --btn-primary).
  cobalt: { from: "#2f6bff", to: "#5a8cff", accent: "#1e4fd6", ink: "#0b1b3a" },
  sunset: { from: "#ff7a45", to: "#ff4d6d", accent: "#d6303f", ink: "#3a0b16" },
  forest: { from: "#0e7c66", to: "#16a34a", accent: "#0b5d4a", ink: "#052117" },
  slate: { from: "#0b1b3a", to: "#334155", accent: "#1e293b", ink: "#0b1b3a" },
};

export function paletteForTheme(theme: PromotionTheme): ThemePalette {
  return THEME_PALETTES[theme] ?? THEME_PALETTES.cobalt;
}

/** Split the raw selling-points textarea into clean bullet strings. */
export function parseSellingPoints(raw: string): string[] {
  return raw
    .split(/\r?\n|·|•|;|,/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
}

/**
 * Deterministic fallback copy composer used when the AI route is unavailable
 * (demo sandbox, offline, or missing ANTHROPIC_API_KEY). Never invents facts —
 * it only reshapes the manager-provided inputs into flyer-ready copy.
 */
export function composeFallbackFlyerCopy(inputs: PromotionInputs, propertyLabel: string): FlyerCopy {
  // Selling points fall back to the custom-details text when no explicit list
  // was given, so the "Custom (type below)" path still yields flyer bullets.
  const points = parseSellingPoints(
    inputs.sellingPoints.trim() ? inputs.sellingPoints : inputs.customDetails,
  );
  const headline = inputs.headline.trim() || (propertyLabel ? `Now Leasing — ${propertyLabel}` : "Now Leasing");
  const subParts: string[] = [];
  if (propertyLabel) subParts.push(propertyLabel);
  if (inputs.price.trim()) subParts.push(inputs.price.trim());
  const subheadline = subParts.join(" · ") || "Your next home is ready";
  const promoLine = inputs.promo.trim();
  const ctaText = inputs.cta.trim() || "Schedule a tour today";
  const closingLine = inputs.contact.trim()
    ? `Contact us: ${inputs.contact.trim()}`
    : "Contact the leasing team to learn more.";
  return {
    headline,
    subheadline,
    sellingPoints: points.length ? points : ["Freshly maintained and move-in ready", "Great location", "Responsive management"],
    promoLine,
    ctaText,
    closingLine,
  };
}

/** Map AI flyer copy back into editable draft fields. */
export function applyFlyerCopyToDraftFields<T extends {
  headline: string;
  sellingPoints: string;
  promo: string;
  cta: string;
  contact: string;
}>(draft: T, copy: FlyerCopy): T {
  const contactFromClosing = copy.closingLine.replace(/^Contact us:\s*/i, "").trim();
  return {
    ...draft,
    headline: copy.headline.trim() || draft.headline,
    sellingPoints: copy.sellingPoints.length ? copy.sellingPoints.join("\n") : draft.sellingPoints,
    promo: copy.promoLine.trim() || draft.promo,
    cta: copy.ctaText.trim() || draft.cta,
    contact: contactFromClosing || draft.contact,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Everything a template renderer needs, pre-escaped and size-scaled. */
type FlyerRenderContext = {
  p: ThemePalette;
  s: SizeSpec;
  /** Scale a base px value for the current canvas size. */
  fs: (n: number) => string;
  images: string[];
  eyebrow: string;
  headline: string;
  sub: string;
  promo: string;
  price: string;
  cta: string;
  closing: string;
  points: string[];
  address: string;
  schedulingUrl: string;
};

function ctaBlockHtml(ctx: FlyerRenderContext, className = "cta-text"): string {
  if (ctx.schedulingUrl) {
    return `<a class="${className} cta-link" href="${escapeHtml(ctx.schedulingUrl)}" target="_blank" rel="noopener noreferrer">${ctx.cta}</a>`;
  }
  return `<div class="${className}">${ctx.cta}</div>`;
}

type TemplateRender = { css: string; body: string };

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SERIF_STACK = 'Georgia, "Times New Roman", "Iowan Old Style", serif';
const MUTED = "#64748b";

/** Inline PropLane mark — canonical geometry ({@link PROPLANE_MARK_PATHS}), redrawn as a static SVG string for standalone flyer HTML (no React/Tailwind available there). */
function axisMarkSvg(color: string): string {
  const paths = PROPLANE_MARK_PATHS.map(
    (d) => `<path d="${d}" stroke="${color}" stroke-width="${PROPLANE_MARK_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`,
  ).join("\n    ");
  return `<svg viewBox="0 0 ${PROPLANE_MARK_VIEWBOX_SIZE} ${PROPLANE_MARK_VIEWBOX_SIZE}" width="13" height="13" fill="none" aria-hidden="true">
    ${paths}
  </svg>`;
}

/** Axis brand mark + wordmark, inlined for the flyer footer/header. */
function axisBrandHtml(color: string): string {
  return `<span class="brand-mark">${axisMarkSvg(color)}<span>PropLane</span></span>`;
}

function footerHtml(ctx: FlyerRenderContext): string {
  return `<div class="footer"><span>Marketing flyer</span><span>Powered by ${axisBrandHtml(ctx.p.accent)}</span></div>`;
}

function footerCss(ctx: FlyerRenderContext): string {
  return `
  .footer {
    padding: ${ctx.fs(14)} ${ctx.s.padX}; border-top: 1px solid #e2e8f5; display: flex; justify-content: space-between;
    align-items: center; font-size: ${ctx.fs(12)}; color: ${MUTED};
  }
  .brand-mark { display: inline-flex; align-items: center; gap: ${ctx.fs(5)}; font-weight: 800; color: ${ctx.p.accent}; }
  .brand-mark svg { display: block; }`;
}

function imgTag(src: string, className: string): string {
  return `<img class="${className}" src="${escapeHtml(src)}" alt="" />`;
}

/** Small decorative dot-grid accent (nod to the corpus flyers' dotted geometric motifs). Purely visual. */
function dotsHtml(className: string): string {
  return `<div class="${className}" aria-hidden="true"></div>`;
}

/* ------------------------------------------------------------------ */
/* Template: Showcase — bold headline beside a circular hero cutout,   */
/* small circular interior thumbnails, a colored features card, a big  */
/* price line and dotted geometric accents. Modeled on the corpus's    */
/* highest-impact marketing flyers (circular photo cutouts, dot grids, */
/* colored ticklist cards).                                            */
/* ------------------------------------------------------------------ */
function renderShowcase(ctx: FlyerRenderContext): TemplateRender {
  const { p, fs, images } = ctx;
  const hero = images[0];
  const thumbs = images.slice(1, 4);
  const css = `
  .sheet { position: relative; }
  .dot-grid {
    position: absolute; width: ${fs(88)}; height: ${fs(52)}; top: ${fs(18)}; right: ${fs(18)};
    background-image: radial-gradient(${p.accent} 1.6px, transparent 1.6px); background-size: ${fs(11)} ${fs(11)};
    opacity: 0.28; pointer-events: none;
  }
  .dot-grid.corner { top: auto; right: auto; bottom: ${fs(96)}; left: 0; }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: ${fs(18)}; padding: ${fs(34)} ${ctx.s.padX} 0; }
  .headline-col { flex: 1.15; min-width: 0; }
  .eyebrow { display: inline-block; padding: ${fs(6)} ${fs(14)}; border-radius: 999px; background: ${p.accent}1a; color: ${p.accent}; font-size: ${fs(12)}; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
  .headline { margin: ${fs(14)} 0 0; font-size: ${fs(38)}; line-height: 1.04; font-weight: 900; letter-spacing: -0.02em; color: ${p.ink}; text-transform: uppercase; }
  .subheadline { margin: ${fs(10)} 0 0; font-family: ${SERIF_STACK}; font-style: italic; font-size: ${fs(22)}; font-weight: 600; color: ${p.accent}; }
  .hero-wrap { position: relative; flex: 0 0 auto; width: ${fs(150)}; }
  .hero-circle {
    width: ${fs(150)}; height: ${fs(150)}; border-radius: 50%; object-fit: cover; border: ${fs(5)} solid #ffffff;
    box-shadow: 0 ${fs(10)} ${fs(24)} rgba(15,23,42,0.16);
  }
  .hero-circle.empty { background: linear-gradient(135deg, ${p.from}, ${p.to}); }
  .thumbs { display: flex; gap: ${fs(12)}; justify-content: center; padding: ${fs(20)} ${ctx.s.padX} 0; }
  .thumbs img { width: ${fs(64)}; height: ${fs(64)}; border-radius: 50%; object-fit: cover; border: ${fs(3)} solid #ffffff; box-shadow: 0 ${fs(4)} ${fs(10)} rgba(15,23,42,0.14); }
  .body { position: relative; padding: ${fs(28)} ${ctx.s.padX} ${fs(24)}; display: flex; flex-direction: column; gap: ${fs(18)}; flex: 1; }
  .card { background: ${p.accent}; color: #ffffff; border-radius: ${fs(16)}; padding: ${fs(18)} ${fs(20)}; }
  .card-title { font-size: ${fs(13)}; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.85; }
  .points { list-style: none; margin: ${fs(10)} 0 0; padding: 0; display: grid; gap: ${fs(9)}; }
  .points li { display: flex; align-items: flex-start; gap: ${fs(9)}; font-size: ${fs(15)}; font-weight: 600; line-height: 1.3; }
  .points li::before { content: "✓"; font-weight: 900; flex: 0 0 auto; }
  .price-row { display: flex; align-items: baseline; justify-content: space-between; gap: ${fs(12)}; flex-wrap: wrap; }
  .price-label { font-size: ${fs(12)}; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: ${MUTED}; }
  .price-value { font-size: ${fs(34)}; font-weight: 900; color: ${p.accent}; letter-spacing: -0.01em; }
  .promo-chip { align-self: flex-start; padding: ${fs(7)} ${fs(14)}; border-radius: 999px; border: 1.5px solid ${p.accent}; color: ${p.accent}; font-size: ${fs(13)}; font-weight: 800; }
  .cta {
    margin-top: auto; padding: ${fs(20)} ${fs(24)}; border-radius: ${fs(18)}; background: ${p.ink}; color: #ffffff;
    display: flex; flex-direction: column; gap: ${fs(6)};
  }
  .cta-text { font-size: ${fs(22)}; font-weight: 800; letter-spacing: -0.01em; }
  .cta-closing { font-size: ${fs(14)}; font-weight: 500; opacity: 0.9; }
  ${footerCss(ctx)}`;
  const body = `
  <div class="sheet">
    ${dotsHtml("dot-grid")}
    ${dotsHtml("dot-grid corner")}
    <div class="top">
      <div class="headline-col">
        <span class="eyebrow">${ctx.eyebrow}</span>
        <h1 class="headline">${ctx.headline}</h1>
        <p class="subheadline">${ctx.sub}</p>
      </div>
      <div class="hero-wrap">${hero ? imgTag(hero, "hero-circle") : '<div class="hero-circle empty"></div>'}</div>
    </div>
    ${thumbs.length ? `<div class="thumbs">${thumbs.map((src) => imgTag(src, "")).join("")}</div>` : ""}
    <div class="body">
      <div class="card">
        <div class="card-title">Features</div>
        <ul class="points">${ctx.points.map((pt) => `<li>${pt}</li>`).join("")}</ul>
      </div>
      ${
        ctx.price || ctx.promo
          ? `<div class="price-row">${ctx.price ? `<div><div class="price-label">Price</div><div class="price-value">${ctx.price}</div></div>` : ""}${ctx.promo ? `<div class="promo-chip">${ctx.promo}</div>` : ""}</div>`
          : ""
      }
      <div class="cta">${ctaBlockHtml(ctx)}<div class="cta-closing">${ctx.closing}</div></div>
    </div>
    ${footerHtml(ctx)}
  </div>`;
  return { css, body };
}

/* ------------------------------------------------------------------ */
/* Template: Listing Sheet — clean, white, professional single-listing */
/* sheet: bold address headline, hero photo + thumbnail strip on the   */
/* left, price/description/features sidebar on the right, and an      */
/* agent-style contact + brand footer. Modeled on minimal real-estate  */
/* listing-sheet flyers.                                               */
/* ------------------------------------------------------------------ */
function renderListingSheet(ctx: FlyerRenderContext): TemplateRender {
  const { p, fs, images } = ctx;
  const hero = images[0];
  const thumbs = images.slice(1, 4);
  const css = `
  .head { padding: ${fs(30)} ${ctx.s.padX} ${fs(6)}; text-align: center; }
  .headline { margin: 0; font-size: ${fs(30)}; font-weight: 800; letter-spacing: -0.01em; color: ${p.ink}; }
  .subheadline { margin: ${fs(6)} 0 0; font-size: ${fs(15)}; font-weight: 500; color: ${MUTED}; }
  .cols { display: flex; gap: ${fs(20)}; padding: ${fs(20)} ${ctx.s.padX} 0; flex: 1; min-height: 0; }
  .left { flex: 1.4; min-width: 0; display: flex; flex-direction: column; gap: ${fs(8)}; }
  .hero-photo { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: ${fs(6)}; }
  .hero-photo.empty { background: linear-gradient(135deg, ${p.from}, ${p.to}); }
  .thumb-strip { display: flex; gap: ${fs(6)}; }
  .thumb-strip img { flex: 1; min-width: 0; aspect-ratio: 1 / 1; object-fit: cover; border-radius: ${fs(4)}; }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: ${fs(14)}; }
  .price-label { font-size: ${fs(11)}; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: ${MUTED}; }
  .price-value { margin-top: ${fs(4)}; font-size: ${fs(30)}; font-weight: 800; color: ${p.ink}; letter-spacing: -0.01em; }
  .promo-line { font-size: ${fs(14)}; font-weight: 700; color: ${p.accent}; }
  .desc { font-size: ${fs(13)}; line-height: 1.5; color: ${MUTED}; }
  .points { list-style: none; margin: 0; padding: 0; display: grid; gap: ${fs(8)}; }
  .points li { position: relative; padding-left: ${fs(14)}; font-size: ${fs(13)}; line-height: 1.4; color: ${p.ink}; }
  .points li::before { content: "•"; position: absolute; left: 0; color: ${p.accent}; font-weight: 900; }
  .foot {
    margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: ${fs(14)};
    padding: ${fs(20)} ${ctx.s.padX}; border-top: 1px solid #e2e8f5; flex-wrap: wrap;
  }
  .foot-contact { font-size: ${fs(13)}; font-weight: 700; color: ${p.ink}; }
  .foot-cta { margin-top: ${fs(2)}; font-size: ${fs(12)}; font-weight: 500; color: ${MUTED}; }
  .foot-brand { display: inline-flex; align-items: center; gap: ${fs(6)}; font-weight: 800; font-size: ${fs(15)}; color: ${p.accent}; }
  .foot-brand svg { display: block; }`;
  const body = `
  <div class="sheet">
    <div class="head">
      <h1 class="headline">${ctx.address || ctx.headline}</h1>
      <p class="subheadline">${ctx.eyebrow}</p>
    </div>
    <div class="cols">
      <div class="left">
        ${hero ? imgTag(hero, "hero-photo") : '<div class="hero-photo empty"></div>'}
        ${thumbs.length ? `<div class="thumb-strip">${thumbs.map((src) => imgTag(src, "")).join("")}</div>` : ""}
      </div>
      <div class="right">
        ${ctx.price ? `<div><div class="price-label">Offered for</div><div class="price-value">${ctx.price}</div></div>` : ""}
        ${ctx.promo ? `<div class="promo-line">${ctx.promo}</div>` : ""}
        <p class="desc">${ctx.sub}</p>
        <ul class="points">${ctx.points.map((pt) => `<li>${pt}</li>`).join("")}</ul>
      </div>
    </div>
    <div class="foot">
      <div><div class="foot-contact">${ctx.cta}</div><div class="foot-cta">${ctx.closing}</div></div>
      <span class="foot-brand">${axisMarkSvg(p.accent)}<span>PropLane</span></span>
    </div>
  </div>`;
  return { css, body };
}

/* ------------------------------------------------------------------ */
/* Template: Photo Hero — big photo (or brand gradient) with overlaid  */
/* headline; selling points, price and CTA card below.                 */
/* ------------------------------------------------------------------ */
function renderPhotoHero(ctx: FlyerRenderContext): TemplateRender {
  const { p, s, fs, images } = ctx;
  const hero = images[0];
  const extras = images.slice(1);
  const css = `
  .hero { position: relative; color: #ffffff; background: linear-gradient(135deg, ${p.from}, ${p.to}); overflow: hidden; }
  .hero.has-photo { height: calc(${s.minHeight} * 0.44); }
  .hero-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .hero-scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(9,14,26,0.08) 32%, rgba(9,14,26,0.82) 100%); }
  .hero-content { position: relative; padding: ${s.heroPad}; display: flex; flex-direction: column; }
  .hero.has-photo .hero-content { height: 100%; justify-content: flex-end; }
  .eyebrow { font-size: ${fs(13)}; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; opacity: 0.92; }
  .headline { margin: ${fs(14)} 0 0; font-size: ${fs(48)}; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em; }
  .subheadline { margin: ${fs(14)} 0 0; font-size: ${fs(20)}; font-weight: 500; opacity: 0.95; }
  .promo {
    display: inline-block; align-self: flex-start; margin-top: ${fs(20)}; padding: ${fs(10)} ${fs(18)}; border-radius: 999px;
    background: rgba(255,255,255,0.18); border: 1.5px solid rgba(255,255,255,0.55);
    font-size: ${fs(16)}; font-weight: 700; letter-spacing: 0.01em; backdrop-filter: blur(2px);
  }
  .gallery { display: flex; gap: ${fs(10)}; padding: ${fs(14)} ${s.padX} 0; }
  .gallery img { flex: 1; min-width: 0; height: calc(${s.minHeight} * 0.11); object-fit: cover; border-radius: ${fs(12)}; }
  .body { padding: ${s.bodyPad}; display: flex; flex-direction: column; gap: ${fs(24)}; flex: 1; }
  .points { list-style: none; margin: 0; padding: 0; display: grid; gap: ${fs(13)}; }
  .points li { display: flex; align-items: flex-start; gap: ${fs(12)}; font-size: ${fs(18)}; font-weight: 500; line-height: 1.35; }
  .dot { margin-top: ${fs(8)}; width: ${fs(9)}; height: ${fs(9)}; border-radius: 999px; background: ${p.accent}; flex: 0 0 auto; }
  .price { font-size: ${fs(30)}; font-weight: 800; color: ${p.accent}; letter-spacing: -0.01em; }
  .cta {
    margin-top: auto; padding: ${fs(20)} ${fs(26)}; border-radius: ${fs(18)}; background: ${p.ink};
    color: #ffffff; display: flex; flex-direction: column; gap: ${fs(6)};
  }
  .cta-text { font-size: ${fs(24)}; font-weight: 800; letter-spacing: -0.01em; }
  .cta-closing { font-size: ${fs(15)}; font-weight: 500; opacity: 0.9; }
  ${footerCss(ctx)}`;
  const body = `
  <div class="sheet">
    <div class="hero${hero ? " has-photo" : ""}">
      ${hero ? imgTag(hero, "hero-img") + '<div class="hero-scrim"></div>' : ""}
      <div class="hero-content">
        <div class="eyebrow">${ctx.eyebrow}</div>
        <h1 class="headline">${ctx.headline}</h1>
        <p class="subheadline">${ctx.sub}</p>
        ${ctx.promo ? `<div class="promo">${ctx.promo}</div>` : ""}
      </div>
    </div>
    ${extras.length ? `<div class="gallery">${extras.map((src) => imgTag(src, "")).join("")}</div>` : ""}
    <div class="body">
      <ul class="points">${ctx.points.map((pt) => `<li><span class="dot" aria-hidden="true"></span><span>${pt}</span></li>`).join("")}</ul>
      ${ctx.price ? `<div class="price">${ctx.price}</div>` : ""}
      <div class="cta">
        ${ctaBlockHtml(ctx)}
        <div class="cta-closing">${ctx.closing}</div>
      </div>
    </div>
    ${footerHtml(ctx)}
  </div>`;
  return { css, body };
}

/* ------------------------------------------------------------------ */
/* Template: Split Panel — gradient sidebar (photo, price, contact)    */
/* beside the headline + amenity checklist.                            */
/* ------------------------------------------------------------------ */
function renderSplit(ctx: FlyerRenderContext): TemplateRender {
  const { p, fs, images } = ctx;
  const photo = images[0];
  const thumbs = images.slice(1);
  const css = `
  .cols { display: flex; flex: 1; min-height: 0; }
  .side {
    width: 39%; background: linear-gradient(165deg, ${p.from}, ${p.to}); color: #ffffff;
    padding: ${fs(30)} ${fs(26)}; display: flex; flex-direction: column; gap: ${fs(18)};
  }
  .side-eyebrow { font-size: ${fs(12)}; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0.92; }
  .photo { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: ${fs(14)}; border: ${fs(3)} solid rgba(255,255,255,0.4); }
  .thumbs { display: flex; gap: ${fs(8)}; }
  .thumbs img { flex: 1; min-width: 0; aspect-ratio: 1 / 1; object-fit: cover; border-radius: ${fs(10)}; border: ${fs(2)} solid rgba(255,255,255,0.3); }
  .side-promo {
    align-self: flex-start; padding: ${fs(8)} ${fs(14)}; border-radius: 999px; border: 1.5px solid rgba(255,255,255,0.6);
    background: rgba(255,255,255,0.16); font-size: ${fs(13)}; font-weight: 700;
  }
  .price-block { margin-top: auto; padding-top: ${fs(14)}; border-top: 1px solid rgba(255,255,255,0.35); }
  .price-label { font-size: ${fs(11)}; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.85; }
  .price-value { margin-top: ${fs(4)}; font-size: ${fs(32)}; font-weight: 800; letter-spacing: -0.01em; }
  .side-contact { font-size: ${fs(13)}; font-weight: 500; opacity: 0.92; line-height: 1.45; }
  .main { flex: 1; padding: ${fs(36)} ${fs(32)}; display: flex; flex-direction: column; gap: ${fs(20)}; }
  .headline { margin: 0; font-size: ${fs(40)}; line-height: 1.08; font-weight: 800; letter-spacing: -0.02em; color: ${p.ink}; }
  .subheadline { margin: 0; font-size: ${fs(18)}; font-weight: 500; color: ${MUTED}; }
  .rule { width: ${fs(52)}; height: ${fs(4)}; border-radius: 999px; background: ${p.accent}; }
  .points { list-style: none; margin: ${fs(4)} 0 0; padding: 0; display: grid; gap: ${fs(14)}; }
  .points li { display: flex; align-items: flex-start; gap: ${fs(12)}; font-size: ${fs(17)}; font-weight: 500; line-height: 1.35; }
  .check {
    flex: 0 0 auto; width: ${fs(22)}; height: ${fs(22)}; border-radius: 999px; background: ${p.accent}; color: #fff;
    display: flex; align-items: center; justify-content: center; font-size: ${fs(13)}; font-weight: 800;
  }
  .cta {
    margin-top: auto; padding: ${fs(20)} ${fs(24)}; border-radius: ${fs(16)}; background: ${p.ink}; color: #ffffff;
    display: flex; flex-direction: column; gap: ${fs(6)};
  }
  .cta-text { font-size: ${fs(22)}; font-weight: 800; letter-spacing: -0.01em; }
  .cta-closing { font-size: ${fs(14)}; font-weight: 500; opacity: 0.9; }
  ${footerCss(ctx)}`;
  const body = `
  <div class="sheet">
    <div class="cols">
      <aside class="side">
        <div class="side-eyebrow">${ctx.eyebrow}</div>
        ${photo ? imgTag(photo, "photo") : ""}
        ${thumbs.length ? `<div class="thumbs">${thumbs.map((src) => imgTag(src, "")).join("")}</div>` : ""}
        ${ctx.promo ? `<div class="side-promo">${ctx.promo}</div>` : ""}
        <div class="price-block">
          ${ctx.price ? `<div class="price-label">Monthly rent</div><div class="price-value">${ctx.price}</div>` : ""}
          <div class="side-contact" style="margin-top:${fs(10)}">${ctx.closing}</div>
        </div>
      </aside>
      <main class="main">
        <h1 class="headline">${ctx.headline}</h1>
        <p class="subheadline">${ctx.sub}</p>
        <div class="rule"></div>
        <ul class="points">${ctx.points.map((pt) => `<li><span class="check" aria-hidden="true">✓</span><span>${pt}</span></li>`).join("")}</ul>
        <div class="cta">${ctaBlockHtml(ctx)}<div class="cta-closing">${ctx.closing}</div></div>
      </main>
    </div>
    ${footerHtml(ctx)}
  </div>`;
  return { css, body };
}

/* ------------------------------------------------------------------ */
/* Template: Feature Grid — leasing ribbon, photo band, amenity        */
/* checklist cards, dashed price callout, CTA bar.                     */
/* ------------------------------------------------------------------ */
function renderFeatureGrid(ctx: FlyerRenderContext): TemplateRender {
  const { p, s, fs, images } = ctx;
  const css = `
  .ribbon {
    background: ${p.ink}; color: #ffffff; padding: ${fs(10)} ${s.padX}; display: flex; justify-content: space-between;
    align-items: center; font-size: ${fs(12)}; font-weight: 800; letter-spacing: 0.18em; text-transform: uppercase;
  }
  .head { padding: ${fs(26)} ${s.padX} ${fs(20)}; }
  .headline { margin: 0; font-size: ${fs(40)}; line-height: 1.08; font-weight: 800; letter-spacing: -0.02em; color: ${p.ink}; }
  .subheadline { margin: ${fs(10)} 0 0; font-size: ${fs(18)}; font-weight: 500; color: ${MUTED}; }
  .band { display: flex; gap: ${fs(4)}; height: calc(${s.minHeight} * 0.26); background: linear-gradient(135deg, ${p.from}, ${p.to}); }
  .band img { flex: 1; min-width: 0; height: 100%; object-fit: cover; }
  .band-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #ffffff; font-size: ${fs(24)}; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
  .body { padding: ${s.bodyPad}; display: flex; flex-direction: column; gap: ${fs(20)}; flex: 1; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: ${fs(12)}; }
  .card {
    display: flex; align-items: flex-start; gap: ${fs(10)}; background: #f5f7fc; border: 1px solid #e3eafc;
    border-radius: ${fs(12)}; padding: ${fs(12)} ${fs(14)}; font-size: ${fs(15)}; font-weight: 600; line-height: 1.35; color: ${p.ink};
  }
  .check {
    flex: 0 0 auto; margin-top: ${fs(1)}; width: ${fs(20)}; height: ${fs(20)}; border-radius: 999px; background: ${p.accent};
    color: #fff; display: flex; align-items: center; justify-content: center; font-size: ${fs(12)}; font-weight: 800;
  }
  .callout {
    display: flex; align-items: center; justify-content: space-between; gap: ${fs(14)}; flex-wrap: wrap;
    border: ${fs(2)} dashed ${p.accent}; border-radius: ${fs(14)}; padding: ${fs(14)} ${fs(18)};
  }
  .callout-price { font-size: ${fs(32)}; font-weight: 800; color: ${p.accent}; letter-spacing: -0.01em; }
  .callout-promo { font-size: ${fs(16)}; font-weight: 700; color: ${p.ink}; }
  .cta {
    margin-top: auto; padding: ${fs(20)} ${fs(24)}; border-radius: ${fs(16)}; background: ${p.ink}; color: #ffffff;
    display: flex; align-items: center; justify-content: space-between; gap: ${fs(14)}; flex-wrap: wrap;
  }
  .cta-text { font-size: ${fs(22)}; font-weight: 800; letter-spacing: -0.01em; }
  .cta-closing { font-size: ${fs(14)}; font-weight: 500; opacity: 0.9; }
  ${footerCss(ctx)}`;
  const band = images.length
    ? images.map((src) => imgTag(src, "")).join("")
    : `<div class="band-empty">${ctx.promo || "Now Leasing"}</div>`;
  const body = `
  <div class="sheet">
    <div class="ribbon"><span>Now Leasing</span><span>${ctx.eyebrow}</span></div>
    <div class="head">
      <h1 class="headline">${ctx.headline}</h1>
      <p class="subheadline">${ctx.sub}</p>
    </div>
    <div class="band">${band}</div>
    <div class="body">
      <div class="grid">${ctx.points.map((pt) => `<div class="card"><span class="check" aria-hidden="true">✓</span><span>${pt}</span></div>`).join("")}</div>
      ${
        ctx.price || ctx.promo
          ? `<div class="callout">${ctx.price ? `<div class="callout-price">${ctx.price}</div>` : ""}${ctx.promo ? `<div class="callout-promo">${ctx.promo}</div>` : ""}</div>`
          : ""
      }
      <div class="cta">${ctaBlockHtml(ctx)}<div class="cta-closing">${ctx.closing}</div></div>
    </div>
    ${footerHtml(ctx)}
  </div>`;
  return { css, body };
}

/* ------------------------------------------------------------------ */
/* Template: Bold Banner — high-contrast FOR RENT masthead, oversized  */
/* price band, photo strip, punchy CTA bar.                            */
/* ------------------------------------------------------------------ */
function renderBoldBanner(ctx: FlyerRenderContext): TemplateRender {
  const { p, s, fs, images } = ctx;
  const css = `
  .banner { background: ${p.ink}; color: #ffffff; padding: ${fs(30)} ${s.padX} ${fs(26)}; }
  .tag {
    display: inline-block; background: #ffffff; color: ${p.ink}; font-weight: 900; letter-spacing: 0.26em;
    text-transform: uppercase; padding: ${fs(8)} ${fs(16)}; font-size: ${fs(14)}; border-radius: ${fs(4)};
  }
  .headline { margin: ${fs(16)} 0 0; font-size: ${fs(52)}; line-height: 1.02; font-weight: 900; letter-spacing: -0.015em; text-transform: uppercase; }
  .subheadline { margin: ${fs(12)} 0 0; font-size: ${fs(19)}; font-weight: 600; opacity: 0.92; }
  .strip { display: flex; gap: ${fs(4)}; }
  .strip img { flex: 1; min-width: 0; height: calc(${s.minHeight} * 0.24); object-fit: cover; }
  .price-band {
    background: linear-gradient(90deg, ${p.from}, ${p.to}); color: #ffffff; padding: ${fs(18)} ${s.padX};
    display: flex; align-items: center; justify-content: space-between; gap: ${fs(14)}; flex-wrap: wrap;
  }
  .big-price { font-size: ${fs(42)}; font-weight: 900; letter-spacing: -0.01em; }
  .promo-chip { border: ${fs(2)} solid #ffffff; border-radius: 999px; padding: ${fs(8)} ${fs(16)}; font-size: ${fs(15)}; font-weight: 800; }
  .body { padding: ${s.bodyPad}; flex: 1; display: flex; flex-direction: column; gap: ${fs(20)}; }
  .points { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: ${fs(14)} ${fs(24)}; }
  .points li { display: flex; align-items: flex-start; gap: ${fs(10)}; font-size: ${fs(17)}; font-weight: 700; line-height: 1.3; color: ${p.ink}; }
  .arrow { color: ${p.accent}; font-weight: 900; flex: 0 0 auto; }
  .cta-bar { margin-top: auto; background: ${p.accent}; color: #ffffff; text-align: center; padding: ${fs(20)} ${s.padX}; }
  .cta-text { font-size: ${fs(26)}; font-weight: 900; letter-spacing: 0.02em; text-transform: uppercase; }
  .cta-closing { margin-top: ${fs(6)}; font-size: ${fs(14)}; font-weight: 600; opacity: 0.92; }
  ${footerCss(ctx)}`;
  const body = `
  <div class="sheet">
    <div class="banner">
      <span class="tag">For Rent</span>
      <h1 class="headline">${ctx.headline}</h1>
      <p class="subheadline">${[ctx.eyebrow, ctx.sub].filter(Boolean).join(" — ")}</p>
    </div>
    ${images.length ? `<div class="strip">${images.map((src) => imgTag(src, "")).join("")}</div>` : ""}
    ${
      ctx.price || ctx.promo
        ? `<div class="price-band">${ctx.price ? `<div class="big-price">${ctx.price}</div>` : ""}${ctx.promo ? `<div class="promo-chip">${ctx.promo}</div>` : ""}</div>`
        : ""
    }
    <div class="body">
      <ul class="points">${ctx.points.map((pt) => `<li><span class="arrow" aria-hidden="true">▸</span><span>${pt}</span></li>`).join("")}</ul>
      <div class="cta-bar" style="margin-left:calc(-1 * ${s.padX}); margin-right:calc(-1 * ${s.padX});">
        ${ctaBlockHtml(ctx)}
        <div class="cta-closing">${ctx.closing}</div>
      </div>
    </div>
    ${footerHtml(ctx)}
  </div>`;
  return { css, body };
}

/* ------------------------------------------------------------------ */
/* Template: Minimal — centered, serif, whitespace-led with a framed   */
/* photo and hairline-separated details.                               */
/* ------------------------------------------------------------------ */
function renderMinimal(ctx: FlyerRenderContext): TemplateRender {
  const { p, s, fs, images } = ctx;
  const photo = images[0];
  const css = `
  .sheet { padding: ${fs(56)} ${s.padX} 0; text-align: center; }
  .eyebrow { font-size: ${fs(11)}; font-weight: 700; letter-spacing: 0.32em; text-transform: uppercase; color: ${p.accent}; }
  .headline { margin: ${fs(20)} 0 0; font-family: ${SERIF_STACK}; font-size: ${fs(42)}; line-height: 1.12; font-weight: 600; letter-spacing: -0.01em; color: ${p.ink}; }
  .rule { width: ${fs(56)}; height: ${fs(2)}; background: ${p.accent}; margin: ${fs(20)} auto; }
  .subheadline { margin: 0; font-size: ${fs(17)}; font-weight: 500; color: ${MUTED}; }
  .photo {
    margin: ${fs(28)} auto 0; width: 82%; aspect-ratio: 3 / 2; object-fit: cover;
    border: 1px solid #dde3f0; padding: ${fs(8)}; background: #ffffff;
  }
  .points { list-style: none; margin: ${fs(28)} auto 0; padding: 0; max-width: 82%; }
  .points li { padding: ${fs(11)} 0; border-bottom: 1px solid #eceff7; font-size: ${fs(16)}; font-weight: 500; color: ${p.ink}; }
  .points li:last-child { border-bottom: 0; }
  .price { margin-top: ${fs(22)}; font-family: ${SERIF_STACK}; font-size: ${fs(30)}; font-weight: 600; color: ${p.accent}; }
  .promo { margin-top: ${fs(8)}; font-size: ${fs(15)}; font-style: italic; color: ${MUTED}; }
  .cta-min { margin-top: auto; padding: ${fs(26)} 0 ${fs(20)}; }
  .cta-text { font-size: ${fs(15)}; font-weight: 800; letter-spacing: 0.22em; text-transform: uppercase; color: ${p.ink}; }
  .cta-closing { margin-top: ${fs(8)}; font-size: ${fs(14)}; color: ${MUTED}; }
  .footer {
    margin: 0 calc(-1 * ${s.padX}); padding: ${fs(14)} ${s.padX}; border-top: 1px solid #e2e8f5;
    display: flex; justify-content: space-between; align-items: center; font-size: ${fs(12)}; color: ${MUTED};
  }
  .footer strong { color: ${p.accent}; }`;
  const body = `
  <div class="sheet">
    <div class="eyebrow">${ctx.eyebrow}</div>
    <h1 class="headline">${ctx.headline}</h1>
    <div class="rule"></div>
    <p class="subheadline">${ctx.sub}</p>
    ${photo ? imgTag(photo, "photo") : ""}
    <ul class="points">${ctx.points.map((pt) => `<li>${pt}</li>`).join("")}</ul>
    ${ctx.price ? `<div class="price">${ctx.price}</div>` : ""}
    ${ctx.promo ? `<div class="promo">${ctx.promo}</div>` : ""}
    <div class="cta-min">
      ${ctaBlockHtml(ctx, "cta-text")}
      <div class="cta-closing">${ctx.closing}</div>
    </div>
    ${footerHtml(ctx)}
  </div>`;
  return { css, body };
}

const TEMPLATE_RENDERERS: Record<PromotionTemplate, (ctx: FlyerRenderContext) => TemplateRender> = {
  showcase: renderShowcase,
  listing_sheet: renderListingSheet,
  photo_hero: renderPhotoHero,
  split: renderSplit,
  feature_grid: renderFeatureGrid,
  bold_banner: renderBoldBanner,
  minimal: renderMinimal,
};

/**
 * Render a promotion as a standalone, print-ready HTML document. The layout is
 * driven by `row.template`, the canvas (page size, sheet dimensions, padding)
 * by `row.flyerSize`, and colors by `row.theme`. Uploaded photos in
 * `row.inputs.images` are embedded per template; templates degrade gracefully
 * (brand-gradient hero / photo-less variant) when no image was uploaded.
 * Falls back to composed copy when `row.copy` is null so a preview always renders.
 */
export function buildFlyerHtml(row: ManagerPromotionRow): string {
  const palette = paletteForTheme(row.theme);
  const size = sizeSpecFor(row.flyerSize);
  const copy = row.copy ?? composeFallbackFlyerCopy(row.inputs, row.propertyLabel);
  const template = normalizePromotionTemplate(row.template);
  const ctx: FlyerRenderContext = {
    p: palette,
    s: size,
    fs: (n) => `${Math.round(n * size.scale)}px`,
    images: sanitizeFlyerImages(row.inputs.images),
    eyebrow: escapeHtml(row.propertyLabel || "Now Leasing"),
    headline: escapeHtml(copy.headline),
    sub: escapeHtml(copy.subheadline),
    promo: copy.promoLine ? escapeHtml(copy.promoLine) : "",
    price: row.inputs.price.trim() ? escapeHtml(row.inputs.price.trim()) : "",
    cta: escapeHtml(copy.ctaText),
    closing: escapeHtml(copy.closingLine),
    points: copy.sellingPoints.map((pt) => escapeHtml(pt)),
    address: row.inputs.address?.trim() ? escapeHtml(row.inputs.address.trim()) : "",
    schedulingUrl:
      row.inputs.includeSchedulingLink !== false && row.inputs.schedulingUrl?.trim()
        ? escapeHtml(row.inputs.schedulingUrl.trim())
        : "",
  };
  const { css, body } = TEMPLATE_RENDERERS[template](ctx);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${ctx.headline}</title>
<style>
  @page { size: ${size.page}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT_STACK};
    color: ${palette.ink};
    background: #eef2fb;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  img { display: block; }
  .sheet {
    width: ${size.width};
    min-height: ${size.minHeight};
    margin: 0 auto;
    background: #ffffff;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .cta-link { color: inherit; text-decoration: underline; }
${css}
</style>
</head>
<body>
${body}
</body>
</html>`;
}
