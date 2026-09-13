// @vitest-environment jsdom
//
// `ManagerPortalPageShell` renders `PortalPageTitleBand` at EVERY breakpoint once
// `hideTitleOnMobileNav` + `titleAside` are set with no `filterRow` (the `useInlineTitleBand`
// path). So a section's header controls can reach a phone by exactly one of two shapes:
//
//   a) BAND-ONLY  — an ungated `titleAside`, no `PortalPageHeaderMobileActionsRow`.
//   b) SPLIT      — a `hidden md:flex` `titleAside` paired with an `md:hidden` mobile row.
//
// Mixing them draws the controls TWICE on mobile. That shipped to production as two
// overlapping "Apply to property" buttons on resident Applications and two "Schedule a tour"
// on resident Tour — the two most important CTAs in the resident journey.
//
// The opposite failure is worse: suppressing the mobile row on a SPLIT section leaves ZERO
// controls, because its band is display:none on phones. Both halves are asserted here.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalPageHeaderMobileActionsRow } from "@/components/portal/portal-section-action-row";

vi.mock("@/hooks/use-is-native-app", () => ({ useNativeChrome: () => false }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

afterEach(cleanup);

const PORTAL_DIR = join(process.cwd(), "src/components/portal");

/**
 * Sections still on the SPLIT shape (b). Their `titleAside` is `hidden md:flex`, so the band
 * contributes nothing on a phone and the mobile row is the ONLY control there — deleting it
 * would leave the section with zero controls, not one.
 */
const SPLIT_SHAPE_PANELS: string[] = [
  // Currently EMPTY, and that is a real state rather than an oversight: every
  // portal panel has migrated to the band-only shape, where an ungated
  // `titleAside` renders in the title band at every breakpoint and reaches a
  // phone exactly once. `resident-lease-panel.tsx` moved its buttons into the
  // detail footer; `resident-payments-panel.tsx` dropped its `titleAside`
  // entirely. Listing a migrated panel here keeps this guard permanently red
  // against a shipped redesign.
  //
  // Add a panel here only if it goes back to the split shape: a
  // `hidden md:flex` titleAside PLUS its own `md:hidden` actions row. The
  // dangerous direction — a band-only panel that also ships a mobile row, so
  // controls draw twice on a phone — is covered automatically by the scan over
  // every portal source above, which needs no list.
];
/**
 * A hand-rolled mobile row is identified by its `data-slot` alone, NOT by scanning the
 * className for `md:hidden`. Panels build that className however they like — a template
 * literal with an embedded ternary (`resident-payments-panel.tsx`) contains quotes, so any
 * `[^"]*` bridge from the class list to the attribute terminates early and the panel goes
 * invisible to this sweep. The slot name is the stable marker; a row that forgot `md:hidden`
 * duplicates at every breakpoint and should be caught here too.
 */
const RENDERS_MOBILE_ROW = /<PortalPageHeaderMobileActionsRow|data-slot="[a-z-]*mobile-actions"/;

/**
 * The gate has to be read off the `titleAside` the shell actually receives, never off the
 * file. A panel may hold any number of incidental `hidden … md:flex` blocks that have
 * nothing to do with its header — `manager-applications.tsx` has one on its detail-row
 * action group — and a file-wide scan treats each of them as proof the band is gated,
 * silently exempting the panel from the whole check.
 */
function skipStringLiteral(src: string, index: number): number {
  const quote = src[index];
  let i = index + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\\") i += 1;
    i += 1;
  }
  return i;
}

/** Text between the braces of `prefix{ … }`, honouring nesting and quotes. */
function readBracedExpression(src: string, prefix: string, from: number): { text: string; end: number } | null {
  const start = src.indexOf(prefix, from);
  if (start === -1) return null;
  let depth = 0;
  let i = start + prefix.length;
  for (; i < src.length; i += 1) {
    const char = src[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  return { text: src.slice(start + prefix.length, i), end: i };
}

/** Every `<Name …>` opening tag in `src`, with the raw text of its props. */
function openingTags(src: string, name: string): string[] {
  const marker = new RegExp(`<${name}(?=[\\s/>])`, "g");
  const tags: string[] = [];
  let match = marker.exec(src);
  while (match) {
    let depth = 0;
    let i = match.index + match[0].length;
    for (; i < src.length; i += 1) {
      const char = src[i];
      if (char === '"' || char === "'" || char === "`") {
        i = skipStringLiteral(src, i);
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) break;
    }
    tags.push(src.slice(match.index + match[0].length, i));
    marker.lastIndex = i;
    match = marker.exec(src);
  }
  return tags;
}

/** `true` for a bare prop, the expression/string text otherwise, absent when not written. */
type PropValue = string | true;

function parseTagProps(props: string): Record<string, PropValue> {
  const parsed: Record<string, PropValue> = {};
  let i = 0;
  while (i < props.length) {
    if (/\s/.test(props[i])) {
      i += 1;
      continue;
    }
    if (props[i] === "{") {
      i = (readBracedExpression(props, "{", i)?.end ?? i) + 1;
      continue;
    }
    const name = /^[A-Za-z_$][\w$-]*/.exec(props.slice(i))?.[0];
    if (!name) {
      i += 1;
      continue;
    }
    i += name.length;
    while (i < props.length && /\s/.test(props[i])) i += 1;
    if (props[i] !== "=") {
      parsed[name] = true;
      continue;
    }
    i += 1;
    while (i < props.length && /\s/.test(props[i])) i += 1;
    if (props[i] === "{") {
      const expression = readBracedExpression(props, "{", i);
      parsed[name] = expression?.text ?? "";
      i = (expression?.end ?? i) + 1;
    } else if (props[i] === '"' || props[i] === "'") {
      const end = skipStringLiteral(props, i);
      parsed[name] = props.slice(i + 1, end);
      i = end + 1;
    } else {
      const end = props.slice(i).search(/\s|$/);
      parsed[name] = props.slice(i, i + end);
      i += end;
    }
  }
  return parsed;
}

/** The `const <name> = …;` initializer, so an identifier `titleAside` can be inspected. */
function resolveBinding(src: string, identifier: string): string | null {
  const decl = new RegExp(`\\bconst\\s+${identifier}\\s*=`).exec(src);
  if (!decl) return null;
  let depth = 0;
  let i = decl.index + decl[0].length;
  const start = i;
  for (; i < src.length; i += 1) {
    const char = src[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === ";" && depth === 0) break;
  }
  return src.slice(start, i);
}

/** The className of the ROOT element the aside renders — a gate on a child proves nothing. */
function rootClassName(expression: string): string | null {
  const stringAt = expression.indexOf('className="');
  const exprAt = expression.indexOf("className={");
  if (stringAt === -1 && exprAt === -1) return null;
  if (exprAt === -1 || (stringAt !== -1 && stringAt < exprAt)) {
    const from = stringAt + 'className="'.length;
    const end = expression.indexOf('"', from);
    return expression.slice(from, end === -1 ? undefined : end);
  }
  return readBracedExpression(expression, "className={", exprAt)?.text ?? null;
}

const DESKTOP_GATE = /(\bhidden\b[\s\S]*\bmd:flex\b)|(\bmd:flex\b[\s\S]*\bhidden\b)|\bmax-md:hidden\b/;

/**
 * How one shell-like component maps a CALLER's props onto the four
 * `useInlineTitleBand` inputs. Reading the literal call-site text instead is the second
 * hole this guard has had: `PortalCommunicationShell` defaults `hideTitleOnMobileNav` to
 * `true`, so `admin-communication.tsx` is on the band path without writing the prop, and
 * `PortalListSectionShell` always forwards `filterRow={filterRow}` to the inner shell, so
 * it reads as "has a filterRow" even for a caller that passes none. Both were silently
 * exempted from the check.
 */
type ShellSpec = {
  component: string;
  asideProp: string;
  filterRowProp: string | null;
  titleTrailingProp: string | null;
  titleInlineFilterProp: string | null;
  /** Caller-facing name of the hide-title prop; null when the wrapper fixes the value. */
  hideTitleProp: string | null;
  hideTitleDefault: boolean;
};

const BASE_SHELL: ShellSpec = {
  component: "ManagerPortalPageShell",
  asideProp: "titleAside",
  filterRowProp: "filterRow",
  titleTrailingProp: "titleTrailing",
  titleInlineFilterProp: "titleInlineFilter",
  hideTitleProp: "hideTitleOnMobileNav",
  hideTitleDefault: false,
};

/** Top-level exported components, each paired with the source text of its body. */
function exportedComponents(src: string): { name: string; body: string }[] {
  const starts = [...src.matchAll(/export function ([A-Z][\w$]*)\s*\(/g)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
  }));
  return starts.map((start, index) => ({
    name: start.name,
    body: src.slice(start.index, starts[index + 1]?.index ?? src.length),
  }));
}

/** Params carry JSDoc (`@deprecated Prefer controlStack`), which would eat the name after it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function signatureText(body: string): string {
  const open = body.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === "(") depth += 1;
    else if (body[i] === ")") {
      depth -= 1;
      if (depth === 0) return stripComments(body.slice(open + 1, i));
    }
  }
  return "";
}

function destructuredParams(signature: string): Set<string> {
  const open = signature.indexOf("{");
  if (open === -1) return new Set();
  const block = readBracedExpression(signature, "{", open)?.text ?? "";
  const params = new Set<string>();
  let depth = 0;
  let token = "";
  for (const char of `${block},`) {
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      const name = /^[A-Za-z_$][\w$]*/.exec(token.trim())?.[0];
      if (name) params.add(name);
      token = "";
      continue;
    }
    token += char;
  }
  return params;
}

