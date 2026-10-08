// @vitest-environment jsdom
//
// The home demo's manager Properties and Calendar tabs must open what the real pages open: the real tabs with
// counts drawn from the rows, the New property wizard (the real ListingEditorV2), "Send listing", a property's
// record page, a row menu that differs per stage; and on the Calendar the + menu with the Add tour / Add task /
// Add service pop-ups and "Your availability", Day / Week / Month / Agenda underline tabs, and an item that opens
// its tour / task / service record. The generic RESIDENT / HOME / STATUS card never comes back and nothing fetches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { NO_STORY, worldFor } from "@/components/marketing/site/product-mock/world";
import { HOME_EXTRA_PROPERTIES } from "@/components/marketing/site/product-mock/fixtures-popups-home";
import { MANAGER_STAGES } from "@/components/portal/pro-house-properties-panel";
import { LISTING_V2_STEPS } from "@/components/portal/listing-wizard-v2/listing-editor";
import { CALENDAR_VIEW_TAB_LABELS } from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

afterEach(cleanup);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

const world = worldFor(NO_STORY);
const allProperties = [...world.properties, ...HOME_EXTRA_PROPERTIES];

function railLabels(sections: ReturnType<typeof recordSections>): string[] {
  return sections.groups.flatMap((g) => g.items.map((i) => i.label));
}

