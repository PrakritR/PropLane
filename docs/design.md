# Axis Housing — Blue Steel Design System

Visual design reference for the Axis Housing platform. This document synthesizes the **Blue Steel** identity as implemented in `src/app/globals.css` and across the five product surfaces defined in [`docs/specs/`](specs/).

---

## Brand identity

**Product:** Axis Housing — property management software for applications, leases, and rent collection for property managers and platform admins. Public marketing is owner-focused; apply and tour flows are manager-shared deep links only.

**Design language:** **Blue Steel** — a metallic cobalt-and-steel aesthetic that reads premium and architectural without sacrificing legibility. The brand is expressed through:

- A rotating **chrome substrate** (conic gradients, gloss, legibility wash) on marquee moments
- **Frosted glass** cards, nav, and inputs with hairline borders and inset highlights
- A single **cobalt accent** (`#2f6bff` → `#5a8cff`) — never a second hue for role or surface differentiation
- The **PropLane mark**: a rounded house/chevron outline with a crossing X inside — single-colour line art, round caps and joins, no fill or glow. In-app it strokes with the `primary` theme accent (blue light theme / purple dark theme); fixed contexts (favicon, app icon, exports) use the literal PropLane blue `#2f6bff`. The legacy paper-plane glyph and the older “AX” letters are both retired everywhere, including the browser tab icon.

**Logo tile:** 40–56px rounded square (14–20px radius), frosted gradient fill, white hairline border, inset top highlight. Wordmark: **PropLane** (17px semibold, −0.035em tracking; 15px in the `compact` size).

Where each brand surface lives — and the rule that `src/app/icon.svg` and `src/app/favicon.ico` must be regenerated together — is in AGENTS.md, “Brand assets (PropLane)”.

---

## Design philosophy

| Principle | Meaning |
|-----------|---------|
| **Chrome where it matters** | Full animated substrate on the partner hero, auth, and billing success. Quiet static base everywhere else (see “Where to use each”). |
| **Calm where data lives** | Tables, forms, wizards, and ledgers sit on solid or near-solid surfaces — never over moving metal. |
| **One accent, many neutrals** | Cobalt carries all interactive emphasis. Surfaces differ by neutral temperature and default theme, not new colors. |
| **Geometry is shared** | Light and dark share radii, type scale, motion curves, and component structure — only substrate and foreground invert. |
| **Legibility is structural** | The legibility wash (layer 4 of full chrome) guarantees ≥4.5:1 body text contrast. It is required, not decorative. |

---

## Color system

Tokens live in `:root` / `[data-theme="light"]` and `[data-theme="dark"]`, surfaced to Tailwind v4 via `@theme inline` in `globals.css`.

### Core palette

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--primary` | `#2f6bff` | `#2f6bff` | Links, active states, primary buttons |
| `--primary-alt` / `--sky` | `#5a8cff` | `#5a8cff` | Gradients, secondary accent strokes |
| `--cobalt-deep` | `#1e4fd6` | `#1e4fd6` | Code, deep accent |
| `--steel-light` | `#bcd4ff` | `#bcd4ff` | Eyebrows, dark-theme logo fold stroke, dark-theme approved status |
| `--foreground` | `#0b1b3a` (navy) | `#ffffff` | Body and headings |
| `--muted` | `#4a5878` | `rgba(255,255,255,0.62)` | Secondary text, captions |
| `--background-solid` | `#f7f9fd` | `#080b14` | Page base |
| `--background` | `linear-gradient(180deg, #f7f9fd → #dde5f2)` | `#080b14` | Marketing gradient (light) |
| `--border` | `#e6ebf3` | `rgba(255,255,255,0.18)` | Hairlines, dividers |
| `--danger` | `#c0392b` | `#c0392b` | Errors, overdue, quiet destructive actions |

### Glass & surfaces

