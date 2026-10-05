// @vitest-environment jsdom
//
// EVIDENCE HARNESS for the part of studio plan claude-1/mobile-step-tabs-1004
// that only had assertions, never a picture: the three leasing lists of the
// listing editor each show EXACTLY TWO stay sections — Long term and Short
// term — and never a "Both" section.
//
//   1. Application — two sections; a form that applies to both stays is listed
//      in each one, with its own ★ Default per stay;
//   2. the application form itself — "Application name" is its first field and
//      Applies to / Default for … are FORM fields, not menu items;
//   3. Lease — same two sections, a short-term lease only under Short term;
//   4. Move-in — same two sections, an "All lease types" form listed in both.
//
// Same contract as every other evidence-* harness: without EVIDENCE_DIR this is
// a plain render test and writes nothing.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderedBodyHtml } from "../helpers/evidence-dom";
import { MOVE_IN_FORM_STARTERS } from "@/lib/move-in-forms/templates";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string; caption: string }[] = [];
function capture(name: string, caption: string) {
  if (!EVIDENCE_DIR) return;
  captured.push({ name, html: renderedBodyHtml(), caption });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html, caption } of captured) {
    writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
    writeFileSync(join(EVIDENCE_DIR, `${name}.caption.txt`), caption, "utf8");
  }
});

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
  readAdminPropertyRows: vi.fn(() => []),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const showToast = vi.fn();

function sub() {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "400 Pike Street",
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1100 }],
  };
}
/** Basics › Stays you offer with both ticked, so every stay section is drawn. */
const bothStays = () => ({ ...sub(), shortTermRentalsAllowed: true, allowedLeaseTerms: ["Long-term", "Short-Term Stay"] });

function mountLive(initial: Record<string, unknown> = sub()) {
  function Harness() {
    const [value, setValue] = React.useState(initial as ReturnType<typeof sub>);
    return (
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingEditorV2
          title="400 Pike Street"
          submission={value}
          onChange={(next) => setValue(next as ReturnType<typeof sub>)}
          onClose={() => {}}
          onPublish={() => {}}
          managerUserId="manager-1"
          showToast={showToast}
        />
      </PortalAssistantConfigProvider>
    );
  }
  render(<Harness />);
}

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const qa = (selector: string) => Array.from(document.querySelectorAll(selector)) as HTMLElement[];
const go = (id: string) => fireEvent.click(q(`[data-attr='listing-v2-rail-${id}']`)!);
const sectionNames = (section: string, kind: string) =>
  qa(`[data-attr='listing-v2-stay-section-${section}'] [data-attr='listing-v2-${kind}-card'] input`).map(
    (input) => (input as HTMLInputElement).value,
  );
/** Both stay sections are drawn and a "Both" section never is. */
function expectTwoSectionsOnly() {
  expect(q("[data-attr='listing-v2-stay-section-long_term']")).not.toBeNull();
  expect(q("[data-attr='listing-v2-stay-section-short_term']")).not.toBeNull();
  expect(q("[data-attr='listing-v2-stay-section-both']")).toBeNull();
}

beforeEach(() => {
  showToast.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ leasingPipeline: { applicationBeforeTour: "required" } }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Application list", () => {
  it("is Long term and Short term only, and the form carries Applies to / Default", () => {
    mountLive(bothStays());
    go("application");
    expectTwoSectionsOnly();
    expect(document.body.textContent).not.toMatch(/\bBoth\b/);
    capture(
      "two-stay-application-list",
      "Manager · Add property › Application — exactly two stay sections, Long term and Short term. There is no “Both” section: a form for both stays is listed under each.",
    );

    // The form: Application name first, then Applies to and the per-stay default.
    fireEvent.click(
      qa("[data-attr='listing-v2-stay-section-long_term'] [data-attr='listing-v2-application-card']")[0]!.querySelector(
        "[data-attr='listing-v2-card-open']",
      )!,
    );
    const editor = q("[data-attr='listing-v2-application-editor']")!;
    expect(editor.textContent).toContain("Applies to");
    expect(editor.textContent).toMatch(/Default for/);
    expect(screen.queryByRole("dialog")).toBeNull();
    capture(
      "two-stay-application-form",
      "Manager · the application form itself — “Application name” is its first field, and Applies to / Default for … are form fields in the card, never menu items. It unfolds in place; no modal.",
    );
  });
});

describe("the Lease list", () => {
  it("files a short-term lease under Short term and long-term ones under Long term", () => {
    const leaseRow = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
      id,
      kind: "long-term",
      label,
      leaseConfigMode: "standard",
      leaseCustomKind: "terms",
      customLeaseTerms: "",
      leaseTemplateDocUrl: null,
      leaseTemplateDocName: "",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      ...extra,
    });
    mountLive({
      ...bothStays(),
      propertyLeaseTemplates: [
        leaseRow("l1", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term"] }),
        leaseRow("l2", "Short-term lease", { kind: "short-term", listingSeedKey: "short-term", applicationLeaseTerms: ["Short-Term Stay"] }),
        leaseRow("l3", "Time based", { kind: "time-based" }),
      ],
    });
    go("lease");
    expectTwoSectionsOnly();
    expect(sectionNames("long_term", "lease")).toEqual(["Long-term lease", "Time based"]);
    expect(sectionNames("short_term", "lease")).toEqual(["Short-term lease"]);
    capture(
      "two-stay-lease-list",
      "Manager · Add property › Lease — the same two sections. Month-to-month / time-based leases fold into Long term; the short-term lease is the only Short term row.",
    );
  });
});

describe("the Move-in list", () => {
  it("lists an All-lease-types form in both sections and keeps the per-stay ones apart", () => {
    mountLive({
      ...bothStays(),
      moveInFormTemplates: [
        { ...structuredClone(MOVE_IN_FORM_STARTERS[0]!), id: "mi-all", name: "Everyone", trigger: "manual" as const },
        { ...structuredClone(MOVE_IN_FORM_STARTERS[1] ?? MOVE_IN_FORM_STARTERS[0]!), id: "mi-long", name: "Long only", leaseType: "long-term" as const, trigger: "manual" as const },
        { ...structuredClone(MOVE_IN_FORM_STARTERS[1] ?? MOVE_IN_FORM_STARTERS[0]!), id: "mi-short", name: "Short only", leaseType: "short-term" as const, trigger: "manual" as const },
      ],
    });
    go("movein");
    expectTwoSectionsOnly();
    expect(sectionNames("long_term", "movein")).toEqual(["Everyone", "Long only"]);
    expect(sectionNames("short_term", "movein")).toEqual(["Everyone", "Short only"]);
    capture(
      "two-stay-movein-list",
      "Manager · Add property › Move-in — two sections again. “Everyone” applies to both stays, so it is listed in each; there is still no “Both” section.",
    );
  });
});
