// @vitest-environment jsdom
/**
 * Render regression + evidence harness: drives the REAL manager property
 * Lease panel through add / delete / re-sync and writes the rendered markup to
 * EVIDENCE_DIR (when set) so it can be screenshotted in a browser.
 */
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { writeFileSync, mkdirSync } from "node:fs";
import { vi } from "vitest";

vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "property-pipeline-changed",
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  // The resident document-import modal now mounts inside this panel's tree and
  // reads the manager's listings for its property picker. Without it the whole
  // panel throws on mount, which reads as a lease-template failure.
  readExtraListingsForUser: () => [],
}));

let PERSISTED: unknown = null;
vi.mock("@/lib/manager-property-save-target", () => ({
  persistManagerListingSubmission: (_t: unknown, _u: unknown, next: unknown) => {
    PERSISTED = next;
    return true;
  },
  resolveManagerListingSubmissionForPropertyId: () => null,
}));

import { ManagerPropertyLeasePanel } from "@/components/portal/manager-property-lease-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  addLeaseTemplateFromSeed,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

// Same convention as `evidence-pinned-footer.test.tsx`: the render is
// always exercised, the HTML is only written when EVIDENCE_DIR asks for it.
const OUT = process.env.EVIDENCE_DIR ?? "";

function writePanel(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:900px;margin:24px auto;padding:0 16px">
  <p style="font:600 13px/1.4 system-ui;color:#64748b;margin:0 0 10px">${caption}</p>
  <div class="rounded-2xl border border-border bg-card p-4">${body}</div>
</div></body></html>`,
  );
}

/**
 * Labels of the lease rows the property actually holds.
 *
 * Scoped to the list because a deleted default comes BACK as an "add this
 * lease" suggestion — that is the opt-in behavior, not a row that survived, so
 * a container-wide text search would read it as a failed delete.
 */
function leaseRowLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLLabelElement>("label:has(input[data-attr^=\"property-lease-select-\"])"),
  ).map((label) => label.querySelector("p")?.textContent?.trim() ?? "");
}

function selectLeaseRowByLabel(container: HTMLElement, label: string) {
  const row = Array.from(
    container.querySelectorAll<HTMLLabelElement>("label:has(input[data-attr^=\"property-lease-select-\"])"),
  ).find((el) => el.querySelector("p")?.textContent?.trim() === label);
  if (!row) throw new Error(`lease row not found: ${label}`);
  const checkbox = row.querySelector<HTMLInputElement>("input[type=\"checkbox\"]");
  if (!checkbox) throw new Error(`lease checkbox not found: ${label}`);
  fireEvent.click(checkbox);
}

/** Panel + a live `sub` so a Delete inside the modal really updates the list. */
function Harness({ initial }: { initial: ManagerListingSubmissionV1 }) {
  const [sub, setSub] = useState(initial);
  return (
    <ManagerPropertyLeasePanel
      sub={sub}
      saveTarget={{ mode: "listing", saveId: "mgr-evidence-house" }}
      managerUserId="mgr-1"
      propertyId="mgr-evidence-house"
      propertyLabel="5259 Brooklyn Ave NE"
      onUpdated={() => {
        if (PERSISTED) setSub(PERSISTED as ManagerListingSubmissionV1);
      }}
      showToast={() => {}}
    />
  );
}

describe("evidence · lease templates are opt-in", () => {
  it("renders a fresh property, an added format, and a delete that sticks", async () => {
    // The Delete affordance asks for confirmation; jsdom has no confirm().
    window.confirm = () => true;
    // A. brand-new property — sync must not conjure the old four rows
    const fresh = syncPropertyLeaseTemplatesFromListing(createDefaultListingSubmission());
    const a = render(<Harness initial={fresh} />);
    expect(a.container.querySelectorAll('[data-attr^="property-lease-select-"]')).toHaveLength(0);
    writePanel(
      "lease-a-empty",
      "A · New property → Lease tab. No lease formats are auto-created; the manager adds one explicitly.",
      a.container.innerHTML,
    );
    a.unmount();

    // B. manager adds both defaults
    const withBoth = addLeaseTemplateFromSeed(
      addLeaseTemplateFromSeed(fresh, "primary"),
      "short-term",
    );
    const b = render(<Harness initial={withBoth} />);
    expect(leaseRowLabels(b.container)).toEqual(["Long-term lease", "Short-term lease"]);
    writePanel(
      "lease-b-added",
      "B · After adding the two PropLane defaults — 'Long-term lease' and 'Short-term lease' (the retired 'Lease bundle' rows are gone).",
      b.container.innerHTML,
    );

    // C. delete Short-term through bulk Edit → Delete flow, then re-sync
    selectLeaseRowByLabel(b.container, "Short-term lease");
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-attr="property-lease-bulk-edit"]')!);
    });
    const del = document.querySelector<HTMLButtonElement>('button[data-attr="property-lease-delete"]')!;
    await act(async () => {
      fireEvent.click(del);
    });
    expect(leaseRowLabels(b.container)).toEqual(["Long-term lease"]);
    writePanel(
      "lease-c-deleted",
      "C · Deleted 'Short-term lease' from the Edit modal. The row is gone and a re-sync no longer resurrects it — this is the bug the change fixes.",
      b.container.innerHTML,
    );
    b.unmount();

    // D. prove the deletion survives the next sync (what used to undo it)
    const resynced = syncPropertyLeaseTemplatesFromListing(
      PERSISTED as ManagerListingSubmissionV1,
    );
    const d = render(<Harness initial={resynced} />);
    expect(leaseRowLabels(d.container)).toEqual(["Long-term lease"]);
    writePanel(
      "lease-d-resynced",
      "D · Same property re-opened after syncPropertyLeaseTemplatesFromListing ran again. Still one format — Delete stuck.",
      d.container.innerHTML,
    );
    d.unmount();
  });
});