function booleanParamDefaults(signature: string): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};
  for (const match of signature.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(true|false)\b/g)) {
    defaults[match[1]] = match[2] === "true";
  }
  return defaults;
}

/** Which of the component's OWN params feeds `expression`, following one local binding. */
function paramBehind(expression: string, params: Set<string>, body: string): string | null {
  const bare = expression.trim();
  if (params.has(bare)) return bare;
  const candidates = [bare];
  if (/^[A-Za-z_$][\w$]*$/.test(bare)) {
    const resolved = resolveBinding(body, bare);
    if (resolved) candidates.push(resolved);
  }
  for (const candidate of candidates) {
    for (const match of candidate.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (params.has(match[0])) return match[0];
    }
  }
  return null;
}

/** Read a wrapper's spec off the shell call it makes, so its DEFAULTS are honoured. */
function deriveWrapperSpec(name: string, body: string, known: ShellSpec[]): ShellSpec | null {
  for (const inner of known) {
    const tag = openingTags(body, inner.component)[0];
    if (tag === undefined) continue;
    const props = parseTagProps(tag);
    const signature = signatureText(body);
    const params = destructuredParams(signature);
    const defaults = booleanParamDefaults(signature);
    const forwarded = (innerProp: string | null): string | null => {
      if (!innerProp) return null;
      const value = props[innerProp];
      if (value === undefined || value === true) return null;
      return paramBehind(value, params, body);
    };
    const asideProp = forwarded(inner.asideProp);
    if (!asideProp) return null;
    const written = inner.hideTitleProp ? props[inner.hideTitleProp] : undefined;
    const hideTitleParam = typeof written === "string" ? paramBehind(written, params, body) : null;
    return {
      component: name,
      asideProp,
      filterRowProp: forwarded(inner.filterRowProp),
      titleTrailingProp: forwarded(inner.titleTrailingProp),
      titleInlineFilterProp: forwarded(inner.titleInlineFilterProp),
      hideTitleProp: hideTitleParam,
      hideTitleDefault: hideTitleParam
        ? (defaults[hideTitleParam] ?? false)
        : written === undefined
          ? inner.hideTitleDefault
          : true,
    };
  }
  return null;
}

