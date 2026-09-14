// @vitest-environment jsdom
/**
 * Covers the redraw of the remaining eight settings modules plus
 * Communication onto the shared settings kit (`portal-settings-ui.tsx`):
 * every section carries a scope tag, Applications/Lease put "Applies to"
 * first, every row carries a real consequence line, Communication's
 * duplicate "Send via for" editor is gone, no hand-rolled checkbox survives,
 * and "work order" never reaches rendered copy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import { DEFAULT_LIFECYCLE_AUTOMATION } from "@/lib/task-lifecycle-automation";
import { MANAGER_PORTAL_SETTINGS_TABS } from "@/lib/portal-settings-section";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import {
  ApplicationsSettingsPanel,
  LeaseSettingsPanel,
  TaskSettingsPanel,
  PaymentsSettingsPanel,
  BookingsSettingsPanel,
  InspectionsSettingsPanel,
  ServicesSettingsPanel,
  ResidentSettingsPanel,
  CommunicationSettingsPanel,
} from "@/components/portal/pro-portal-settings-panels";

const PROPERTY_OPTIONS = [{ id: "prop-1", label: "Ballard House" }];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/reminder-settings")) {
        return Response.json({ settings: {} });
      }
      if (url.includes("/api/portal/task-automation-settings")) {
        return Response.json({ automation: DEFAULT_LIFECYCLE_AUTOMATION });
      }
      if (url.includes("/api/portal/automation-settings")) {
        return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS });
      }
      if (url.includes("/api/manager/messaging-number")) {
        return new Response("missing", { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${url} (${init?.method ?? "GET"})`);
    }),
  );
}

/** Controlled wrapper so a click on a redrawn toggle is visible as a real state flip. */
function ControlledApplications() {
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [propertyIds, setPropertyIds] = useState<string[]>(["prop-1"]);
  return (
    <ApplicationsSettingsPanel
      automation={automation}
      loading={false}
      saving={false}
      propertyOptions={PROPERTY_OPTIONS}
      propertyIds={propertyIds}
      onPropertyIdsChange={setPropertyIds}
      onAutomationChange={setAutomation}
      teamMembers={[]}
    />
  );
}

function ControlledLease() {
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [propertyId, setPropertyId] = useState("prop-1");
  return (
    <LeaseSettingsPanel
      automation={automation}
      loading={false}
      saving={false}
      propertyOptions={PROPERTY_OPTIONS}
      propertyId={propertyId}
      onPropertyIdChange={setPropertyId}
      onAutomationChange={setAutomation}
      teamMembers={[]}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("settings module redraws — scope tags", () => {
  it("Applications tags both its automation and its reminders sections", async () => {
    stubFetch();
    render(<ControlledApplications />);
    expect(await screen.findByText("1 property")).toBeTruthy();
    expect(await screen.findByText("All properties")).toBeTruthy();
  });

  it("Lease tags both its automation and its reminders sections", async () => {
    stubFetch();
    render(<ControlledLease />);
    expect(await screen.findByText("1 property")).toBeTruthy();
    expect(await screen.findByText("All properties")).toBeTruthy();
  });

  it("Task, Payments, Bookings, Inspections, Services, Communication each tag their section", async () => {
    stubFetch();
    render(<TaskSettingsPanel teamMembers={[]} />);
    expect((await screen.findAllByText("All properties")).length).toBeGreaterThan(0);
    cleanup();

    render(<PaymentsSettingsPanel teamMembers={[]} />);
    expect((await screen.findAllByText("All properties")).length).toBeGreaterThan(0);
    cleanup();

    render(<BookingsSettingsPanel teamMembers={[]} />);
    expect((await screen.findAllByText("All properties")).length).toBeGreaterThan(0);
    cleanup();

    render(<InspectionsSettingsPanel teamMembers={[]} />);
    expect((await screen.findAllByText("All properties")).length).toBeGreaterThan(0);
    cleanup();

    render(<ServicesSettingsPanel teamMembers={[]} />);
    expect((await screen.findAllByText("All properties")).length).toBeGreaterThan(0);
    cleanup();

    render(<CommunicationSettingsPanel />);
    expect((await screen.findAllByText("All properties")).length).toBeGreaterThan(0);
  });

  it("Resident says plainly it has no settings of its own, tagged Informational", async () => {
    render(<ResidentSettingsPanel />);
    expect(await screen.findByText("Informational")).toBeTruthy();
    // Titled for what the section contains rather than repeating the module
    // name. Both hosts already name the module — the standalone page's own
    // heading and the gear sheet's dialog title — so a section titled
    // "Residents" inside a page titled "Residents" rendered the word twice.
    expect(screen.getByText("Where resident settings live")).toBeTruthy();
  });
});

describe("a section is never titled the same as the module that contains it", () => {
  /**
   * Both hosts already name the module: the standalone `/portal/settings/<area>`
   * page renders the rail label as its own heading, and the gear sheet's dialog
   * title comes from the settings registry. So a panel whose first section
   * repeats that name draws the word twice, one line apart -- which is exactly
   * what Bookings, Lease, Applications, Services, Inspections and Residents did.
   *
   * Tours ("Tour booking" / "Tour reminders") and Tasks ("Task reminders" /
   * "Lifecycle automation") were always right: a section is titled for what it
   * contains, not for where it lives.
   */
  it("no panel's section title is just its rail label", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-portal-settings-panels.tsx"),
      "utf8",
    );
    const sectionTitles = Array.from(source.matchAll(/title="([^"]+)"/g)).map((m) => m[1]!);
    const railLabels = MANAGER_PORTAL_SETTINGS_TABS.map((tab) => tab.label);

    const duplicated = sectionTitles.filter((title) => railLabels.includes(title));
    expect(
      duplicated,
      `these section titles repeat the module name the host already shows: ${duplicated.join(", ")}`,
    ).toEqual([]);
  });
});

