// @vitest-environment jsdom
/**
 * Covers the redraw of the remaining eight settings modules plus
 * Communication onto the shared settings kit (`portal-settings-ui.tsx`):
 * every section carries a scope tag, every row carries a real consequence
 * line, Communication's duplicate "Send via for" editor is gone, no
 * hand-rolled checkbox survives, and "work order" never reaches rendered
 * copy.
 *
 * PLAN-0920-0845 phase D moved property scope out of Applications/Lease's own
 * "Applies to" row (`PropertyScopeRow`, removed) and into the module's own
 * `SettingsScopeBar`, mounted one level up by the host — so this file's own
 * `PROPERTY_SCOPE` wrapper stands in for that host, and the old "Applies to
 * is the first row" contract is gone with the row it tested.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReactNode, useState } from "react";
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
import { SettingsPropertyScopeProvider } from "@/components/portal/settings-property-scope";

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

// The automation-settings read now goes through the shared cache
// (`manager-automation-settings-client.ts`), which is keyed on the viewer id
// this hook supplies — without it a panel's load effect no-ops forever.
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: "manager@example.com", userId: "mgr-1" }),
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
import { invalidateManagerAutomationSettingsCache } from "@/lib/manager-automation-settings-client";

const PROPERTY_OPTIONS = [{ id: "prop-1", label: "Ballard House" }];

/**
 * Every settings route accepts `?propertyId=`; this stand-in resolver returns
 * `source: "property"` exactly when one rides the query, `"account"`
 * otherwise — the same two-value range the real per-namespace resolver can
 * return, without needing a seeded property override to exercise it.
 */
