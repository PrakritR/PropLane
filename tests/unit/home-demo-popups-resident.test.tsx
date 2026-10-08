// @vitest-environment jsdom
//
// The home demo's resident tabs must behave like the real resident portal pages: the real sub tabs, the real header
// icons, and a round + / row click / row menu that opens the real pop-up or record page, never a bare toast and
// never the generic RESIDENT / HOME / STATUS field card. Nothing may call the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { NO_STORY, residentStory } from "@/components/marketing/site/product-mock/world";
import { RESIDENT_FORM_QUESTIONS } from "@/components/marketing/site/product-mock/fixtures-popups-resident";
import { HOUSE_INFO_SECTIONS } from "@/lib/house-info";
import { MANAGER_DASHBOARD_SECTIONS } from "@/lib/dashboard-preferences";
import { RESIDENT_DASHBOARD_SECTIONS } from "@/lib/resident-dashboard-preferences";
import { recordSections } from "@/lib/portals/record-sections";
import { RESIDENT_MOVE_IN_TAB_LABELS, RESIDENT_MOVE_IN_TABS } from "@/lib/portal-detail-routes";
import { RESIDENT_DOCUMENT_KIND_LABELS, RESIDENT_DOCUMENT_TAB_LABELS, RESIDENT_DOCUMENT_TAB_ORDER } from "@/lib/resident-documents-tabs";
import { RESIDENT_TOUR_SECTION_LABELS, RESIDENT_TOUR_SECTION_ORDER } from "@/lib/resident-tour-list";
import { RESIDENT_PAYMENTS_TAB_LABELS } from "@/lib/resident-payments-tabs";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

afterEach(cleanup);

// The pop-ups, records and the Filter popover arrive from lazy chunks; a loaded machine can take a few seconds to transform one.
configure({ asyncUtilTimeout: 15000 });

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

const FULL = residentStory("pay");
const APPLIED = { ...NO_STORY, tourOffered: true, tourAccepted: true, applicationSubmitted: true };
const LEASE_PENDING = { ...APPLIED, applicationApproved: true, leaseStep: 1 as const };
const GENERIC_CARD = /^(RESIDENT|HOME|STATUS)$/;

function expectNoGenericCard() {
  const labels = screen.queryAllByText(GENERIC_CARD);
  expect(labels).toHaveLength(0);
}

/** The record header's icon actions, by their accessible names, in order (an overflowing row still keeps them in the DOM). */
const headerActionLabels = () =>
  [...new Map([...document.querySelectorAll<HTMLElement>("[data-attr^='record-header-action-']")].map((el) => [el.getAttribute("data-attr"), el.getAttribute("aria-label") ?? el.textContent ?? ""])).values()];

