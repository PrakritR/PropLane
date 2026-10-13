// @vitest-environment jsdom
/**
 * Source + render guard for AGENTS.md § No subtext on the create/edit pop-up shell (round 3 of the
 * portal sweep). A pop-up is labels and controls:
 *
 *  1. the step rail names the step and ticks it done — no caption under the name,
 *  2. the preview column shows the record — no "This will create" checklist,
 *  3. a field label carries no "Optional" marker (required keeps its own mark),
 *  4. an upload control carries no file-type / size chips (a wrong pick gets an error instead),
 *  5. a step heading that repeats the dialog title is not drawn.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DialogTitleProvider } from "@/components/ui/dialog-title-context";
import { StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";

afterEach(cleanup);

const ROOT = join(__dirname, "..", "..");
const COMPONENTS = join(ROOT, "src", "components");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

const FILES = walk(COMPONENTS).map((file) => ({ file: relative(ROOT, file), source: readFileSync(file, "utf8") }));

/** Comments are prose about the rule, not the UI. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const SHELL_FILES = [
  "src/components/portal/listing-wizard-v2/wizard-primitives.tsx",
  "src/components/portal/add-workspace/parts.tsx",
  "src/components/portal/add-workspace/upload-action.tsx",
  "src/components/ui/modal.tsx",
  "src/components/ui/popup-form-context.tsx",
  "src/components/ui/wizard-shell.tsx",
];

describe("pop-up step rail: a name and a tick, no caption", () => {
  it("StepRailItem declares no summary / caption / description", () => {
    const source = read("src/components/portal/listing-wizard-v2/wizard-primitives.tsx");
    const start = source.indexOf("export type StepRailItem = {");
    const block = source.slice(start, source.indexOf("\n};", start));
    expect(block).not.toMatch(/\b(summary|caption|description|subtitle|hint)\??:/);
    expect(code(source)).not.toMatch(/step\.(summary|caption|description)/);
  });

  it("no step definition carries a summary", () => {
    const offenders = FILES.filter(({ source }) => /\{\s*id:\s*[^,{}]+,\s*label:[^{}]*\bsummary\s*:/.test(code(source))).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("the old rail captions are gone from every step definition", () => {
    const offenders = FILES.filter(({ source }) => /label:[^\n]*(?:summary|caption)[^\n]*"(?:What to do|Off this add|No property yet|Choose a file|Set the terms)"/.test(code(source))).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});

describe("pop-up preview column: no 'This will create' checklist", () => {
  it("PreviewPanel takes no creates list", () => {
    const source = read("src/components/portal/add-workspace/parts.tsx");
    const start = source.indexOf("export function PreviewPanel(");
    const block = source.slice(start, source.indexOf("}) {", start));
    expect(block).not.toMatch(/\bcreates\w*\??:/);
    expect(source).not.toMatch(/export type CreatesItem/);
  });

  it("no pop-up passes creates / createsHeading or prints a 'This will …' heading", () => {
    const offenders = FILES.filter(({ source }) => /\bcreates(?:Heading)?=[{"]|"This will (?:create|send)"|"Save will"|"On import"/.test(code(source))).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});

describe("pop-up fields: no 'Optional' marker", () => {
  it("the shell labels print no Optional tag", () => {
    for (const path of SHELL_FILES) {
      const source = code(read(path));
      expect(source, path).not.toMatch(/data-field-optional/);
      expect(source, path).not.toMatch(/>\s*Optional\s*</);
    }
  });

  it("no pop-up label carries (optional)", () => {
    const popups = FILES.filter(({ file }) => /product-mock\/demo-popups-|portal\/(?:pro-task-form-modal|pro-vendor-form-modal|portal-record-share-modal|manager-invite-link-modal|lease-mark-signed-modal|promotion-text-generate-modal|send-lead-listing-wizard|vendor-tax-profile-modal|resident-other-documents|promotion-form|property-resident-onboard-wizard)\.tsx$/.test(file));
    expect(popups.length).toBeGreaterThan(10);
    const offenders = popups.filter(({ source }) => /\(optional\)|" \(optional\)"/i.test(code(source))).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("the Add property label has no optional prop", () => {
    expect(code(read("src/components/portal/pro-add-listing-form.tsx"))).not.toMatch(/<FieldLabel optional/);
  });
});

describe("pop-up uploads: no file-type or size chips", () => {
  it("the file card takes no chips and prints none", () => {
    const source = code(read("src/components/portal/add-workspace/upload-action.tsx"));
    expect(source).not.toMatch(/\bchips\b|acceptChips|FILE_CHIPS/);
  });

  it("no caller passes chips to a file card or header upload", () => {
    const offenders = FILES.filter(({ source }) => /WorkspaceFileCard|headerUpload|FileStartStrip|ImportFileStrip/.test(source) && /\bchips[=:]|_FILE_CHIPS/.test(code(source)) && !/PortalActiveFilterChips/.test(source)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("no upload drop zone states a size or format hint", () => {
    const offenders = FILES.filter(({ source }) => />\s*(?:JPG, PNG, or PDF · up to \d+ MB|PDF only · up to \d+ MB|Click to choose a file · up to \d+ MB)\s*</.test(source)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});

describe("a step heading that repeats the dialog title is not drawn", () => {
  it("drops the heading when it equals the dialog title (any case)", () => {
    render(
      <DialogTitleProvider title="Send a form">
        <StepHeading title="send a form" />
        <p>body</p>
      </DialogTitleProvider>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("keeps a heading that says something else, and one with an action", () => {
    render(
      <DialogTitleProvider title="Send a form">
        <StepHeading title="Details" />
        <StepHeading title="Send a form" action={<button type="button">Add</button>} />
      </DialogTitleProvider>,
    );
    expect(screen.getByRole("heading", { name: "Details" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Send a form" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("draws every heading outside a dialog", () => {
    render(<StepHeading title="Send a form" />);
    expect(screen.getByRole("heading", { name: "Send a form" })).toBeTruthy();
  });
});