| Token | Light | Dark |
|-------|-------|------|
| `--glass-fill` | `rgba(255,255,255,0.62)` | `rgba(255,255,255,0.12)` |
| `--glass-border` | `rgba(255,255,255,0.9)` | `rgba(255,255,255,0.32)` |
| `--card` | `rgba(255,255,255,0.7)` | `rgba(255,255,255,0.1)` |
| `--auth-input-bg` | `rgba(255,255,255,0.55)` | `rgba(255,255,255,0.10)` |
| `--portal-surface-dark` | — | `#0b1120` |
| `--portal-surface-light` | `linear-gradient(180deg, #f5f8fd → #e9eef7)` | — |
| Admin override (`[data-surface="admin"]`) | — | `#0a0e18` (deeper, cooler) |

### Status palette

Shared across all portals. Use `Badge` tones — do not invent new status colors.

| State | Light FG / BG | Dark FG / BG | Badge tone |
|-------|-------------|--------------|------------|
| **Pending** | `#a06b15` / `#fdeccb` | `#ffd28a` / `rgba(255,193,94,0.15)` | `pending`, `warning` |
| **Approved / info** | `#2f6bff` / `#e2ebff` | `#bcd4ff` / `rgba(124,140,255,0.18)` | `approved`, `info` |
| **Confirmed / paid** | `#1f8a5b` / `#d8f3e4` | `#9fe6c0` / `rgba(60,200,140,0.16)` | `confirmed`, `success` |
| **Overdue / error** | `#c0392b` / `#fbe1de` | `#f08070` / `rgba(240,128,112,0.15)` | `overdue`, `danger` |

### Shadows

| Token | Role |
|-------|------|
| `--shadow-sm` | Subtle elevation (outline buttons, light cards) |
| `--shadow-card` | Default glass card depth |
| `--shadow-card-hover` | Hover lift — cobalt-tinted on interactive cards |

### Selection & focus

- Text selection: `rgba(47, 107, 255, 0.18)`
- Focus ring: `2px solid var(--ring)` with `3px` offset (`--ring`: cobalt at 30% opacity)

---

## Typography

**Sans:** **Schibsted Grotesk** (SIL Open Font License), variable 400–900,
self-hosted and subset — `src/app/fonts.ts`, loaded in `src/app/layout.tsx`.
The token is `--font-sans` (`globals.css`), composed as
`var(--font-brand-sans), <former system stack>`.

⚠️ **Two rules for anyone replacing this face.**

1. **It must have real tabular figures (`tnum`).** `tabular-nums` is used ~133
   times across ~46 files — every payment ledger, rent table and KPI tile. A
   face without a `tnum` GSUB feature makes all of that a SILENT no-op: money
   columns rag and nothing fails anywhere. Verify with fontTools *after*
   subsetting, since subsetting is where the feature usually gets dropped:
   `python -c "from fontTools.ttLib import TTFont; print(sorted({r.FeatureTag for r in TTFont('f.woff2')['GSUB'].table.FeatureList.FeatureRecord}))"`
2. **Never name next/font's variable `--font-sans`.** Tailwind v4 emits that
   token itself from `@theme inline`; the two definitions collide and the loser
   is not obvious. Use a private variable and compose it in, as `fonts.ts` does.

The former system stack is retained as the fallback, so a failed font load
degrades to the previous rendering rather than to a default serif.

**Mono stack:** `ui-monospace, "SF Mono", "Cascadia Code", monospace` — table headers, KPI captions, section labels, IDs, status chips. Deliberately still a system stack: it costs zero bytes and holds the numeric/label channel.

**Base:** browser default root (16px) with `text-sm` doing most of the work — there is **no** `font-size` on `html`/`body`. Line-height **1.52**, antialiased, `optimizeLegibility`.

### Scale (common patterns)

| Element | Size / weight | Notes |
|---------|---------------|-------|
| Hero headline | 36–72px / 600 | `hero-title`; accent fragment uses `.text-gradient-accent` |
| Hero eyebrow | 12px pill | Glass pill + glowing accent dot |
| Section H2 (spec docs) | 24px / 600, −0.02em | |
| Portal section title | 18–24px / 600 | Header bar |
| Nav items | 14px / 500 | 14px radius active pill |
| KPI value | 32px / 700 | Inside 16px-radius glass tile |
| Badge | 10px / 700 | Pill, uppercase optional |
| Footer section label | 11px uppercase, 0.22em tracking | |
| Mono label | 10–11px uppercase, 0.06–0.18em tracking | Queue tabs, wizard steps |

