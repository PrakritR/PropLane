// @vitest-environment jsdom
//
// The home demo's operations tabs (Tasks, Bookings, Promotion, Outgoing payments, Finances, Documents) open the REAL
// pop-ups and record pages, not the generic field card. For each tab this asserts: the sub tabs are the real page's
// (labels from the real constants, counts derived from the rows drawn), the round + opens a dialog with the real
// title / step rail / footer word, a row opens the real record or modal, and nothing ever fetches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import {
  BOOKING_ROWS,
  DOCUMENT_ROWS,
  OUTGOING_ROWS,
  PROMOTION_ROWS,
  TASK_ROWS,
} from "@/components/marketing/site/product-mock/fixtures-more";
import { OPS_REPORTS, OPS_TASK_DETAILS } from "@/components/marketing/site/product-mock/fixtures-popups-ops";
import { MANAGER_BOOKING_BUCKET_LABELS, MANAGER_TASK_LIST_TAB_LABELS, MANAGER_TASK_LIST_TABS } from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import { listingChannelsByGroup } from "@/lib/listing-channels/registry";
import { MANAGER_TASK_FORM_KIND_LABELS } from "@/lib/manager-task-form-support";
import { MANAGER_TASK_PRIORITY_LABELS, MANAGER_TASK_URGENCY_LABELS } from "@/lib/manager-tasks";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

let errorSpy: ReturnType<typeof vi.spyOn>;
afterEach(() => {
  cleanup();
  // The list band logs (never throws) when a panel breaks its icon / primary-label contract.
  const contract = errorSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes("[portal-list-control-stack]"));
  expect(contract).toEqual([]);
});

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

/** The tab strip's labels and counts, in order: "Open2" reads { label: "Open", count: 2 }. */
function tabsOf(container: HTMLElement, aria: string) {
  const nav = container.querySelector(`[aria-label="${aria}"]`);
  expect(nav, `tab strip ${aria}`).not.toBeNull();
  return [...nav!.querySelectorAll("button, a")].map((el) => {
    const match = /^(.*?)(\d+)?$/.exec((el.textContent ?? "").trim());
    return { label: match![1]!.trim(), count: match![2] === undefined ? undefined : Number(match![2]) };
  });
}

const fire = (el: Element | null) => {
  expect(el).not.toBeNull();
  fireEvent.click(el!);
};
const railLabels = (dialog: HTMLElement) => {
  const rail = dialog.querySelector('nav[aria-label^="Listing"]');
  expect(rail, "step rail").not.toBeNull();
  return rail!.textContent ?? "";
};
const hasFixtureSheet = (container: HTMLElement) => container.querySelector(".tracking-\\[0\\.04em\\]") !== null;
/** Walk a wizard popup to its last step; returns the final primary's text. */
function finishLabel(dialog: HTMLElement): string {
  for (let guard = 0; guard < 6; guard += 1) {
    const next = dialog.querySelector('[data-attr="demo-popup-next"]');
    if (!next) break;
    fireEvent.click(next);
  }
  return dialog.querySelector('[data-attr="demo-popup-finish"]')?.textContent ?? "";
}
const orderIn = (text: string, labels: string[]) => {
  let at = -1;
  for (const label of labels) {
    const found = text.indexOf(label, at + 1);
    expect(found, `${label} after ${at}`).toBeGreaterThan(at);
    at = found;
  }
};