function deriveShellSpecs(sources: { file: string; src: string }[]): ShellSpec[] {
  const specs = [BASE_SHELL];
  const components = sources.flatMap(({ src }) => exportedComponents(src));
  for (let pass = 0; pass < components.length; pass += 1) {
    const before = specs.length;
    for (const { name, body } of components) {
      if (specs.some((spec) => spec.component === name)) continue;
      const spec = deriveWrapperSpec(name, body, specs);
      if (spec) specs.push(spec);
    }
    if (specs.length === before) break;
  }
  return specs;
}

const PORTAL_SOURCES = readdirSync(PORTAL_DIR)
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => ({ file, src: readFileSync(join(PORTAL_DIR, file), "utf8") }));

const SHELL_SPECS = deriveShellSpecs(PORTAL_SOURCES);

function resolvedHideTitle(spec: ShellSpec, props: Record<string, PropValue>): boolean {
  if (!spec.hideTitleProp) return spec.hideTitleDefault;
  const written = props[spec.hideTitleProp];
  if (written === undefined) return spec.hideTitleDefault;
  if (written === true) return true;
  return written.trim() !== "false";
}

/**
 * Every shell call site that lands on the `useInlineTitleBand` path — a resolved
 * `hideTitleOnMobileNav`, a `titleAside`, and no `filterRow`, the props that make
 * `ManagerPortalPageShell` draw its band at every breakpoint. With a `filterRow` the shell
 * desktop-gates the aside itself (`titleAsideDesktopOnly`), so those need no manual gate.
 */