function sourceForUrl(url: string): "property" | "account" {
  return new URL(url, "http://localhost").searchParams.has("propertyId") ? "property" : "account";
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/reminder-settings")) {
        return Response.json({ settings: {}, source: sourceForUrl(url) });
      }
      if (url.includes("/api/portal/automated-messages")) {
        return Response.json({ settings: {}, defaults: {}, source: sourceForUrl(url) });
      }
      if (url.includes("/api/portal/service-automation-settings")) {
        return Response.json({ settings: {}, source: sourceForUrl(url) });
      }
      if (url.includes("/api/portal/task-automation-settings")) {
        return Response.json({ automation: DEFAULT_LIFECYCLE_AUTOMATION, source: sourceForUrl(url) });
      }
      if (url.includes("/api/portal/automation-settings")) {
        return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS, source: sourceForUrl(url) });
      }
      if (url.includes("/api/manager/messaging-number")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("/api/manager/assistant-email")) {
        return new Response("missing", { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${url} (${init?.method ?? "GET"})`);
    }),
  );
}

/**
 * Stands in for the module host (`settings-module-page.tsx` and friends),
 * which is what actually mounts `SettingsPropertyScopeProvider` around a
 * panel in the real app. `propertyIds` mirrors the bar's selection.
 */
function withScope(node: ReactNode, propertyIds: string[] = []) {
  return (
    <SettingsPropertyScopeProvider
      workspaceId=""
      onWorkspaceIdChange={() => {}}
      propertyIds={propertyIds}
      onPropertyIdsChange={() => {}}
      options={PROPERTY_OPTIONS}
    >
      {node}
    </SettingsPropertyScopeProvider>
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
  // The shared automation-settings read cache (N032) is module-level and
  // outlives a single test's render.
  invalidateManagerAutomationSettingsCache();
});

describe("settings module redraws — scope tags", () => {
  it("Applications tags both its reminders and its messages-sent sections", async () => {
    stubFetch();
    render(withScope(<ControlledApplications />, ["prop-1"]));
    expect((await screen.findAllByText("Own values on 1 property")).length).toBeGreaterThanOrEqual(2);
  });

  it("Lease tags its Ending/Move-in/Move-out/Reminders and messages-sent sections", async () => {
    stubFetch();
    render(withScope(<ControlledLease />, ["prop-1"]));
    expect((await screen.findAllByText("Own values on 1 property")).length).toBeGreaterThanOrEqual(2);
  });

  it("Task, Bookings, Inspections, Services, Communication each tag their section as Account when no house is picked", async () => {
    stubFetch();
    render(withScope(<TaskSettingsPanel teamMembers={[]} />));
    expect((await screen.findAllByText("Account")).length).toBeGreaterThan(0);
    cleanup();

    render(<PaymentsSettingsPanel teamMembers={[]} />);
    // PLAN-0920-0845 phase E dropped the "Settings" area dropdown — every
    // area is now a stacked, always-visible section.
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect((await screen.findAllByText("Payment setup")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Processing fee").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Late fees").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Incoming reminders").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Outgoing reminders").length).toBeGreaterThan(0);
    cleanup();

    render(withScope(<BookingsSettingsPanel teamMembers={[]} />));
    expect((await screen.findAllByText("Account")).length).toBeGreaterThan(0);
    cleanup();

    render(withScope(<InspectionsSettingsPanel teamMembers={[]} />));
    expect((await screen.findAllByText("Account")).length).toBeGreaterThan(0);
    cleanup();

    render(withScope(<ServicesSettingsPanel teamMembers={[]} />));
    expect((await screen.findAllByText("Account")).length).toBeGreaterThan(0);
    cleanup();

    render(withScope(<CommunicationSettingsPanel />));
    expect((await screen.findAllByText("Account")).length).toBeGreaterThan(0);
  });

  it("Resident settings is the welcome message, tagged Account when no house is picked", async () => {
    stubFetch();
    render(
      withScope(
        <ResidentSettingsPanel
          propertyOptions={PROPERTY_OPTIONS}
          selectedPropertyId="prop-1"
          onPropertyIdChange={() => {}}
          area="household"
          onAreaChange={() => {}}
          teamMembers={[]}
        />,
      ),
    );
    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeTruthy();
    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ballard House" })).toBeNull();
    expect(screen.queryByRole("button", { name: "House" })).toBeNull();
    expect(screen.queryByText("Informational")).toBeNull();
    expect(screen.queryByText(/no settings of its own/i)).toBeNull();
  });
});

describe("a section is never titled the same as the module that contains it", () => {
  /**
   * Both hosts already name the module: the Profile hub pane
   * page renders the rail label as its own heading, and the gear sheet's dialog
   * title comes from the settings registry. So a panel whose first section
   * repeats that name draws the word twice, one line apart -- which is exactly
   * what Bookings, Lease, Applications, Services, Inspections and Residents did.
   *
   * Tours, Tasks, Bookings, and Communication now title sections for what they
   * contain (Booking, Reminders, Automation) rather than repeating the rail.
   * "Reminders" is also the automation-hub rail label; that noun is allowed on
   * other modules because the page heading there is Bookings / Tours / Lease,
   * not Reminders.
   */
  it("no panel's section title is just its rail label", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-portal-settings-panels.tsx"),
      "utf8",
    );
    const sectionTitles = Array.from(source.matchAll(/title="([^"]+)"/g)).map((m) => m[1]!);
    const railLabels = MANAGER_PORTAL_SETTINGS_TABS.map((tab) => tab.label);
    const contentNounsSharedAcrossModules = new Set(["Reminders"]);

    const duplicated = sectionTitles.filter(
      (title) => railLabels.includes(title) && !contentNounsSharedAcrossModules.has(title),
    );
    expect(
      duplicated,
      `these section titles repeat the module name the host already shows: ${duplicated.join(", ")}`,
    ).toEqual([]);

    const hub = readFileSync(
      join(process.cwd(), "src/components/portal/pro-portal-automation-settings-panel.tsx"),
      "utf8",
    );
    expect(hub).not.toMatch(/title="Reminders"/);
  });
  it("module sections do not repeat the tab name in the title", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-portal-settings-panels.tsx"),
      "utf8",
    );
    expect(source).not.toContain('title="Inbox automation"');
    expect(source).not.toContain('title="Booking reminders"');
    expect(source).not.toContain('title="Application reminders"');
    expect(source).not.toContain('title="Application handling"');
    expect(source).not.toContain('title="Task reminders"');
    expect(source).not.toContain('title="Inspection reminders"');
    expect(source).not.toContain('title="Tour reminders"');
    expect(source).not.toContain('title="Tour booking"');
    expect(source).not.toContain('title="Visit reminders"');
    expect(source).not.toContain('title="Signing reminders"');
    expect(source).not.toContain('title="Outgoing payment reminders"');
    expect(source).not.toContain('title="Lease ending"');
    expect(source).not.toContain('title="Lease documents"');
    expect(source).not.toContain("PortalSettingsScopeTag>All properties");
  });
});

describe("settings module redraws — no Applies to row (scope moved to the module's SettingsScopeBar)", () => {
  it("Applications renders no Applies to row of its own", async () => {
    stubFetch();
    render(withScope(<ControlledApplications />, ["prop-1"]));
    await screen.findByText("Auto-approve applications");
    expect(screen.queryByText("Applies to")).toBeNull();
  });

  it("Lease renders no Applies to row of its own", async () => {
    stubFetch();
    render(withScope(<ControlledLease />, ["prop-1"]));
    await screen.findByText("Auto-generate the lease on approval");
    expect(screen.queryByText("Applies to")).toBeNull();
  });
});

describe("settings module redraws — every row is a label and its control, nothing under it", () => {
  it("Applications rows", async () => {
    stubFetch();
    render(withScope(<ControlledApplications />, ["prop-1"]));
    expect(await screen.findByText("Auto-approve applications")).toBeTruthy();
    expect(screen.queryByText("The settings below apply only to the properties checked here.")).toBeNull();
    expect(screen.queryByText(/Approve a submitted application without reviewing it first\./)).toBeNull();
  });

  it("Lease rows", async () => {
    stubFetch();
    render(withScope(<ControlledLease />, ["prop-1"]));
    expect(await screen.findByText("Auto-generate the lease on approval")).toBeTruthy();
    expect(screen.queryByText("Build the lease document as soon as an application is approved.")).toBeNull();
    expect(screen.queryByText("Send the generated lease for signature when it is ready.")).toBeNull();
  });

  it("Communication's Auto-send AI drafts row has no helper subtext", async () => {
    stubFetch();
    render(<CommunicationSettingsPanel />);
    await screen.findByRole("switch", { name: "Auto-send AI drafts" });
    expect(
      screen.queryByText(
        /When PropLane AI finishes a draft reply, send it without waiting for Approve\./,
      ),
    ).toBeNull();
    expect(
      screen.queryByText(/per-event channel choice now lives with each event's own reminder/),
    ).toBeNull();
  });

  it("Resident welcome is the only household section in this tab", async () => {
    stubFetch();
    render(
      <ResidentSettingsPanel
        propertyOptions={PROPERTY_OPTIONS}
        selectedPropertyId="prop-1"
        onPropertyIdChange={() => {}}
        area="household"
        onAreaChange={() => {}}
        teamMembers={[]}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Household reminders" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Payment reminders" })).toBeNull();
    expect(screen.queryByText(/Portfolio-wide payment reminder presets/)).toBeNull();
  });
});

describe("Application and Lease settings jump to the listing Form", () => {
  it("links those panels to the listing, not to the residents list", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-portal-settings-panels.tsx"),
      "utf8",
    );
    expect(source).toContain("propertyDetailHref");
    expect(source).toContain("SettingsFormJumpRow");
    expect(source).not.toContain('href="/portal/residents"');
    expect(source).not.toContain('href="/portal/profile?tab=payments"');
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