### Accent text gradient

`.text-gradient-accent`:
- **Light:** cobalt → sky (`135deg`)
- **Dark:** white → steel-light

Used for headline accent fragments (e.g. “works for you”) and emphasis on chrome scenes.

---

## Chrome substrate

The signature Blue Steel background. Implemented in `ChromeSubstrate` (`src/components/brand/chrome-substrate.tsx`) with CSS in `globals.css`.

### Variants

**Full chrome** (`variant="full"`) — four layers:

1. **Conic flow** — rotating blurred conic gradient (`chromeFlow`, 26s linear). Cobalt, steel, grey stops.
2. **Overlay shift** — secondary conic with overlay blend (`chromeShift`, 18s ease-in-out).
3. **Top gloss** — upper 38–46% white linear fade.
4. **Legibility wash** — radial vignette darkening/lightening the center for readable copy.

**Quiet substrate** (`variant="quiet"`) — static `bg-background` plus faint cobalt corner glows (`chrome-substrate-quiet-glow`). No rotation.

**Portal content substrate** — calm portal surface (dark `#0b1120` or light gradient) + quiet corner glow.

### Where to use each

| Substrate | Surfaces |
|-----------|----------|
| **Full chrome** | Partner hero, auth pages, billing success |
| **PropLane hero** | Home hero (`/`) — see below; Blue Steel full chrome does **not** run here |
| **Quiet** | Apply/tours wizards (deep-link only), partner pricing/contact, default public layout |
| **Portal calm** | All authenticated portal content areas |
| **Sidebar chrome only** | Portal brand header (266px sidebar) — metal confined to this strip |

**Rule:** Never place dense fields, tables, or long forms over animated chrome.

### Homepage hero background (PropLane grid + bloom)

The homepage hero (`LandingDemoHero`, `landing-demo-hero.tsx`) does **not** use
Blue Steel full chrome — it moved to the `--pl-*` purple/blue theme split. Its
background is the `.landing-hero-glow` container holding four layers, styled in
`globals.css` next to the hero block. Theme split is absolute: **purple family
in dark, cobalt-blue family in light, never mixed** (base rules purple,
`[data-theme="light"]` overrides blue), using `--pl-*` tokens only.

1. **Architectural grid** (`.landing-hero-grid`) — a 1px lattice from two
   `repeating-linear-gradient`s on the shared `--lp-grid-size` pitch (56px, in
   `globals.css`), faded with a radial `mask-image` so it is crisp behind the
   headline and gone by the edges.
2. **Brand bloom** (`.landing-hero-bloom`) — one large radial glow behind the
   product panel (`ApplicationsPipelinePanel`).
3. **Lit cells** (`.landing-hero-cells`) — a few grid cells softly lit like
   occupied units, breathing slowly (`hero-cells-breathe`, opacity only).
4. **Legibility wash** (`.landing-hero-wash`) — a radial that darkens (dark) /
   lightens (light) the left text column so `.landing-hero-sub` /
   `.landing-hero-trust` hold ≥4.5:1. Mirrors `.chrome-substrate-full__wash`.

The panel keeps its own opaque fill and sits strictly above the background;
motion is `transform`/`opacity` only (compositor-safe for the Capacitor
WebView), and the lit-cells animation holds a static frame under
`prefers-reduced-motion`.

**The lattice continues below the hero.** `.lp-blueprint`
(`landing-proplane.css`) reads the same `--lp-grid-size`, so its squares are
never a different size from the hero's — never hardcode a second pitch. It is
applied once to the `.lp-flow-band` wrapper around the dashboard-demo,
inbox-demo, and learn sections (`landing-home-sections.tsx`), not per section:
a per-section background restarts its tiling origin at that section's top edge,
so the squares appear to shift wherever a section height is not a multiple of
the pitch. Sections inside the band stay transparent.

---

## Glass morphism

Utility class: `.glass-card`

```css
background: var(--glass-fill);
border: 1px solid var(--glass-border);
backdrop-filter: blur(24px);
box-shadow: var(--shadow-card);
```

