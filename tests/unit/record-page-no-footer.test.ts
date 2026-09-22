// A record page has no footer and no toolbar (PLAN-0921-1029, area 1;
// docs/agents/record-page.md). `PortalRecordDetailPage` no longer has a
// `footer` prop at all, a record section body never grows its own row of
// labelled buttons (a dialog or sheet's own commit button is the one
// exception), and a record page's header actions are icons, never labelled
// buttons. This reads source rather than rendering, the same pattern as
// tests/unit/portal-list-rows-no-pills.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsxFiles(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Every `<PortalRecordDetailPage ...props... >` opening-tag block in a file's source. */
function recordDetailPageOpenTags(src: string): string[] {
  const blocks: string[] = [];
  const re = /<PortalRecordDetailPage\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index, m.index + 4000);
    const close = rest.match(/\n\s*>\n/);
    blocks.push(close ? rest.slice(0, close.index! + close[0].length) : rest.slice(0, 1500));
  }
  return blocks;
}

describe("PortalRecordDetailPage has no footer prop anywhere", () => {
  const files = listTsxFiles(PORTAL_DIR);
  for (const file of files) {
    const rel = file.slice(process.cwd().length + 1);
    const src = readFileSync(file, "utf8");
    if (!src.includes("<PortalRecordDetailPage")) continue;
    it(`${rel} passes no footer= to PortalRecordDetailPage`, () => {
      const blocks = recordDetailPageOpenTags(stripComments(src));
      for (const block of blocks) {
        expect(block, `${rel} still passes footer= to a PortalRecordDetailPage call`).not.toMatch(/\bfooter=/);
      }
    });
  }
});

/**
 * The shared record shell and the Residents record page — the standard other
 * kinds copy (docs/agents/record-page.md). Neither renders a plain-text
 * "<button>Label</button>" toolbar control; a row that happens to be
 * clickable wraps rich content (an icon, a title, a sub-line), never a bare
 * text label. Per-kind panels that still publish a labelled action row into
 * the header through `PortalRecordActions` (background checks, add-on
 * service requests, lease actions — see record-page.md "Known gap") are
 * deliberately out of this list: redesigning those shared feature
 * components to icons is later-wave, per-kind work, not shared shell.
 */
const RECORD_SHELL_SOURCES = [
  "src/components/portal/portal-record-overview-kit.tsx",
  "src/components/portal/portal-record-detail-page.tsx",
  "src/components/portal/portal-record-section-chrome.tsx",
  "src/components/portal/pro-resident-overview-panel.tsx",
];

// A plain-text button: the tag's entire content is a text run, no nested
// element (an icon, a span) inside it — that shape is a toolbar control, not
// a clickable row wrapping rich content.
const PLAIN_TEXT_BUTTON = /<button\b[^>]*>\s*[A-Za-z][^<{]*\s*<\/button>/;

describe("the record shell and the Residents standard render no labelled toolbar button", () => {
  for (const file of RECORD_SHELL_SOURCES) {
    it(file, () => {
      const src = stripComments(readFileSync(join(process.cwd(), file), "utf8"));
      const m = src.match(PLAIN_TEXT_BUTTON);
      expect(m, `${file} renders a labelled <button>: ${m?.[0]}`).toBeNull();
    });
  }
});

/**
 * Files converted off the removed `footer` prop onto icon-only header
 * actions (docs/agents/record-page.md). Each `<PortalRecordActions>` block
 * in these files must publish `PortalIconAction`s (or a component that
 * itself renders one, like `ApplicationPdfDownloadButton icon`), never a
 * labelled `<Button>`.
 */
const ICON_ONLY_HEADER_ACTION_SOURCES = [
  "src/components/portal/resident-documents-panel.tsx",
  "src/components/portal/resident-lease-panel.tsx",
  "src/components/portal/pro-account-links-panel.tsx",
];

function recordActionsBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /<PortalRecordActions\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    const close = rest.indexOf("</PortalRecordActions>");
    blocks.push(close === -1 ? rest.slice(0, 2000) : rest.slice(0, close));
  }
  return blocks;
}

describe("header actions converted off the footer prop stay icon-only", () => {
  for (const file of ICON_ONLY_HEADER_ACTION_SOURCES) {
    it(file, () => {
      const src = stripComments(readFileSync(join(process.cwd(), file), "utf8"));
      const blocks = recordActionsBlocks(src);
      expect(blocks.length, `${file} has no PortalRecordActions block to check`).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block, `${file} publishes a labelled <Button> into a record header action slot`).not.toMatch(
          /<Button\b/,
        );
      }
    });
  }
});

/**
 * PLAN-0921-1029, area 2, point 3: the three shared feature components
 * record-page.md's "Known gap" named as still publishing a labelled footer —
 * background-check screening actions, add-on service request actions, and
 * lease actions — are converted off `<Button>` onto `PortalIconAction`. These
 * publish through a callback (`onHeaderActionsChange` / `onFooterActionsChange`)
 * to their parent's own `<PortalRecordActions>` rather than rendering that
 * wrapper themselves, so this checks the whole file (lease-primary-header-actions
 * never renders `<Button>` at all) or the specific action-list constant (the
 * other two) instead of `recordActionsBlocks`.
 */
describe("the three known-gap feature components publish icon-only actions", () => {
  it("src/components/portal/lease-primary-header-actions.tsx renders no labelled <Button>", () => {
    const src = stripComments(readFileSync(join(process.cwd(), "src/components/portal/lease-primary-header-actions.tsx"), "utf8"));
    expect(src).not.toMatch(/<Button\b/);
  });

  it("src/components/portal/pro-service-request-detail.tsx's detailActions publish icon-only", () => {
    const src = stripComments(readFileSync(join(process.cwd(), "src/components/portal/pro-service-request-detail.tsx"), "utf8"));
    const start = src.indexOf("const detailActions = (");
    expect(start, "detailActions constant not found").toBeGreaterThan(-1);
    const end = src.indexOf("\n  );", start);
    const block = src.slice(start, end === -1 ? start + 3000 : end);
    expect(block, "pro-service-request-detail.tsx publishes a labelled <Button> in detailActions").not.toMatch(/<Button\b/);
  });

  it("src/components/portal/application-screening-panel.tsx's parent-placement header actions publish icon-only", () => {
    const src = stripComments(readFileSync(join(process.cwd(), "src/components/portal/application-screening-panel.tsx"), "utf8"));
    const start = src.indexOf('headerActionsPlacement === "parent" ? (');
    expect(start, "parent-placement branch not found").toBeGreaterThan(-1);
    const end = src.indexOf(") : (", start);
    const block = src.slice(start, end === -1 ? start + 2000 : end);
    expect(block, "application-screening-panel.tsx publishes a labelled <Button> for the parent record-page slot").not.toMatch(/<Button\b/);
  });
});