describe("Tasks", () => {
  it("has the real tabs with counts from the rows, one Filter popover and the round +", () => {
    const { container } = render(<DemoPanel portal="manager" tab="tasks" />);
    const tabs = tabsOf(container, "Tasks views");
    expect(tabs.map((t) => t.label)).toEqual(MANAGER_TASK_LIST_TABS.map((id) => MANAGER_TASK_LIST_TAB_LABELS[id]));
    for (const [index, id] of MANAGER_TASK_LIST_TABS.entries()) expect(tabs[index]!.count).toBe(TASK_ROWS.filter((r) => r.bucket === id).length);
    expect(screen.getAllByRole("button", { name: "Filter" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
  });

  it("the Filter popover has Sort by, Type, Property, Assignee and Priority and a Show N tasks button", async () => {
    render(<DemoPanel portal="manager" tab="tasks" />);
    fire(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() => expect(screen.getByText("Sort by")).toBeInTheDocument());
    for (const label of ["Sort by", "Type", "Assignee", "Priority"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText("Any priority")).toBeInTheDocument();
    expect(screen.getByText(/^Show \d+ tasks?$/)).toBeInTheDocument();
  });

  it("the + opens Add task with the real rail, fields and footer", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="tasks" />);
    fire(screen.getByRole("button", { name: "Add task" }));
    const dialog = await screen.findByRole("dialog", { name: "Add task" }, { timeout: 5000 });
    orderIn(railLabels(dialog), ["Task", "Property", "When", "Review"]);
    expect(within(dialog).getByText("Task type")).toBeInTheDocument();
    expect(within(dialog).getByText("Description")).toBeInTheDocument();
    expect(within(dialog).getByText("Assignee")).toBeInTheDocument();
    expect(within(dialog).getByText("Task preview")).toBeInTheDocument();
    expect(finishLabel(dialog)).toBe("Add task");
    expect(within(dialog).getByText("Notes (optional)")).toBeInTheDocument();
    expect(within(dialog).getByText("Checklist (one step per line)")).toBeInTheDocument();
    expect(within(dialog).getByText("Attachments (one link per line, optional name first)")).toBeInTheDocument();
    expect(hasFixtureSheet(container)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the real task type, timing and priority words", async () => {
    render(<DemoPanel portal="manager" tab="tasks" />);
    fire(screen.getByRole("button", { name: "Add task" }));
    const dialog = await screen.findByRole("dialog", { name: "Add task" }, { timeout: 5000 });
    expect(within(dialog).getAllByText(MANAGER_TASK_FORM_KIND_LABELS.general).length).toBeGreaterThan(0);
    fireEvent.click(dialog.querySelector('[data-attr="demo-popup-next"]')!);
    fireEvent.click(dialog.querySelector('[data-attr="demo-popup-next"]')!);
    expect(within(dialog).getByText(MANAGER_TASK_URGENCY_LABELS.scheduled)).toBeInTheDocument();
    expect(within(dialog).getByText(MANAGER_TASK_PRIORITY_LABELS.medium)).toBeInTheDocument();
    for (const label of ["Timing", "Priority", "Schedule", "Repeats"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
  });

  it("a row opens the task's record page (Task, Linked, Communication; Edit, Assign, Schedule, Complete, Delete)", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="tasks" />);
    const first = TASK_ROWS.find((r) => r.bucket === "open")!;
    fire(screen.getByText(first.title));
    await waitFor(() => expect(container.querySelector('[data-attr="demo-record-page"]')).not.toBeNull());
    const sections = recordSections("manager", "task", { taskListTab: "open" });
    const rail = container.querySelector('nav[aria-label="Task sections"]');
    expect(rail).not.toBeNull();
    orderIn(rail!.textContent ?? "", sections.groups.flatMap((g) => g.items.map((i) => i.label)));
    for (const action of sections.headerActions) expect(screen.getAllByRole("button", { name: action.label }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasFixtureSheet(container)).toBe(false);
    expect(OPS_TASK_DETAILS[first.id]).toBeDefined();
    fire(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("dialog", { name: "Edit task" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Bookings", () => {
  it("has the real tabs (Calendar without a count), the property Filter, the Integrations plug and the round +", () => {
    const { container } = render(<DemoPanel portal="manager" tab="bookings" />);
    const tabs = tabsOf(container, "Bookings views");
    expect(tabs.map((t) => t.label)).toEqual(Object.values(MANAGER_BOOKING_BUCKET_LABELS));
    expect(tabs[0]!.count).toBeUndefined();
    for (const [index, id] of (["upcoming", "inhouse", "past"] as const).entries()) expect(tabs[index + 1]!.count).toBe(BOOKING_ROWS.filter((r) => r.bucket === id).length);
    expect(screen.getAllByRole("button", { name: "Filter" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Integrations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add booking" })).toBeInTheDocument();
    for (const control of ["Previous month", "Next month"]) expect(screen.getAllByRole("button", { name: control }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByLabelText("Calendar colours")).toHaveTextContent("Airbnb / Booking.com");
  });

  it("the + opens Add booking (Property, When, Review) ending in Add booking", async () => {
    render(<DemoPanel portal="manager" tab="bookings" />);
    fire(screen.getByRole("button", { name: "Add booking" }));
    const dialog = await screen.findByRole("dialog", { name: "Add booking" });
    orderIn(railLabels(dialog), ["Property", "When", "Review"]);
    expect(within(dialog).getByText("+ New resident")).toBeInTheDocument();
    expect(within(dialog).getByText("Room")).toBeInTheDocument();
    fireEvent.click(dialog.querySelector('[data-attr="demo-popup-next"]')!);
    for (const label of ["Source", "Notes", "Linen", "Baggage", "Early check-in", "Late check-out", "Move in", "Move out"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(finishLabel(dialog)).toBe("Add booking");
  });

  it("a calendar day opens the day dialog with day chevrons and the occupancy line", async () => {
    render(<DemoPanel portal="manager" tab="bookings" />);
    fire(screen.getByRole("button", { name: "Thursday, September 25" }));
    const dialog = await screen.findByRole("dialog", { name: "Thursday, September 25" });
    expect(within(dialog).getByRole("button", { name: "Previous day" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Next day" })).toBeInTheDocument();
    expect(within(dialog).getByText(/^\d+ of \d+ beds occupied · \d+ check-ins?$/)).toBeInTheDocument();
    fire(within(dialog).getByRole("button", { name: "Next day" }));
    expect(await screen.findByRole("dialog", { name: "Friday, September 26" })).toBeInTheDocument();
  });

  it("a row opens the booking record page (Booking, Guest, Payments, Communication; Message primary)", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="bookings" />);
    fire(screen.getByRole("button", { name: /^Upcoming/ }));
    const holdIndex = BOOKING_ROWS.filter((r) => r.bucket === "upcoming").findIndex((r) => r.status === "Hold");
    fire(container.querySelectorAll('button[data-attr="booking-list-row"]')[holdIndex]!);
    await waitFor(() => expect(container.querySelector('[data-attr="demo-record-page"]')).not.toBeNull());
    const sections = recordSections("manager", "booking", { basePath: "/portal" });
    const rail = container.querySelector('nav[aria-label="Booking sections"]');
    expect(rail).not.toBeNull();
    orderIn(rail!.textContent ?? "", sections.groups.flatMap((g) => g.items.map((i) => i.label)));
    for (const action of sections.headerActions) expect(screen.getAllByRole("button", { name: action.label }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Cancel booking" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasFixtureSheet(container)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Promotion", () => {
  it("has All, Text, Image and Listing sites with counts from the rows; the plug rides only Listing sites", () => {
    const { container } = render(<DemoPanel portal="manager" tab="promotion" />);
    const tabs = tabsOf(container, "Promotion type");
    expect(tabs.map((t) => t.label)).toEqual(["All", "Text", "Image", "Listing sites"]);
    expect(tabs.map((t) => t.count)).toEqual([
      PROMOTION_ROWS.length,
      PROMOTION_ROWS.filter((r) => r.bucket === "text").length,
      PROMOTION_ROWS.filter((r) => r.bucket === "image").length,
      (["automatic", "one_click", "request_access"] as const).reduce((sum, g) => sum + listingChannelsByGroup(g).length, 0),
    ]);
    expect(screen.queryByRole("button", { name: "Integrations" })).toBeNull();
    fire(screen.getByRole("button", { name: /^Listing sites/ }));
    expect(screen.getByRole("button", { name: "Integrations" })).toBeInTheDocument();
  });

  it("the + opens New promotion with the Kind / Content / Preview rail and the Upload your own card", async () => {
    render(<DemoPanel portal="manager" tab="promotion" />);
    fire(screen.getByRole("button", { name: "Add promotion" }));
    const dialog = await screen.findByRole("dialog", { name: "New promotion" });
    orderIn(railLabels(dialog), ["Kind", "Content", "Preview"]);
    expect(within(dialog).getByLabelText("Upload your own")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Property").length).toBeGreaterThan(0);
    expect(finishLabel(dialog)).toBe("Generate flyer");
  });

  it("a row opens the View modal with the real footer; the generic card never appears", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="promotion" />);
    const flyer = PROMOTION_ROWS.find((r) => r.kind === "Flyer")!;
    fire(screen.getByText(flyer.title));
    const dialog = await screen.findByRole("dialog", { name: `View · ${flyer.title}` });
    expect(within(dialog).getByRole("button", { name: "Download flyer" })).toBeInTheDocument();
    expect(hasFixtureSheet(container)).toBe(false);
    fire(within(dialog).getByRole("button", { name: "Close" }));
    const text = PROMOTION_ROWS.find((r) => r.bucket === "text")!;
    fire(screen.getByText(text.title));
    const textDialog = await screen.findByRole("dialog", { name: `View · ${text.title}` });
    expect(within(textDialog).getByRole("button", { name: "Copy text" })).toBeInTheDocument();
    expect(within(textDialog).getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Outgoing payments", () => {
  it("has To pay / Scheduled / Paid with counts and a money strip per tab, a two-field Filter and Add payment", () => {
    const { container } = render(<DemoPanel portal="manager" tab="outgoing" />);
    const tabs = tabsOf(container, "Outgoing payments");
    expect(tabs.map((t) => t.label)).toEqual(["To pay", "Scheduled", "Paid"]);
    for (const [index, id] of (["to-pay", "scheduled", "paid"] as const).entries()) {
      expect(tabs[index]!.count).toBe(OUTGOING_ROWS.filter((r) => r.bucket === id).length);
      const total = OUTGOING_ROWS.filter((r) => r.bucket === id).reduce((sum, r) => sum + Number(r.amount.replace(/[$,]/g, "")), 0);
      expect(container.querySelector(`[data-attr="outgoing-stat-${id}"]`)?.textContent).toBe(`$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    }
    expect(screen.getAllByRole("button", { name: "Filter" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add payment" })).toBeInTheDocument();
  });

  it("the + opens Add payment (Pay to, Payment, Review) ending in Add payment", async () => {
    render(<DemoPanel portal="manager" tab="outgoing" />);
    fire(screen.getByRole("button", { name: "Add payment" }));
    const dialog = await screen.findByRole("dialog", { name: "Add payment" });
    orderIn(railLabels(dialog), ["Pay to", "Payment", "Review"]);
    for (const label of ["A vendor", "A teammate", "Someone else", "Payee"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(finishLabel(dialog)).toBe("Add payment");
  });

  it("a row opens the payment record (Payment, Communication; View invoice, Schedule payment, Mark paid, Pay now)", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="outgoing" />);
    fire(screen.getByText(OUTGOING_ROWS.find((r) => r.bucket === "to-pay")!.vendor));
    await waitFor(() => expect(container.querySelector('[data-attr="demo-record-page"]')).not.toBeNull());
    const sections = recordSections("manager", "vendor-bill", { basePath: "/portal" });
    const rail = container.querySelector('nav[aria-label="Payment sections"]');
    orderIn(rail?.textContent ?? "", sections.groups.flatMap((g) => g.items.map((i) => i.label)));
    for (const name of ["View invoice", "Schedule payment", "Mark paid", "Pay now"]) expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    fire(screen.getAllByRole("button", { name: "View invoice" })[0]!);
    expect(await screen.findByRole("dialog", { name: "Invoice" })).toBeInTheDocument();
    expect(hasFixtureSheet(container)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Finances", () => {
  it("Overview carries the Balance & payouts landmark and Add financial entry; the balance strip is derived", () => {
    const { container } = render(<DemoPanel portal="manager" tab="financials" />);
    const tabs = tabsOf(container, "Finance view");
    expect(tabs.map((t) => t.label)).toEqual(["Overview", "Reports"]);
    expect(screen.getByRole("button", { name: "Balance & payouts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add financial entry" })).toBeInTheDocument();
    const strip = container.querySelector('[data-attr="finances-balance-strip"]');
    for (const label of ["Available", "Pending", "Held deposits", "To pay"]) expect(strip?.textContent).toContain(label);
    expect(strip?.textContent).toContain(`${OUTGOING_ROWS.filter((r) => r.bucket === "to-pay").length} bills`);
    expect(container.querySelector('[data-attr="finances-month-strip"]')?.textContent).toMatch(/Revenue.*Expenses.*Profit/);
  });

  it("Add financial entry opens the small Financial entry dialog, then Continue opens Add expense (What, Where, Review)", async () => {
    render(<DemoPanel portal="manager" tab="financials" />);
    fire(screen.getByRole("button", { name: "Add financial entry" }));
    const chooser = await screen.findByRole("dialog", { name: "Financial entry" });
    expect(within(chooser).getByText("Type")).toBeInTheDocument();
    fire(within(chooser).getByRole("button", { name: "Continue" }));
    const dialog = await screen.findByRole("dialog", { name: "Add expense" });
    orderIn(railLabels(dialog), ["What", "Where", "Review"]);
    for (const label of ["Category", "Amount", "Date", "Description"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(finishLabel(dialog)).toBe("Save expense");
    expect(screen.queryByRole("dialog", { name: "Financial entry" })).toBeNull();
  });

  it("Reports lists the 17 real reports with no header actions; a report opens a report page", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="financials" />);
    fire(screen.getByRole("button", { name: /^Reports/ }));
    expect(container.querySelectorAll('[data-attr="finances-report-row"]')).toHaveLength(17);
    expect(OPS_REPORTS).toHaveLength(17);
    expect(screen.queryByRole("button", { name: "Balance & payouts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add financial entry" })).toBeNull();
    fire(screen.getByText("Profit and loss"));
    await waitFor(() => expect(container.querySelector('[data-attr="demo-report-page"]')).not.toBeNull());
    expect(screen.getAllByText("Profit and loss").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-attr="finances-report-body"] table')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Documents", () => {
  it("has Applications / Leases / Other documents with counts, one Filter and Add document", () => {
    const { container } = render(<DemoPanel portal="manager" tab="documents" />);
    const tabs = tabsOf(container, "Documents");
    expect(tabs.map((t) => t.label)).toEqual(["Applications", "Leases", "Other documents"]);
    for (const [index, id] of (["applications", "leases", "other"] as const).entries()) expect(tabs[index]!.count).toBe(DOCUMENT_ROWS.filter((r) => r.bucket === id).length);
    expect(screen.getAllByRole("button", { name: "Filter" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add document" })).toBeInTheDocument();
  });

  it("the + opens Upload document (File, Details, Review) ending in Upload", async () => {
    render(<DemoPanel portal="manager" tab="documents" />);
    fire(screen.getByRole("button", { name: "Add document" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload document" });
    orderIn(railLabels(dialog), ["File", "Details", "Review"]);
    expect(finishLabel(dialog)).toBe("Upload");
  });

  it("an application row opens its document record, a lease row toggles an inline preview, an Other row opens a preview modal", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="documents" />);
    const app = DOCUMENT_ROWS.find((r) => r.bucket === "applications")!;
    fire(screen.getByText(app.title));
    await waitFor(() => expect(container.querySelector('[data-attr="demo-application-document"]')).not.toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    fire(screen.getByRole("button", { name: "Back to documents" }));
    fire(screen.getByRole("button", { name: /^Leases/ }));
    const lease = DOCUMENT_ROWS.find((r) => r.bucket === "leases")!;
    fire(screen.getByText(lease.title));
    await waitFor(() => expect(container.querySelector('[data-attr="manager-documents-lease-preview"]')).not.toBeNull());
    fire(screen.getByRole("button", { name: /^Other documents/ }));
    const other = DOCUMENT_ROWS.find((r) => r.bucket === "other")!;
    fire(screen.getByText(other.title));
    const dialog = await screen.findByRole("dialog", { name: other.title });
    expect(within(dialog).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(hasFixtureSheet(container)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
