// @vitest-environment jsdom
//
// The home demo's manager Tours, Applications and Leases tabs must behave like the real pages (pro-tours.tsx,
// pro-applications.tsx, pro-leases.tsx): the real sub tabs counted from the rows they draw, the real header icons
// (no invented Export / Settings on Tours, a Send icon and no gear on Applications, a gear on Leases), a round +
// that opens the real pop-up (Add tour, Add application, Send lease) with the real step rail and footer words, a
// row that opens its RECORD page (rail from `recordSections`), a ⋯ with that row's own actions, and nothing ever
// calls the network. The generic RESIDENT / HOME / STATUS field card must never come back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { NO_STORY, worldFor } from "@/components/marketing/site/product-mock/world";
import { LEASE_TAB_LABELS, applicationTabOf } from "@/components/marketing/site/product-mock/fixtures-popups-leasing";
import { APPLICATION_DETAIL_TAB_LABELS, MANAGER_TOUR_BUCKET_LABELS } from "@/lib/portal-detail-routes";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

afterEach(cleanup);
// A lazy chunk of real wizard pieces can take a few seconds to transform on a loaded machine.
vi.setConfig({ testTimeout: 40000 });

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

const world = worldFor(NO_STORY);

/** The pop-ups and records arrive from a lazy chunk; a loaded machine can take a few seconds to transform it. */
const LONG = { timeout: 15000 };
const dialogNamed = (name: string | RegExp) => screen.findByRole("dialog", { name }, LONG);

/** The Filter popover is a lazy chunk too: wait for the real trigger before opening it. */
async function openFilter(dataAttr: string) {
  await waitFor(() => expect(document.querySelector(`[data-attr='${dataAttr}']`)).not.toBeNull(), LONG);
  fireEvent.click(document.querySelector(`[data-attr='${dataAttr}']`)!);
}

/** A list tab's button: its label followed by the count the panel derives from the rows it draws. */
function tab(label: string): HTMLElement {
  const found = screen.getAllByRole("button").find((button) => new RegExp(`^${label}\\d*$`).test((button.textContent ?? "").trim()));
  if (!found) throw new Error(`no tab named ${label}`);
  return found;
}
const tabCount = (label: string) => Number(/(\d+)$/.exec((tab(label).textContent ?? "").trim())?.[1] ?? NaN);

/** The accessible names of the list band's icon buttons, in document order (a row's own controls excluded). */
const bandIconNames = () =>
  screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "")
    .filter((name) => name && !name.startsWith("Actions for") && !name.startsWith("Select"));

/** Click Next until the footer's last-step primary appears; returns its text. */
function finishLabel(dialog: HTMLElement): string {
  for (let i = 0; i < 8 && !dialog.querySelector("[data-attr='demo-popup-finish']"); i += 1) {
    fireEvent.click(within(dialog).getByRole("button", { name: /^Next/ }));
  }
  return (dialog.querySelector("[data-attr='demo-popup-finish']")?.textContent ?? "").trim();
}

const railHas = (dialog: HTMLElement, label: string) => within(dialog).queryAllByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).length > 0;