describe("settings module redraws — Applies to is the first row", () => {
  function rowLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("p.text-sm.font-medium.text-foreground")).map(
      (el) => el.textContent ?? "",
    );
  }

  it("Applications renders Applies to before every other row", async () => {
    stubFetch();
    const { container } = render(<ControlledApplications />);
    await screen.findByText("Auto-approve applications");
    expect(rowLabels(container)[0]).toBe("Applies to");
  });

  it("Lease renders Applies to before every other row", async () => {
    stubFetch();
    const { container } = render(<ControlledLease />);
    await screen.findByText("Auto-generate the lease on approval");
    expect(rowLabels(container)[0]).toBe("Applies to");
  });
});

describe("settings module redraws — every row carries a real consequence line", () => {
  it("Applications rows", async () => {
    stubFetch();
    render(<ControlledApplications />);
    const meta = await screen.findByText(
      "The settings below apply only to the properties checked here.",
    );
    expect(meta.textContent).not.toBe("Applies to");
    const autoApproveMeta = await screen.findByText(
      /Approve a submitted application without reviewing it first\./,
    );
    expect(autoApproveMeta.textContent).not.toBe("Auto-approve applications");
  });

  it("Lease rows", async () => {
    stubFetch();
    render(<ControlledLease />);
    expect(
      await screen.findByText("Build the lease document as soon as an application is approved."),
    ).toBeTruthy();
    expect(await screen.findByText("Send the generated lease for signature when it is ready.")).toBeTruthy();
  });

  it("Communication's Auto-send AI drafts row", async () => {
    stubFetch();
    render(<CommunicationSettingsPanel />);
    const meta = await screen.findByText(
      /When PropLane AI finishes a draft reply, send it without waiting for Approve\./,
    );
    expect(meta.textContent).not.toBe("Auto-send AI drafts");
  });

  it("Resident's pointer rows", async () => {
    render(<ResidentSettingsPanel />);
    expect(
      await screen.findByText("Portfolio-wide payment reminder presets live under Payments settings."),
    ).toBeTruthy();
  });
});

describe("Communication — the duplicate Send via for editor is gone", () => {
  it("renders no Send via for control", async () => {
    stubFetch();
    render(<CommunicationSettingsPanel />);
    await screen.findByText("Auto-send AI drafts");
    expect(screen.queryByText("Send via for")).toBeNull();
    expect(screen.queryByText("Payment reminders")).toBeNull();
    expect(screen.queryByText("Tour reminders")).toBeNull();
  });
});

describe("no hand-rolled checkbox survives in the redrawn file", () => {
  it("never emits the legacy checkbox class", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-portal-settings-panels.tsx"),
      "utf8",
    );
    expect(source).not.toContain("mt-0.5 h-4 w-4 shrink-0 accent-primary");
  });
});

describe("service copy says Service visit, never Work order", () => {
  it("Services panel renders Service visit copy and never Work order", async () => {
    stubFetch();
    const { container } = render(<ServicesSettingsPanel teamMembers={[]} />);
    await waitFor(() => expect(container.textContent).toContain("Service visit"));
    expect(container.textContent).not.toContain("Work order");
  });
});

describe("converted toggles are real switches", () => {
  it("Applications' Auto-approve applications flips", async () => {
    stubFetch();
    render(<ControlledApplications />);
    const toggle = await screen.findByRole("switch", { name: "Auto-approve applications" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("Lease's Auto-generate the lease on approval flips", async () => {
    stubFetch();
    render(<ControlledLease />);
    const toggle = await screen.findByRole("switch", { name: "Auto-generate the lease on approval" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("Communication's Auto-send AI drafts flips", async () => {
    stubFetch();
    render(<CommunicationSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: "Auto-send AI drafts" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });
});