**Nav** (`.glass-nav`): `blur(20px)`, sticky top strip, scroll-intensified fill via `#axis-public-navbar[data-scrolled]`.

**Auth card:** max 460px, 24px radius, glass fill, deep ambient shadow + inset top highlight.

**Property / room cards:** 18px radius (`rounded-2xl`), `NoImagePlaceholder` tile when no genuine photo (see "Listing images" in `AGENTS.md`), price chip, hover uses `--shadow-card-hover`.

---

## Components

### Buttons

Pill shape (`rounded-full`), min-height **44px**, 14px semibold. Variants in `Button`:

| Variant | Appearance | When |
|---------|------------|------|
| **primary** | Cobalt→sky gradient, white text, cobalt shadow | Main CTA on light backgrounds |
| **metallic** | White→steel-light gradient, navy text, inset highlight | Primary on dark chrome / hero |
| **secondary** | Transparent, cobalt border + text | Secondary actions, “Apply online” |
| **outline** | Card fill, border | Tertiary |
| **ghost** | Text only | Nav-adjacent, low emphasis |
| **danger** | Red text, no fill | Reject, unlist — **never** filled red |

**Portal command-strip primaries** (`Add property`, `Add resident`, …): compact
`rounded-lg` cobalt fill with white text — not the pill primary above. Shared
tokens: `PORTAL_COMMAND_PRIMARY_ACTION_BTN` + `PORTAL_COMMAND_PRIMARY_ACTION_STYLE`
in `portal-metrics.tsx`. Full layout, pairing with outline actions, and per-section
labels: [`docs/portal-ui-system.md` → Command-strip primary CTAs](portal-ui-system.md#command-strip-primary-ctas-add-property-add-resident).

**Loading state.** A button doing async work shows an inline `currentColor` spinner before its
label (so it reads on every variant), sets `aria-busy`, and is disabled until the work settles.
It is automatic whenever `onClick` returns a promise, so a button that awaits its own work needs
no hand-rolled spinner. See `Button` in `src/components/ui/button.tsx`.

### Badges

10px bold pill with semantic status tokens. Tones: `pending`, `approved`, `confirmed`, `overdue`, `info`, `success`, `warning`, `danger`, `neutral`.

### Segmented control

Pill container with sliding cobalt indicator (`.segmented-pill`). Used for: theme-adjacent toggles, queue state tabs, monthly/annual pricing, filter chips.

### Theme toggle

Sun/moon button pair in a rounded track. Active segment: cobalt fill + white icon. `aria-pressed` on each button — state never conveyed by color alone.

Persisted to `localStorage` key `axis:theme`. Root inline script prevents flash; `ThemeProvider` syncs `data-theme` on `<html>`.

### Default themes by surface

| Surface | Default | Override component |
|---------|---------|-------------------|
| Marketing / Auth / Root | Dark | `ThemeProvider defaultTheme="dark"` |
| Property portal | Light | `SurfaceThemeDefault theme="light"` |
| Resident portal | Light | `SurfaceThemeDefault theme="light"` |
| Admin portal | Dark | `SurfaceThemeDefault theme="dark"` + `[data-surface="admin"]` |

User preference in localStorage wins over surface defaults.

### Wizard shell

Shared pattern for rental apply (12 steps), tours/contact, manager-id onboarding:

- **Left rail** (desktop): numbered circles — active = cobalt fill + glass pill; done = green tint
- **Top progress bar**: cobalt→sky gradient fill
- **Footer dots**: active elongated cobalt pill
- **Compact strip** (`WizardProgressStrip`): 3-step auth onboarding

The manager add-listing wizard (6 steps, `manager-add-listing-form.tsx`)
deliberately diverges: its clickable step-pill row is the **single** progress
signal (✓ completed steps stay clickable, current filled, unreached visibly
disabled) — no separate "Step X of N" line or progress bar alongside it.

Wizards use **quiet substrate** — no chrome behind fields.

### Tables & data

- Solid surface only (white light / `rgba(255,255,255,0.05)` dark)
- Mono uppercase column headers
- Hairline row dividers
- Row hover: faint cobalt wash
- Active filter: cobalt fill segmented pill
- Minimum data text: **13px**

### KPI tile

16px radius, glass fill, 32px/700 metric, label + caption. Attention tiles: amber border; neutral: standard border.

### List card

Mono uppercase section label + “View all” accent link. Rows: name, sub-line, status badge, faint inset row background.

---

## Motion

| Animation | Duration | Usage |
|-----------|----------|-------|
| `chromeFlow` | 26s linear | Full chrome conic rotation |
| `chromeShift` | 18s ease-in-out | Overlay drift |
| `sheen` | 7s | Hero search bar diagonal sweep |
| `hero-cells-breathe` | 14s ease-in-out | Homepage hero lit-cells opacity breath (grid + bloom) |
| `page-enter` | 0.42s cubic-bezier(0.22,1,0.36,1) | Route transitions (`PublicMainTransition`) |
| `fade-up` | 0.45s | Hero stagger |
| `reveal-on-view` | 0.55s | Scroll reveals |

**Reduced motion:** All ambient animation (`chrome-flow`, `chrome-shift`, `sheen-sweep`, `landing-hero-cells`, orb drift, page-enter) halts under `prefers-reduced-motion: reduce` — static frame retained.

Interactive feedback: `active:scale-[0.99]`, 200ms transitions on buttons and nav.

---

## Accessibility

- **Contrast:** Legibility wash ensures body copy ≥4.5:1 on chrome scenes. Keep primary copy in the central calm zone, off the bright top-gloss band.
- **Focus:** Visible `:focus-visible` ring on all interactive elements; cobalt `--ring`.
- **Theme toggle:** Labeled button group; `aria-pressed` per option.
- **Touch targets:** 44px minimum on buttons and primary nav.
- **Tap highlight:** Disabled (`-webkit-tap-highlight-color: transparent`).
- **Safe areas:** Nav respects `env(safe-area-inset-top)`.
- **Wizard progress:** `role="progressbar"` with aria values.

---

## Surface guide

Five product surfaces. Per-route detail lives in [`docs/specs/`](specs/).

### 1. Marketing & public (`(public)/`)

**Spec:** [Blue Steel Marketing Spec](specs/Blue%20Steel%20Marketing%20Spec.html)

**Chrome:** Full on `/partner`, `/billing/success`. The home hero (`/`) runs the
PropLane grid + bloom background (see [Chrome substrate → Homepage hero
background](#homepage-hero-background-proplane-grid--bloom)), not full chrome.
Quiet elsewhere.

**Key components:** `PublicNavbar`, `PublicFooter`, `ChromeSubstrate`, pricing tier cards.

**Hero patterns:**
- Headline accent: `.text-gradient-accent`
- Primary CTA: **Partner with Axis** → `/partner`
- No eyebrow/badge pill above the headline — public marketing heroes open on the headline itself. The eyebrow pill primitives stay for non-marketing surfaces (listing detail modals, rental-application wizard, auth pages, portal paywalls).

**Partner:** Hero CTA pair; four glass capability cards; plan-tier price list linking to `/pricing`. No trailing CTA band.

---

### 2. Auth & onboarding (`auth/`)

**Spec:** [Blue Steel Auth Onboarding Spec](specs/Blue%20Steel%20Auth%20Onboarding%20Spec.html)

**Scene:** Full chrome + centered `AuthCard` (460px) + public nav/footer.

**Fields:** `--auth-input-bg`, ≥1px border, cobalt focus ring.

**Submit:** Full-width metallic (dark) or cobalt pill (light).

**Special flows:**
- **choose-portal:** Glass role cards, cobalt gradient border when selected
- **manager-id:** Mono ID chip + copy button; 3-step progress strip
- **continue:** Logo tile + steel-light spinner, no card

---

### 3. Property portal (`portal/`, managers & owners)

**Spec:** [Blue Steel Property Portal Spec](specs/Blue%20Steel%20Property%20Portal%20Spec.html)

**Shell:** `PortalSidebar` (266px) + `PortalTopBanners` + content header.

**Sidebar brand header:** Contained chrome gradient
- Dark: `linear-gradient(135deg, #2a3c5e, #16233f, #0e1830)`
- Light: `#e9eefb → #d7e1f3`

**Nav active state:** Glass fill + inset border + accent dot (dark) / white card + shadow + cobalt dot (light).

**Content:** Portal calm surface + section title + primary header action.

**Tier gating:** `PortalTierPaywall` — centered glass card with chrome accent strip; one allowed “chrome bloom” inside the app.

---

### 4. Admin portal (`admin/`)

**Spec:** [Blue Steel Admin Portal Spec](specs/Blue%20Steel%20Admin%20Portal%20Spec.html)

Inherits property portal shell. Differentiators:

- Default **dark**, base `#0a0e18`
- Wordmark: “Axis Housing · Admin” + mono `ADMIN` pill
- **Preview-as-user** banner: persistent cobalt glass strip at top
- **Review queue pattern:** summary + status badge + action cluster
  - Approve = cobalt primary
  - Request changes = secondary outline
  - Reject = quiet danger (text only)

---

### 5. Resident portal (`resident/`)

**Spec:** [Blue Steel Resident Portal Spec](specs/Blue%20Steel%20Resident%20Portal%20Spec.html)

Inherits portal shell. Differentiators:

- Default **light**, warmest/readable
- Personal header: “Welcome, {name}” + property sub-line; avatar with cobalt→sky initials
- **Status-led dashboard:** banners before tile grid
  - Approval = green glass
  - Lease to sign = cobalt glass
  - Balance due = amber glass
- **Action tiles:** larger touch targets, friendly cards (not dense tables)
- **Dynamic nav** by lease state; locked items muted + lock glyph
- **Manager-tier gating:** gentle glass notice — neutral language, no loud CTA

---

## Layout & spacing

- **Max content width:** `max-w-6xl` (1152px) for marketing nav and hero content. The full `PublicFooter` is the deliberate exception — it runs full-bleed (`max-w-[1600px]` with page-chrome gutters) so its link columns align with the page edges; the `compact` footer stays `max-w-6xl`.
- **Page frame:** `.axis-page-frame` — light gradient stack or dark solid
- **Portal sidebar:** 266px fixed; content scrolls independently
- **Border radius scale:** 14px nav/cards, 18px cards/photo, 24px auth card, 9999px pills/buttons
- **Grid gaps:** 14–18px component gaps; 40–54px section padding on marketing pages. Exception: the home hero + its portfolio stats strip run a deliberately tighter desktop-only rhythm (`lg:` padding, `lg:py-9`/36px on the stats strip, and a 32px `.landing-hero-bridge` at ≥1024px) so both fit one ~900px viewport — see `landing-demo-hero.tsx`.

---

## Do & don't (global)

### Do

- Confine animated chrome to marquee moments; use quiet substrate for work surfaces
- Reuse the shared status palette and wizard shell everywhere
- Keep destructive actions quiet (text-only danger)
- Honor user theme + OS preference
- Use real focus rings and labeled controls
- Default light for data-heavy portals; dark for marketing marquee and admin

### Don't

- Don't animate chrome behind tables, forms, or ledgers
- Don't add surface-specific accent colors (admin, resident, partner)
- Don't use filled red buttons for reject/delete
- Don't shrink data text below 13px
- Don't stack multiple cards over full chrome
- Don't reskin one portal section in isolation — shell and tokens are shared

---

## Implementation reference

| Concern | Location |
|---------|----------|
| Design tokens & utilities | `src/app/globals.css` |
| Chrome substrate | `src/components/brand/chrome-substrate.tsx` |
| Logo & mark | `src/components/brand/axis-logo.tsx` |
| Theme | `src/components/providers/theme-provider.tsx` |
| Buttons | `src/components/ui/button.tsx` |
| Badges | `src/components/ui/badge.tsx` |
| Wizard | `src/components/ui/wizard-shell.tsx` |
| Public chrome | `src/components/layout/public-navbar.tsx`, `public-footer.tsx` |
| Portal shell | `src/components/portal/portal-sidebar.tsx` |
| Auth card | `src/components/auth/auth-card.tsx` |
| Surface specs | `docs/specs/Blue Steel *.html` |

---

## Version

Document **1.0** — aligned with Blue Steel specs v0.1 and the implemented token set in `globals.css`.
