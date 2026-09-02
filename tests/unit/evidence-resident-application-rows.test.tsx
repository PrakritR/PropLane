// @vitest-environment jsdom
//
// EVIDENCE HARNESS (resident audit F7).
//
// Two applications for the SAME room rendered byte-identical rows — same name,
// same property, same room — so a resident could not tell which was which, or
// which one a click would open. The dedupe half of the finding does not
// reproduce (both apply doors resume an existing in-progress application), so
// the remedy taken was the finding's other one: make the rows distinguishable
// by status, date and id.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/applications/apply",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "jamie.rivera@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
  replaceManagerApplicationRowInCache: () => {},
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/resident-public-nav", () => ({ residentBrowseFromApplicationHref: () => "/rent/browse" }));
vi.mock("@/components/portal/manager-applications", () => ({
  applicationPdfHref: () => "/api/manager-applications/test/pdf?disposition=inline",
}));
vi.mock("@/components/portal/resident-application-editor", () => ({ ResidentApplicationEditor: () => null }));
vi.mock("@/components/marketing/rental-application-wizard", () => ({
  RentalApplicationWizard: () => <div data-testid="rental-wizard" />,
}));

import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

/** Two applications, same person, same property, same room. */
function rows(): DemoApplicantRow[] {
  const base = {
    name: "Jamie Rivera",
    email: "jamie.rivera@example.com",
    property: "Magnolia House",
    propertyId: "mgr-test-magnolia",
    application: { propertyId: "mgr-test-magnolia", email: "jamie.rivera@example.com", roomLabel: "Room 2" },
  };
  return [
    { ...base, id: "PROPLANE-AAAA0001", stage: "In progress", bucket: "pending", detail: "Started 8/1/2026, 7:48:40 PM" },
    { ...base, id: "PROPLANE-BBBB0002", stage: "Submitted", bucket: "pending", detail: "Submitted 8/3/2026, 5:24:39 PM" },
  ] as DemoApplicantRow[];
}

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
afterEach(cleanup);
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

describe("F7 — two applications for one room must not render identically", () => {
  it("gives each row its status and when it was started", async () => {
    ROWS = rows();
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<ResidentApplicationsPanel applyMode />);
    });
    captured.push({
      name: "f7-resident-application-rows",
      html: (view.container.firstElementChild as HTMLElement).innerHTML,
    });

    // These lists render as DataList card rows, not a <tbody> table — the
    // assertion is about what a resident can READ on each row, so read the rows.
    const rowText = Array.from(
      view.container.querySelectorAll('[data-slot="data-list-mobile-row"]'),
    ).map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());
    console.log("\nF7 evidence — resident application rows\n" + rowText.map((t) => `    ${t}`).join("\n") + "\n");

    expect(rowText).toHaveLength(2);
    expect(rowText[0]).not.toBe(rowText[1]);
    expect(rowText.join(" ")).toContain("Started 8/1/2026, 7:48:40 PM");
    expect(rowText.join(" ")).toContain("Submitted 8/3/2026, 5:24:39 PM");
  });
});