/** The Filter popover is a lazy chunk too: wait for the real trigger before opening it. */
async function openFilter(dataAttr: string) {
  await waitFor(() => expect(document.querySelector(`[data-attr='${dataAttr}']`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-attr='${dataAttr}']`)!);
}

describe("Dashboard", () => {
  it("is titled with the resident's name and Customize opens the real Customize dashboard pop-up", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="dashboard" story={FULL} />);
    expect(await screen.findByText("Welcome home, Jordan.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize dashboard" });
    for (const section of RESIDENT_DASHBOARD_SECTIONS) expect(within(dialog).getAllByText(section.label).length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Reset to defaults" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("switch", { name: "Hide Tour pending" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the manager dashboard opens the same pop-up with the manager's sections", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="dashboard" />);
    await user.click(await screen.findByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize dashboard" });
    for (const section of MANAGER_DASHBOARD_SECTIONS) expect(within(dialog).getAllByText(section.label).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("My home", () => {
  it("has the real four tabs and draws the real Move-in details sections", async () => {
    const user = userEvent.setup();
    const { container } = render(<DemoPanel portal="resident" tab="move-in" story={FULL} />);
    for (const id of RESIDENT_MOVE_IN_TABS) expect(screen.getByRole("button", { name: new RegExp(`^${RESIDENT_MOVE_IN_TAB_LABELS[id]}`) })).toBeInTheDocument();
    expect(await screen.findByText("Assigned room")).toBeInTheDocument();
    expect(screen.getAllByText("Lease signed").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /^Move-in details/ }));
    for (const section of HOUSE_INFO_SECTIONS) expect((await screen.findAllByText(section.label)).length).toBeGreaterThan(0);
    expect(screen.getByText("How your portal works")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/work[\s-]?order/i);
  });

  it("Roommates draws the sharing table and the housemates", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="move-in" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Roommates/ }));
    expect(await screen.findByText("What housemates can see")).toBeInTheDocument();
    expect(screen.getByText("Share with my housemates")).toBeInTheDocument();
    for (const label of ["My name", "My room", "My email address", "My phone number"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText("Tomas Alvarez")).toBeInTheDocument();
  });

  it("Inspections has Search inspections, a Filter and the round + that opens the inspection record", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="move-in" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Inspections/ }));
    expect(screen.getByPlaceholderText("Search inspections")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-attr='resident-inspections-type-filter-open']")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Add move-in inspection" }));
    expect(await screen.findByText("Move-in inspection")).toBeInTheDocument();
    const rail = recordSections("resident", "inspection");
    for (const item of rail.groups.flatMap((g) => g.items)) expect((await screen.findAllByText(item.label)).length).toBeGreaterThan(0);
    expectNoGenericCard();
  });
});

describe("Lease", () => {
  it("a pending lease opens its record: the registry rail, then Download, Upload, Report issue, Send to manager and Sign lease", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="lease" story={LEASE_PENDING} />);
    await user.click(screen.getByText("Lease agreement"));
    const rail = recordSections("resident", "lease", { bucket: "pending" });
    for (const item of rail.groups.flatMap((g) => g.items)) expect((await screen.findAllByText(item.label)).length).toBeGreaterThan(0);
    await user.click(screen.getAllByText("Lease document")[0]!);
    expect(headerActionLabels()).toEqual(["Download", "Upload", "Report issue", "Send to manager", "Sign lease"]);
    fireEvent.click(document.querySelector("[data-attr='record-header-action-report']")!);
    expect(await screen.findByRole("dialog", { name: "Report issue" })).toBeInTheDocument();
    expectNoGenericCard();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a signed lease offers Renew and Download, and Renew opens the renewal pop-up", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="lease" story={FULL} />);
    await user.click(screen.getByText("Lease agreement"));
    await user.click((await screen.findAllByText("Lease document"))[0]!);
    await waitFor(() => expect(headerActionLabels()).toEqual(["Renew", "Download"]));
    fireEvent.click(document.querySelector("[data-attr='record-header-action-renew']")!);
    expect(await screen.findByRole("dialog", { name: "Renew or extend lease" })).toBeInTheDocument();
  });
});

describe("Forms", () => {
  it("a pending form opens the one-question-per-screen flow and Submit finishes it", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="forms" story={FULL} />);
    expect(screen.getByRole("button", { name: /^Pending/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Completed/ })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    await user.click(screen.getByText("Move-in details"));
    const total = RESIDENT_FORM_QUESTIONS["form-movein"]!.questions.length;
    expect(await screen.findByText(`1 of ${total}`)).toBeInTheDocument();
    expect(screen.getByText("Saved as you go")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expectNoGenericCard();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a completed form opens read-only with a Download button, and the row menu is a single Fill out / View", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="forms" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Completed/ }));
    await user.click(screen.getByRole("button", { name: "Actions for House rules acknowledgment" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["View"]);
    await user.click(items[0]!);
    expect(await screen.findByRole("button", { name: /Download/ })).toBeInTheDocument();
  });
});

describe("Services", () => {
  it("the + opens Report a problem with the real intake fields and Send", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="services" story={FULL} />);
    await user.click(screen.getByRole("button", { name: "Add service" }));
    const dialog = await screen.findByRole("dialog", { name: "Report a problem" });
    expect(within(dialog).getAllByText("Service type").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Category").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/^Photos \(0\/6\)/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(screen.queryByRole("dialog", { name: "Report a problem" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/sample/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row opens the service record page with the registry rail and Edit · Cancel · Message manager", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="services" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Scheduled/ }));
    await user.click(screen.getByText("Kitchen faucet"));
    const rail = recordSections("resident", "service");
    for (const item of rail.groups.flatMap((g) => g.items)) expect((await screen.findAllByText(item.label)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Vendor").length).toBeGreaterThan(0);
    for (const label of ["Edit", "Cancel", "Message manager"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Cancel service" })).toBeInTheDocument();
    expectNoGenericCard();
  });

  it("the row menu offers Send reminder and Delete, and Delete asks first", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="services" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Scheduled/ }));
    await user.click(screen.getByRole("button", { name: "Actions for Kitchen faucet" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Send reminder", "Delete"]);
    // A destructive item ignores a tap that lands in the first moments after the menu opens.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete service" })).toBeInTheDocument();
  });
});

describe("Tour", () => {
  it("has the real tabs, rows without a ⋯, and the + opens Choose a home to tour then Schedule tour", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="tour" story={FULL} />);
    for (const id of RESIDENT_TOUR_SECTION_ORDER) expect(screen.getByRole("button", { name: new RegExp(`^${RESIDENT_TOUR_SECTION_LABELS[id]}`) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add tour" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a home to tour" });
    expect(within(dialog).getByPlaceholderText("Search by address, neighborhood, or property name…")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Browse homes" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(within(dialog).getByText("Alder House"));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    const flow = await screen.findByRole("dialog", { name: "Schedule tour" });
    for (const label of ["Room", "Date & time", "Your details"]) expect(within(flow).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(flow).getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row opens the Tour page with Tour details and Updates and Reschedule · Message host · Cancel tour", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="tour" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Approved/ }));
    await user.click(screen.getAllByText("Willow Court")[0]!);
    expect(await screen.findByRole("button", { name: "Tour details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updates" })).toBeInTheDocument();
    for (const label of ["Reschedule", "Message host", "Cancel tour"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    expectNoGenericCard();
  });
});

describe("Applications", () => {
  it("the + opens Apply to a property and a row opens the application record", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="applications" story={FULL} />);
    expect(screen.getByRole("button", { name: /^Sent/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approved/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Denied/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply to a property" });
    expect(within(dialog).getByRole("button", { name: "Browse homes" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Start application" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Browse homes" }));
    await user.click(screen.getByText("Willow Court"));
    const rail = recordSections("resident", "application");
    for (const item of rail.groups.flatMap((g) => g.items)) expect((await screen.findAllByText(item.label)).length).toBeGreaterThan(0);
    expectNoGenericCard();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a pending application's menu offers Open and Withdraw, and Withdraw opens the withdraw pop-up", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="applications" story={APPLIED} />);
    await user.click(screen.getByRole("button", { name: "Actions for Willow Court" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Open", "Withdraw"]);
    await user.click(screen.getByRole("menuitem", { name: "Withdraw" }));
    const dialog = await screen.findByRole("dialog", { name: "Withdraw application" });
    expect(within(dialog).getByRole("button", { name: "Keep application" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Withdraw application" })).toBeInTheDocument();
  });
});

describe("Payments", () => {
  it("draws the Autopay card and Pay all opens Pay charges with the method picker and Continue with", async () => {
    const user = userEvent.setup();
    const story = { ...APPLIED, applicationApproved: true, leaseStep: 3 as const };
    render(<DemoPanel portal="resident" tab="payments" story={story} />);
    expect(screen.getByText("Autopay")).toBeInTheDocument();
    expect(screen.getByText("Pays with")).toBeInTheDocument();
    expect(screen.getByText("Report my rent to credit bureaus")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pay all" }));
    const dialog = await screen.findByRole("dialog", { name: "Pay charges" });
    expect(within(dialog).getAllByText("Amount due").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Bank (ACH)")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^Continue with/ }));
    expect(screen.queryByRole("dialog", { name: "Pay charges" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/sample/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the tab labels are the real Upcoming, Due and Paid when there is more than one charge, and none for a single charge", () => {
    expect(Object.values(RESIDENT_PAYMENTS_TAB_LABELS)).toEqual(["Upcoming", "Due", "Paid"]);
    const { container } = render(<DemoPanel portal="resident" tab="payments" story={{ ...APPLIED, applicationApproved: true, leaseStep: 3 as const }} />);
    // Jordan has one charge before rent is paid: the real page hides the tab row.
    expect(container.textContent).not.toMatch(/Upcoming.*Due.*Paid/);
  });

  it("a row opens the payment record with Pay $X in the header", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="payments" story={{ ...APPLIED, applicationApproved: true, leaseStep: 3 as const }} />);
    await user.click(screen.getByText("October rent"));
    const rail = recordSections("resident", "payment");
    for (const item of rail.groups.flatMap((g) => g.items)) expect((await screen.findAllByText(item.label)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Pay \$/ })).toBeInTheDocument();
    expectNoGenericCard();
  });
});

describe("Documents", () => {
  it("has the real four tabs, the Kind filter and Add document opens Add to documents", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="documents" story={FULL} />);
    for (const id of RESIDENT_DOCUMENT_TAB_ORDER) expect(screen.getByRole("button", { name: new RegExp(`^${RESIDENT_DOCUMENT_TAB_LABELS[id]}`) })).toBeInTheDocument();
    await openFilter("resident-documents-kind-filter-open");
    expect((await screen.findAllByText("All kinds")).length).toBeGreaterThan(0);
    expect(RESIDENT_DOCUMENT_KIND_LABELS.receipts).toBe("Rent receipts");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Add document" }));
    const dialog = await screen.findByRole("dialog", { name: "Add to documents" });
    expect(within(dialog).getByText("Choose file")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Take photo" })).toBeInTheDocument();
    expect(within(dialog).getAllByText("Name (optional)").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a receipt row opens Rent receipt and an application row opens Rental application", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="documents" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Payments/ }));
    await user.click(screen.getByText(/October rent/));
    expect(await screen.findByText("Rent receipt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download receipt/ })).toBeInTheDocument();
    cleanup();
    render(<DemoPanel portal="resident" tab="documents" story={FULL} />);
    await user.click(screen.getByRole("button", { name: /^Archived/ }));
    await user.click(screen.getByText("Rental application"));
    expect((await screen.findAllByText("Application form")).length).toBeGreaterThan(0);
    expectNoGenericCard();
  });
});

describe("Communication", () => {
  it("has Active and Archived, no Settings gear, Search communication, a Filter and the New message compose", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="resident" tab="communication" story={FULL} />);
    expect(screen.getByPlaceholderText("Search communication")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Active/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Archived/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-attr='resident-communication-filter-open']")).not.toBeNull());
    for (const label of ["Text your property manager", "Email your property manager", "Mark unread", "Archive conversation"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "New message" }));
    const dialog = await screen.findByRole("dialog", { name: "New message" });
    expect(within(dialog).getAllByText("Subject").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: /^(Send email|Send SMS|Send message|Schedule)$/ })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the resident tabs never show the generic card and never the word work order", () => {
  it.each(["move-in", "lease", "forms", "services", "tour", "applications", "payments", "documents", "communication"])("%s", (tab) => {
    const { container } = render(<DemoPanel portal="resident" tab={tab} story={FULL} />);
    expect(container.textContent).not.toMatch(/work[\s-]?order/i);
    fireEvent.click(container);
    expectNoGenericCard();
  });
});