describe("demo Properties tab matches the real Properties page", () => {
  it("has the real tabs, counted from the rows it draws", () => {
    render(<DemoPanel portal="manager" tab="properties" />);
    const expected: Record<string, number> = {
      all: allProperties.length,
      listed: allProperties.filter((p) => p.stage === "listed").length,
      unlisted: allProperties.filter((p) => p.stage === "unlisted").length,
      drafts: allProperties.filter((p) => p.stage === "draft").length,
    };
    for (const stage of MANAGER_STAGES) {
      const button = screen.getByRole("button", { name: new RegExp(`^${stage.label}`) });
      expect(button.textContent).toContain(String(expected[stage.key]));
    }
    // the header: Share listing link only (no gear, no Import), then the round +
    expect(screen.getByRole("button", { name: "Share listing link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Settings|Import/ })).toBeNull();
  });

  it("the Share icon opens Send listing (Home, Recipient, Review) and Send closes it", async () => {
    render(<DemoPanel portal="manager" tab="properties" />);
    fireEvent.click(screen.getByRole("button", { name: "Share listing link" }));
    const dialog = await screen.findByRole("dialog", { name: "Send listing" });
    for (const label of ["Home", "Recipient", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(within(dialog).getAllByText("Review")[0]!);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Send" }));
    expect(screen.queryByRole("dialog", { name: "Send listing" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Listing sent/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the round + mounts the real ListingEditorV2: nine steps, Start from a file, Create property", async () => {
    render(<DemoPanel portal="manager" tab="properties" />);
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = await screen.findByRole("dialog", { name: "Cedar House" });
    for (const step of LISTING_V2_STEPS) expect(within(dialog).getAllByText(step.label).length).toBeGreaterThan(0);
    for (const heading of ["The home itself", "Where it is", "Photos and video", "Amenities and pets"]) {
      expect(within(dialog).getAllByText(heading).length).toBeGreaterThan(0);
    }
    for (const field of ["Property type", "How you rent it", "Street address", "City", "State", "ZIP", "Neighborhood", "Property name", "Description"]) {
      expect(within(dialog).getAllByText(new RegExp(`^${field}`)).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getAllByText(/Start from a file/i).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Not saved yet").length).toBeGreaterThan(0);
    expect(dialog.textContent).not.toMatch(/Step \d+ of \d+/);
    // every step opens without a network call (Application, Lease, Move-in and Pricing read settings)
    for (const step of LISTING_V2_STEPS.slice(1)) {
      const rail = within(dialog).getAllByText(step.label)[0]!;
      fireEvent.click(rail);
    }
    const create = await within(dialog).findByRole("button", { name: "Create property" });
    fireEvent.click(create);
    expect(screen.queryByRole("dialog", { name: "Cedar House" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Property created/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row opens the property record page, never the generic field card", async () => {
    render(<DemoPanel portal="manager" tab="properties" />);
    fireEvent.click(screen.getByText("Alder House"));
    const record = await vi.waitFor(() => {
      const el = document.querySelector('[data-attr="demo-record-page"]');
      if (!el) throw new Error("record page not mounted");
      return el as HTMLElement;
    });
    const labels = railLabels(recordSections("manager", "property", { stage: "listed" }));
    expect(labels).toEqual(["Preview", "House details", "Applications", "Lease", "Forms", "Move-in", "Pricing", "Services", "Promotion", "AI info"]);
    for (const label of labels) expect(within(record).getAllByText(label).length).toBeGreaterThan(0);
    for (const action of ["Edit", "Share", "Duplicate property", "Unlist", "Delete"]) {
      expect(within(record).getAllByRole("button", { name: action }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    // no stock photo: the real empty-image placeholder
    expect(record.querySelector("img")).toBeNull();
    fireEvent.click(within(record).getAllByText("House details")[0]!);
    expect(within(record).getAllByText("Street address").length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the row menu differs by stage: Share and Unlist when listed, Relist when unlisted, Delete on a draft", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="properties" />);
    await user.click(screen.getByRole("button", { name: "Actions for Alder House" }));
    for (const name of ["View", "Edit", "Share", "Duplicate", "Unlist"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Relist" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Actions for Cedar Cottage" }));
    expect(await screen.findByRole("menuitem", { name: "Relist" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unlist" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Actions for Untitled draft" }));
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("demo Calendar tab matches the real Calendar page", () => {
  it("has the real tabs with counts, the Day / Week / Month / Agenda underline tabs, and no Availability icon", () => {
    render(<DemoPanel portal="manager" tab="calendar" />);
    const kinds = { all: world.calendar.length, tours: 0, services: 0, tasks: 0 };
    for (const item of world.calendar) kinds[item.kind === "tour" ? "tours" : item.kind === "service" ? "services" : "tasks"] += 1;
    for (const id of ["all", "tours", "services", "tasks"] as const) {
      const button = screen.getByRole("button", { name: new RegExp(`^${CALENDAR_VIEW_TAB_LABELS[id]}`) });
      expect(button.textContent).toContain(String(kinds[id]));
    }
    const views = within(screen.getByRole("navigation", { name: "Calendar view" })).getAllByRole("button");
    expect(views.map((b) => b.textContent)).toEqual(["Day", "Week", "Month", "Agenda"]);
    for (const name of ["Filter", "Integrations", "Add"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Availability" })).toBeNull();
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
  });

  it("the + is a menu, and its first four items open the real pop-ups", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="calendar" />);
    await user.click(screen.getByRole("button", { name: "Add" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    expect(items).toEqual(["New tour", "New task", "New service", "Add availability", "Copy previous week", "Clear week", "Copy to houses", "Connect Google Calendar"]);

    await user.click(screen.getByRole("menuitem", { name: "New tour" }));
    let dialog = await screen.findByRole("dialog", { name: "Add tour" });
    for (const label of ["Home", "Date & time", "Visitor", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Format").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getAllByText("Review")[0]!);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add tour" }));
    expect(screen.queryByRole("dialog", { name: "Add tour" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Tour added/);

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: "New task" }));
    dialog = await screen.findByRole("dialog", { name: "Add task" });
    for (const label of ["Task", "Property", "When", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Task type").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Assignee").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getAllByText("When")[0]!);
    for (const label of ["Timing", "Priority", "Schedule", "Repeats"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getAllByText("Review")[0]!);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add task" }));
    expect(screen.queryByRole("dialog", { name: "Add task" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: "New service" }));
    dialog = await screen.findByRole("dialog", { name: "Add service" });
    for (const label of ["Where", "What", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getAllByText("Review")[0]!);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add service" }));
    expect(screen.queryByRole("dialog", { name: "Add service" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add availability" }));
    dialog = await screen.findByRole("dialog", { name: "Your availability" });
    expect(within(dialog).getAllByText("Availability for").length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an item opens its tour, task or service record page", async () => {
    render(<DemoPanel portal="manager" tab="calendar" />);
    const open = async (text: string) => {
      fireEvent.click(screen.getAllByText(text)[0]!);
      return vi.waitFor(() => {
        const el = document.querySelector('[data-attr="demo-record-page"]');
        if (!el) throw new Error("record page not mounted");
        return el as HTMLElement;
      });
    };
    let record = await open("Noah Kessler");
    expect(record.textContent).toContain("Prospect");
    expect(within(record).getAllByText("Communication").length).toBeGreaterThan(0);
    expect(railLabels(recordSections("manager", "tour"))).toEqual(["Tour", "Communication"]);
    fireEvent.click(within(record).getByRole("button", { name: /Back/ }));
    record = await open("Countersign Jamie P.'s lease");
    expect(within(record).getAllByText("Linked").length).toBeGreaterThan(0);
    expect(within(record).getByRole("button", { name: "Complete" })).toBeInTheDocument();
    fireEvent.click(within(record).getByRole("button", { name: /Back/ }));
    record = await open("Cascade Locksmiths");
    expect(within(record).getAllByText("Vendors").length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
