// @vitest-environment jsdom
//
// Add property / Edit listing carry four leasing steps between Shared spaces and Review
// (captain, Oct 3): Application, Lease, Move-in, Pricing. Each is a few flat rows with an
// "Edit in full" pencil that opens the property's own editor; Review lists them too; and
// the property record's sidebar puts Move-in under Leasing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
  readAdminPropertyRows: vi.fn(() => []),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

// The full editors are tested where they live; here we only prove the right one opens for the right row.
vi.mock("@/components/portal/pro-application-questions-editor-modal", () => ({
  ManagerApplicationQuestionsEditorModal: (props: { applicationTemplate?: { label: string } | null; applicationPreviewPropertyId?: string }) => (
    <div data-testid="application-editor">{props.applicationTemplate?.label}|{props.applicationPreviewPropertyId}</div>
  ),
}));
vi.mock("@/components/portal/property-lease-form-modal", () => ({
  PropertyLeaseFormModal: (props: { template?: { label: string } | null; propertyId?: string | null }) => (
    <div data-testid="lease-editor">{props.template?.label}|{props.propertyId}</div>
  ),
}));
vi.mock("@/components/portal/pro-lease-questions-editor-modal", () => ({
  ManagerLeaseQuestionsEditorModal: () => <div data-testid="lease-questions-editor" />,
}));
vi.mock("@/components/portal/move-in-forms/move-in-form-editor-modal", () => ({
  MoveInFormEditorModal: (props: { initial: { name: string }; propertyId: string; mode: string }) => (
    <div data-testid="move-in-editor">{props.mode}|{props.initial.name}|{props.propertyId}</div>
  ),
}));
vi.mock("@/components/portal/property-room-pricing-workspace", () => ({
  PropertyRoomPricingWorkspace: (props: { subject: { kind: string; roomId?: string }; saveTarget: { mode: string; saveId: string } }) => (
    <div data-testid="pricing-workspace">{props.subject.kind}|{props.subject.roomId}|{props.saveTarget.mode}|{props.saveTarget.saveId}</div>
  ),
}));

import { ListingEditorV2, LISTING_V2_STEPS, listingRailChrome } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { recordSections } from "@/lib/portals/record-sections";

const showToast = vi.fn();

function sub() {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "400 Pike Street",
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1100 }],
  };
}

function mount(props: Partial<React.ComponentProps<typeof ListingEditorV2>> = {}) {
  render(
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
      <ListingEditorV2
        title="400 Pike Street"
        submission={sub()}
        onChange={() => {}}
        onClose={() => {}}
        onPublish={() => {}}
        managerUserId="manager-1"
        showToast={showToast}
        {...props}
      />
    </PortalAssistantConfigProvider>,
  );
}

const go = (id: string) => fireEvent.click(document.querySelector(`[data-attr='listing-v2-rail-${id}']`)!);

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

describe("the wizard rail", () => {
  it("lists Basics, Rooms, Bathrooms, Shared spaces, Application, Lease, Move-in, Pricing, Review", () => {
    mount();
    const labels = Array.from(
      screen.getByRole("navigation", { name: "Listing sections" }).querySelectorAll("button[data-attr^='listing-v2-rail-']"),
    )
      .filter((b) => !["listing-v2-rail-finish", "listing-v2-rail-add-photos"].includes(b.getAttribute("data-attr")!))
      .map((b) => b.querySelector("span.truncate")?.textContent);
    expect(labels).toEqual(["Basics", "Rooms", "Bathrooms", "Shared spaces", "Application", "Lease", "Move-in", "Pricing", "Review"]);
    expect(LISTING_V2_STEPS).toHaveLength(9);
  });

  it("counts the leasing steps on the Continue path (Basics, Rooms, 4 leasing, Review), not five", () => {
    mount();
    expect(screen.getAllByText(/^Step 1 of 7$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Step 1 of 5$/)).toBeNull();
  });

  it("the phone step picker lists the new steps", () => {
    mount();
    fireEvent.click(document.querySelector("[data-attr='workspace-step-picker']")!);
    for (const id of ["application", "lease", "movein", "pricing"]) {
      expect(document.querySelector(`[data-attr='workspace-step-${id}']`)).not.toBeNull();
    }
  });

  it("none of the new steps raises a red dot or an 'N to finish' count", () => {
    const chrome = listingRailChrome(sub());
    for (const id of ["application", "lease", "movein", "pricing"]) expect(chrome.attention[id]).toBe(0);
  });
});