function inlineBandTitleAsides(src: string, specs: ShellSpec[] = SHELL_SPECS): { tag: string; gated: boolean }[] {
  const found: { tag: string; gated: boolean }[] = [];
  for (const spec of specs) {
    for (const tag of openingTags(src, spec.component)) {
      const props = parseTagProps(tag);
      const aside = props[spec.asideProp];
      if (aside === undefined || aside === true) continue;
      if (spec.filterRowProp && props[spec.filterRowProp] !== undefined) continue;
      if (!resolvedHideTitle(spec, props)) continue;
      const trailing = spec.titleTrailingProp ? props[spec.titleTrailingProp] : undefined;
      const inlineFilter = spec.titleInlineFilterProp ? props[spec.titleInlineFilterProp] : undefined;
      if (trailing !== undefined && inlineFilter === undefined) continue;
      const bare = aside.trim().replace(/\s*(\?\?|\|\|)\s*undefined$/, "");
      const resolved = /^[A-Za-z_$][\w$]*$/.test(bare) ? resolveBinding(src, bare) : bare;
      const className = resolved === null ? null : rootClassName(resolved);
      found.push({ tag: spec.component, gated: className !== null && DESKTOP_GATE.test(className) });
    }
  }
  return found;
}

describe("header controls reach mobile exactly once", () => {
  it("every panel with a mobile actions row keeps a desktop-gated titleAside", () => {
    const offenders: string[] = [];
    for (const { file, src } of PORTAL_SOURCES) {
      if (!RENDERS_MOBILE_ROW.test(src)) continue;
      // Band-only sections must not ALSO ship a mobile row; split sections must gate the band.
      for (const aside of inlineBandTitleAsides(src)) {
        if (!aside.gated) offenders.push(`${file} <${aside.tag}>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves shell props through wrapper defaults, not the literal call-site text", () => {
    const portalMetrics = readFileSync(join(PORTAL_DIR, "portal-metrics.tsx"), "utf8");
    expect(portalMetrics, "ManagerPortalPageShell no longer defaults hideTitleOnMobileNav to false").toContain(
      "hideTitleOnMobileNav = false,",
    );

    const spec = (component: string) => SHELL_SPECS.find((candidate) => candidate.component === component);

    // Defaults true and never forwards a filterRow — so a caller that writes neither is
    // still on the band path (admin-communication.tsx does exactly that).
    expect(spec("PortalCommunicationShell")).toMatchObject({
      asideProp: "titleAside",
      filterRowProp: null,
      hideTitleProp: "hideTitleOnMobileNav",
      hideTitleDefault: true,
    });
    expect(
      inlineBandTitleAsides(readFileSync(join(PORTAL_DIR, "admin-communication.tsx"), "utf8")),
    ).toEqual([{ tag: "PortalCommunicationShell", gated: false }]);

    // Renames the aside to `primaryAction` and hard-codes hideTitleOnMobileNav, but its
    // `filterRow={filterRow}` is only a filterRow when the CALLER passes one.
    expect(spec("PortalListSectionShell")).toMatchObject({
      asideProp: "primaryAction",
      filterRowProp: "filterRow",
      hideTitleProp: null,
      hideTitleDefault: true,
    });

    // Never sets hideTitleOnMobileNav, so it can never reach the band path.
    expect(spec("PortalListPageShell")).toMatchObject({ hideTitleProp: null, hideTitleDefault: false });
  });

  it("the split-shape panels still render their mobile row (never zero controls)", () => {
    // Guard the guard: an empty list must not read as a silent pass. When the
    // list is empty the invariant is carried entirely by the scan above.
    if (SPLIT_SHAPE_PANELS.length === 0) {
      // `portal-section-action-row.tsx` DEFINES the mobile row, so it matches
      // its own pattern; every other match would be a consumer.
      expect(
        PORTAL_SOURCES.filter(({ src }) => RENDERS_MOBILE_ROW.test(src))
          .map(({ file }) => file)
          .filter((file) => file !== "portal-section-action-row.tsx"),
      ).toEqual([]);
      return;
    }
    for (const file of SPLIT_SHAPE_PANELS) {
      const src = readFileSync(join(PORTAL_DIR, file), "utf8");
      expect(src, `${file} lost its mobile actions row`).toMatch(RENDERS_MOBILE_ROW);
      const asides = inlineBandTitleAsides(src);
      expect(asides.length, `${file} lost its inline-band titleAside`).toBeGreaterThan(0);
      expect(
        asides.every((aside) => aside.gated),
        `${file} lost its desktop gate`,
      ).toBe(true);
    }
  });

  it("reads the gate off the titleAside binding, not off an unrelated block in the file", () => {
    const ungated = [
      'const headerActions = (\n  <>\n    <button type="button">Send</button>\n  </>\n);',
      '<div className="hidden max-w-full flex-nowrap items-center gap-1 md:flex">detail row</div>',
      "<ManagerPortalPageShell title=\"Applications\" hideTitleOnMobileNav titleAside={headerActions}>",
      "<PortalPageHeaderMobileActionsRow actions={headerActions} />",
    ].join("\n");
    expect(inlineBandTitleAsides(ungated)).toEqual([{ tag: "ManagerPortalPageShell", gated: false }]);

    const gated = ungated.replace(
      "const headerActions = (\n  <>",
      'const headerActions = (\n  <PortalSectionActionRow className="ml-auto hidden gap-3 md:flex">',
    );
    expect(inlineBandTitleAsides(gated)).toEqual([{ tag: "ManagerPortalPageShell", gated: true }]);
  });

  it("a band-only shell renders the primary action once, from the band", () => {
    const applyButton = (
      <button type="button" data-attr="resident-applications-apply">
        Apply to property
      </button>
    );
    render(
      <ManagerPortalPageShell title="Applications" hideTitleOnMobileNav titleAside={applyButton} compactFilterRow>
        <p>body</p>
      </ManagerPortalPageShell>,
    );

    expect(screen.getAllByRole("button", { name: "Apply to property" })).toHaveLength(1);
    const band = document.querySelector('[data-slot="portal-page-title-band"]');
    expect(band).not.toBeNull();
    expect(band).toHaveAttribute("data-hide-title-on-mobile-nav");
    expect(band?.querySelector('[data-attr="resident-applications-apply"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="portal-page-header-mobile-actions"]')).toBeNull();
  });

  it("a shell with no titleAside still renders a mobile actions row passed as a child", () => {
    // `useInlineTitleBand` is false here, so the shell falls back to `PageHeader`, which
    // carries no actions — the mobile row is the only control and must survive.
    render(
      <ManagerPortalPageShell title="Documents" hideTitleOnMobileNav>
        <PortalPageHeaderMobileActionsRow
          actions={
            <button type="button" data-attr="documents-primary">
              Upload
            </button>
          }
        />
      </ManagerPortalPageShell>,
    );

    expect(document.querySelector('[data-slot="portal-page-header-mobile-actions"]')).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Upload" })).toHaveLength(1);
  });

  it("keeps a semantic h1 without a persistent visual title when navigation names the queue", () => {
    render(
      <ManagerPortalPageShell title="Residents" hideTitleOnMobileNav navigationProvidesTitle>
        <p>Resident records</p>
      </ManagerPortalPageShell>,
    );

    const heading = screen.getByRole("heading", { name: "Residents", level: 1 });
    expect(heading.className).toContain("sr-only");
    expect(document.querySelector('[data-slot="portal-page-title-band"]')).toBeNull();
    expect(document.querySelector('[data-slot="page-header"]')).toBeNull();
  });
});