describe("demo Tours tab matches the real Tours page", () => {
  it("has the real Pending, Upcoming and Past tabs, counted from the rows it draws", () => {
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    for (const id of ["pending", "upcoming", "past"] as const) {
      expect(tabCount(MANAGER_TOUR_BUCKET_LABELS[id])).toBe(world.tours.filter((t) => t.bucket === id).length);
    }
  });

  it("header icons are Filter, Add availability, Share tour link and the round + (no Export, no Settings)", () => {
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    expect(bandIconNames().filter((name) => ["Filter", "Add availability", "Share tour link", "Add tour", "Export", "Settings"].includes(name))).toEqual([
      "Filter",
      "Add availability",
      "Share tour link",
      "Add tour",
    ]);
  });

  it("Filter opens the real popover with Group by and Property", async () => {
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    await openFilter("tours-filter-sheet-open");
    expect((await screen.findAllByText("Group by", {}, LONG)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Property").length).toBeGreaterThan(0);
  });

  it("the round + opens the real Add tour pop-up: Home, Date & time, Visitor, Review, and the Add tour footer", async () => {
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Add tour" }));
    const dialog = await dialogNamed("Add tour");
    for (const label of ["Home", "Date & time", "Visitor", "Review"]) expect(railHas(dialog, label)).toBe(true);
    expect(within(dialog).getAllByText("Property").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Format").length).toBeGreaterThan(0);
    expect(finishLabel(dialog)).toBe("Add tour");
    expect(within(dialog).getAllByText("Notes").length).toBeGreaterThan(0);
    fireEvent.click(dialog.querySelector("[data-attr='demo-popup-finish']")!);
    expect(screen.queryByRole("dialog", { name: "Add tour" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/\(sample\)/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Share tour link opens Send tour link (Home, Recipient, Review; Send; a Copy tour link action)", async () => {
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Share tour link" }));
    const dialog = await dialogNamed("Send tour link");
    for (const label of ["Home", "Recipient", "Review"]) expect(railHas(dialog, label)).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Copy tour link" })).toBeInTheDocument();
    expect(within(dialog).getAllByText("Tour preview").length).toBeGreaterThan(0);
    expect(finishLabel(dialog)).toBe("Send");
    expect(dialog.textContent).not.toMatch(/Step \d of \d/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Add availability opens the Tour availability pop-up with a Property select", async () => {
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Add availability" }));
    const dialog = await dialogNamed("Tour availability");
    expect(within(dialog).getAllByText("Property").length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a pending row opens the tour record: Tour and Communication, Confirm, Message guest, Reschedule, Decline, Delete tour", async () => {
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    fireEvent.click(tab("Pending"));
    fireEvent.click(screen.getByText("Morgan Ito"));
    expect(await screen.findByText("Prospect", {}, LONG)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Tour sections" });
    expect(within(nav).getByRole("link", { name: "Tour" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Communication" })).toBeInTheDocument();
    for (const name of ["Confirm", "Message guest", "Reschedule", "Decline", "Delete tour"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    for (const row of ["Status", "When", "Property", "Room", "Format"]) expect(screen.getAllByText(row).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^(RESIDENT|HOME|STATUS)$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Tour confirmed (sample)"));
    expect(screen.queryByText("Prospect")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an upcoming tour offers Cancel tour, and a pending row's menu is View, Message, Reschedule, Approve, Reject, Delete", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="tours" story={NO_STORY} />);
    fireEvent.click(tab("Pending"));
    await user.click(screen.getByRole("button", { name: /^Actions for Morgan Ito/ }));
    for (const name of ["View", "Message", "Reschedule", "Approve", "Reject", "Delete"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Archive|Mute/ })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Reschedule" }));
    expect(await dialogNamed("Reschedule tour")).toBeInTheDocument();
  });
});

describe("demo Applications tab matches the real Applications page", () => {
  it("has the real Pending, Approved and Declined tabs (no Incomplete), counted from the rows it draws", () => {
    render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    expect(screen.queryByRole("button", { name: /^Incomplete/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rejected/ })).toBeNull();
    // The two unfinished drafts stay out of the list (the sidebar badge counts submitted applications).
    const byTab = (id: string) => world.applications.filter((a) => a.bucket !== "incomplete" && applicationTabOf(a) === id).length;
    expect(tabCount("Pending")).toBe(world.badges.applications);
    expect(tabCount("Pending")).toBe(byTab("pending"));
    expect(tabCount("Approved")).toBe(byTab("approved"));
    expect(tabCount("Declined")).toBe(byTab("rejected"));
  });

  it("header icons are Filter, Send application link and the round + (no gear, no Share)", () => {
    render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    expect(bandIconNames().filter((name) => ["Filter", "Send application link", "Add application", "Settings", "Share tour link"].includes(name))).toEqual([
      "Filter",
      "Send application link",
      "Add application",
    ]);
  });

  it("the round + opens Add application: Applicant, Home, Application, Documents, Review, the file card, and the Add application footer", async () => {
    render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = await dialogNamed("Add application");
    for (const label of ["Applicant", "Home", "Application", "Documents", "Review"]) expect(railHas(dialog, label)).toBe(true);
    expect(within(dialog).getAllByText("Start from a file").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("PDF up to 3.5 MB").length).toBeGreaterThan(0);
    for (const field of ["Full name", "Email", "Phone", "Preferred contact"]) expect(within(dialog).getAllByText(field).length).toBeGreaterThan(0);
    expect(finishLabel(dialog)).toBe("Add application");
    for (const card of ["Applicant", "Home", "Application", "Documents"]) expect(within(dialog).getAllByText(card).length).toBeGreaterThan(0);
    fireEvent.click(dialog.querySelector("[data-attr='demo-popup-finish']")!);
    expect(screen.queryByRole("dialog", { name: "Add application" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/\(sample\)/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the Application step asks the real sections and the house's own questions", async () => {
    render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = await dialogNamed("Add application");
    fireEvent.click(within(dialog).getAllByRole("button", { name: /^Application/ })[0]!);
    for (const section of ["About them", "Employment & income", "Current address", "Previous address", "References & emergency contact", "Disclosures"]) {
      expect(within(dialog).getAllByText(section).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getAllByText(/ asks$/).length).toBeGreaterThan(0);
  });

  it("Send application link opens Send application (Home, Recipient, Review; Send), starting on Review", async () => {
    render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Send application link" }));
    const dialog = await dialogNamed("Send application");
    for (const label of ["Home", "Recipient", "Review"]) expect(railHas(dialog, label)).toBe(true);
    expect(within(dialog).getAllByText("Invite preview").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row opens the application record: Application, Background check, Communication, Approve and Decline, never a generic card", async () => {
    render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    fireEvent.click(screen.getByText("Mason Clark"));
    const nav = await screen.findByRole("navigation", { name: "Application sections" }, LONG);
    for (const label of Object.values(APPLICATION_DETAIL_TAB_LABELS)) expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    for (const name of ["Approve", "Download", "Delete", "Upload for resident", "Decline"]) expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/^(RESIDENT|HOME|STATUS)$/)).toBeNull();
    fireEvent.click(within(nav).getByRole("link", { name: "Background check" }));
    expect((await screen.findAllByText("Passed", {}, LONG)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Application declined (sample)"));
    expect(tabCount("Declined")).toBe(world.applications.filter((a) => a.bucket !== "incomplete" && applicationTabOf(a) === "rejected").length + 1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the row menu is View first, then Approve, Download, Decline (pending) and has no Archive / Mute", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    await user.click(screen.getByRole("button", { name: /^Actions for Mason Clark/ }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim());
    expect(items[0]).toBe("View");
    expect(items).toEqual(expect.arrayContaining(["Approve", "Download", "Decline"]));
    expect(items).not.toContain("Archive");
    expect(items).not.toContain("Mute reminders");
  });
});

describe("demo Leases tab matches the real Leases page", () => {
  it("has the real Draft, Resident signature, Manager signature and Signed tabs, counted from the rows it draws", () => {
    render(<DemoPanel portal="manager" tab="leases" story={NO_STORY} />);
    expect(screen.queryByRole("button", { name: /^Manager review/ })).toBeNull();
    for (const { id, label } of LEASE_TAB_LABELS) expect(tabCount(label)).toBe(world.leases.filter((l) => l.bucket === id).length);
    expect(LEASE_TAB_LABELS.map((t) => t.label)).toEqual(["Draft", "Resident signature", "Manager signature", "Signed"]);
  });

  it("header icons are Filter, Lease settings and the round + (a gear that only toasts)", () => {
    render(<DemoPanel portal="manager" tab="leases" story={NO_STORY} />);
    expect(bandIconNames().filter((name) => ["Filter", "Lease settings", "Add lease", "Export"].includes(name))).toEqual(["Filter", "Lease settings", "Add lease"]);
    fireEvent.click(screen.getByRole("button", { name: "Lease settings" }));
    expect(screen.getByRole("status").textContent).toMatch(/\(sample\)/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Filter opens the real popover with Property, Stage and Updated", async () => {
    render(<DemoPanel portal="manager" tab="leases" story={NO_STORY} />);
    await openFilter("leases-filter-sheet-open");
    for (const field of ["Property", "Stage", "Updated"]) expect((await screen.findAllByText(field, {}, LONG)).length).toBeGreaterThan(0);
  });

  it("the round + opens Send lease: one dialog with no step rail and the Send for signature footer", async () => {
    render(<DemoPanel portal="manager" tab="leases" story={NO_STORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Add lease" }));
    const dialog = await dialogNamed(/^Send lease/);
    expect(within(dialog).queryByRole("button", { name: /^Next/ })).toBeNull();
    expect(dialog.querySelector("[data-attr='demo-popup-finish']")).toBeNull();
    for (const text of ["Start from a file", "Resident", "PropLane lease", "Upload PDF", "Lease form", "This is the lease I'm sending", "Payments schedule"]) {
      expect(within(dialog).getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getAllByText(/^Waive the lease fee/).length).toBeGreaterThan(0);
    for (const label of ["Lease start", "Lease end", "Monthly rent", "Security deposit"]) expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send for signature" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/\(sample\)/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row opens the lease record: Lease and Communication, who signed, Send lease for a draft", async () => {
    render(<DemoPanel portal="manager" tab="leases" story={NO_STORY} />);
    fireEvent.click(tab("Draft"));
    fireEvent.click(screen.getByText("Morgan Ito"));
    const nav = await screen.findByRole("navigation", { name: "Lease sections" }, LONG);
    expect(within(nav).getByRole("link", { name: "Lease" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Communication" })).toBeInTheDocument();
    expect(screen.getByLabelText("Who signed")).toBeInTheDocument();
    for (const name of ["Edit lease", "Send lease", "Download", "Mark as signed", "Delete"]) expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/^(RESIDENT|HOME|STATUS)$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send lease" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Lease sent for signature (sample)"));
    expect(tabCount("Resident signature")).toBe(world.leases.filter((l) => l.bucket === "resident").length + 1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the row menu is View first, then Send (drafts), Download, Mark as signed, Delete", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="leases" story={NO_STORY} />);
    fireEvent.click(tab("Draft"));
    await user.click(screen.getByRole("button", { name: /^Actions for Morgan Ito/ }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim());
    expect(items).toEqual(["View", "Send", "Download", "Mark as signed", "Delete"]);
  });
});