describe("Application step", () => {
  it("shows each application with its fee, a pencil per row, and the workspace 'before a tour' setting read-only", async () => {
    mount({ propertyId: "prop-1", onOpenSettings: vi.fn() });
    go("application");
    const rows = document.querySelectorAll("[data-attr='listing-v2-application-row']");
    expect(rows.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-attr='listing-v2-application-edit']")).toHaveLength(rows.length);
    expect(screen.getAllByRole("button", { name: /^Edit .* in full$/ }).length).toBe(rows.length);
    await waitFor(() => expect(document.querySelector("[data-attr='listing-v2-application-before-tour']")!.textContent).toContain("Required"));
    // read-only: the value is text, there is no select to change it here
    expect(document.querySelector("[data-attr='listing-v2-application-before-tour'] select, [data-attr='listing-v2-application-before-tour'] input")).toBeNull();
  });

  it("Edit in full opens the application editor for that template", async () => {
    mount({ propertyId: "prop-1" });
    go("application");
    fireEvent.click(document.querySelector("[data-attr='listing-v2-application-edit']")!);
    await waitFor(() => expect(screen.getByTestId("application-editor").textContent).toMatch(/\|prop-1$/));
  });

  it("a brand-new draft saves first, then opens; it never opens without a record", async () => {
    const ensureSaved = vi.fn(async () => "draft-9");
    mount({ ensureSaved });
    go("application");
    fireEvent.click(document.querySelector("[data-attr='listing-v2-application-edit']")!);
    await waitFor(() => expect(screen.getByTestId("application-editor").textContent).toMatch(/\|draft-9$/));
    expect(ensureSaved).toHaveBeenCalledTimes(1);
  });

  it("with no way to save, Edit in full says so instead of opening", async () => {
    mount();
    go("application");
    fireEvent.click(document.querySelector("[data-attr='listing-v2-application-edit']")!);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Save the property first, then edit in full."));
    expect(screen.queryByTestId("application-editor")).toBeNull();
  });
});

describe("Lease step", () => {
  it("lists the property's leases and opens the lease editor for the picked row", async () => {
    const base = sub();
    mount({
      propertyId: "prop-1",
      submission: {
        ...base,
        propertyLeaseTemplates: [
          { id: "l1", kind: "long-term", label: "Long-term lease", listingSeedKey: "primary", leaseConfigMode: "standard", leaseCustomKind: "terms", customLeaseTerms: "", leaseTemplateDocUrl: null, leaseTemplateDocName: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
          { id: "l2", kind: "custom", label: "Pet addendum", leaseConfigMode: "custom", leaseCustomKind: "document", customLeaseTerms: "", leaseTemplateDocUrl: "https://x/y.pdf", leaseTemplateDocName: "pets.pdf", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
        ],
      } as typeof base,
    });
    go("lease");
    const rows = document.querySelectorAll("[data-attr='listing-v2-lease-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Long-term lease");
    expect(rows[1]!.textContent).toContain("Pet addendum");
    expect(document.querySelectorAll("[data-attr='listing-v2-lease-edit']")).toHaveLength(2);
    fireEvent.click(document.querySelectorAll("[data-attr='listing-v2-lease-edit']")[1]!);
    await waitFor(() => expect(screen.getByTestId("lease-editor").textContent).toBe("Pet addendum|prop-1"));
  });

  it("a brand-new draft shows the lease types it offers as defaults, with no Edit in full yet", () => {
    mount();
    go("lease");
    expect(document.querySelectorAll("[data-attr='listing-v2-lease-default-row']").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-attr='listing-v2-lease-edit']")).toBeNull();
  });
});

describe("Move-in step", () => {
  it("lists the move-in forms with their Sends setting and opens the form editor", async () => {
    mount({ propertyId: "prop-1" });
    go("movein");
    const rows = document.querySelectorAll("[data-attr='listing-v2-movein-row']");
    expect(rows.length).toBe(5); // the five starters a property that never saved its forms shows
    expect(document.querySelector("[data-attr='listing-v2-movein-rows']")!.textContent).toMatch(/Sends when lease is signed/);
    expect(document.querySelector("[data-attr='listing-v2-movein-rows']")!.textContent).toMatch(/Sent by hand/);
    fireEvent.click(document.querySelector("[data-attr='listing-v2-movein-edit']")!);
    await waitFor(() => expect(screen.getByTestId("move-in-editor").textContent).toMatch(/^edit\|/));
  });
});

describe("Pricing step", () => {
  it("shows each room's rent and the main fees, and opens the room's pricing workspace", async () => {
    mount({ propertyId: "prop-1" });
    go("pricing");
    const text = document.querySelector("[data-attr='listing-v2-pricing-rows']")!.textContent!;
    expect(text).toContain("Room A");
    expect(text).toMatch(/\$1,100/);
    expect(document.querySelector("[data-attr='listing-v2-pricing-fees']")!.textContent).toContain("Application fee");
    fireEvent.click(document.querySelector("[data-attr='listing-v2-pricing-edit']")!);
    await waitFor(() => expect(screen.getByTestId("pricing-workspace").textContent).toBe("room|room-a|draft|prop-1"));
  });

  it("an existing listing saves through the listing target", async () => {
    mount({ propertyId: "prop-1", isEdit: true });
    go("pricing");
    fireEvent.click(document.querySelector("[data-attr='listing-v2-pricing-edit']")!);
    await waitFor(() => expect(screen.getByTestId("pricing-workspace").textContent).toBe("room|room-a|listing|prop-1"));
  });
});

describe("right-hand preview", () => {
  it("shows the leasing summary on the new steps and keeps the Listing preview", () => {
    mount();
    go("application");
    const summary = document.querySelector("[data-attr='listing-v2-detail-summary']")!.textContent!;
    expect(summary).toMatch(/Applications/);
    expect(summary).toMatch(/Leases/);
    expect(summary).toMatch(/Move-in forms.*5 forms/);
    expect(summary).toMatch(/From \$1,100\/mo/);
    expect(screen.getAllByText("Listing preview").length).toBeGreaterThan(0);
  });
});

describe("Review step", () => {
  it("lists the four leasing steps with an Edit door each, and they are not 'to finish' items", () => {
    mount();
    go("review");
    for (const id of ["application", "lease", "movein", "pricing"]) {
      expect(document.querySelector(`[data-attr='listing-v2-review-leasing-${id}']`)).not.toBeNull();
    }
    fireEvent.click(document.querySelector("[data-attr='listing-v2-review-edit-movein']")!);
    expect(document.querySelector("[data-attr='listing-v2-movein-rows']")).not.toBeNull();
  });
});

describe("property record sidebar", () => {
  it("puts Move-in under Leasing, in the order Applications, Lease, Move-in, Pricing", () => {
    const groups = recordSections("manager", "property", { basePath: "/portal" }).groups;
    const ids = (label: string) => groups.find((g) => g.label === label)?.items.map((i) => i.id);
    expect(ids("Leasing")).toEqual(["application", "lease", "move-in", "pricing"]);
    expect(ids("Property")).toEqual(["preview", "house-details"]);
    const leasing = groups.find((g) => g.label === "Leasing")!.items.map((i) => i.label);
    expect(leasing).toEqual(["Applications", "Lease", "Move-in", "Pricing"]);
    // the URL does not change
    const moveIn = groups.flatMap((g) => g.items).find((i) => i.id === "move-in")!;
    expect(moveIn.href("p1")).toMatch(/\/move-in$/);
  });
});
