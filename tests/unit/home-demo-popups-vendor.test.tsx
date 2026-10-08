// @vitest-environment jsdom
//
// The home demo's vendor tabs must behave like the real vendor portal: the same sub tabs (labels from the real
// constants, counts derived from the rows drawn), the same header icons, the round + opening the real pop-up (title,
// step rail, footer words), a row opening the real record page or pop-up, the row menu per stage, and nothing ever
// calling the network. The generic RESIDENT / HOME / STATUS field card must never come back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { VendorDashboardBalanceDemo } from "@/components/marketing/site/product-mock/panels-vendor";
import { VENDOR_REVIEWS } from "@/components/marketing/site/product-mock/fixtures";
import { DEMO_REFUNDS, DEMO_STATEMENTS, DEMO_TAX_YEARS, EXTRA_VENDOR_SERVICES, FIND_WORK_BOARD } from "@/components/marketing/site/product-mock/fixtures-popups-vendor";
import { VENDOR_PAYOUTS } from "@/components/marketing/site/product-mock/fixtures-more";
import { vendorServices, vendorStory } from "@/components/marketing/site/product-mock/world";
import { VENDOR_WORK_ORDER_TABS } from "@/lib/vendor-work-order-tabs";
import { VENDOR_REVIEW_STATUS_TABS } from "@/lib/vendor-reviews";
import { VENDOR_PAYMENT_BUCKETS } from "@/lib/vendor-payments";
import { VENDOR_DOCUMENT_LABELS, VENDOR_DOCUMENT_SECTIONS } from "@/lib/vendor-documents";
import { VENDOR_CALENDAR_VIEW_TABS } from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import { vendorPortal } from "@/lib/portals/vendor";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

afterEach(cleanup);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

/** The story where the faucet job is only offered: an open job, a calendar week with the standing visits. */
const OFFER = vendorStory("offer");

const railLabels = (sections: ReturnType<typeof recordSections>) => sections.groups.flatMap((g) => g.items.map((i) => i.label));

/** A real tab button whose label starts with `label` (the count follows the label). */
const tabButton = (label: string) =>
  screen.getAllByRole("button", { name: new RegExp(`^${label}(\\s*\\d+ items?)?$`) }).find((el) => el.tagName === "BUTTON")!;

/** A step of a pop-up's rail (the wizard shell also prints the labels in its progress strip and review cards). */
function clickStep(dialog: HTMLElement, label: string) {
  const nav = dialog.querySelector("nav");
  fireEvent.click(within((nav as HTMLElement | null) ?? dialog).getAllByText(label)[0]!);
}

/** No generic field card: no RESIDENT / HOME / STATUS boxes, anywhere in the panel. */
function expectNoGenericCard(root: HTMLElement = document.body) {
  expect(within(root).queryByText(/^Resident$/)).toBeNull();
  expect(within(root).queryByText(/^Home$/)).toBeNull();
}

describe("vendor Services matches the real Services page", () => {
  it("has the real stage tabs plus Find work, counted from the rows it draws", () => {
    render(<DemoPanel portal="vendor" tab="work-orders" story={OFFER} />);
    const labels = [...VENDOR_WORK_ORDER_TABS.map((t) => t.label), "Find work"];
    for (const label of labels) expect(tabButton(label)).toBeInTheDocument();
    expect(labels).toEqual(["Open", "Assigned", "Scheduled", "Completed", "Find work"]);
    const all = [...vendorServices(OFFER), ...EXTRA_VENDOR_SERVICES];
    for (const stage of ["open", "assigned", "scheduled", "completed"] as const) {
      const label = VENDOR_WORK_ORDER_TABS.find((t) => t.id === stage)!.label;
      expect(tabButton(label).textContent).toContain(String(all.filter((s) => s.state === stage).length));
    }
    expect(tabButton("Find work").textContent).toContain(String(FIND_WORK_BOARD.length));
    // header icons: Filter, Service settings, and the round Add bid
    expect(screen.getByRole("button", { name: "Service settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add bid" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the round + opens Submit bid with the real rail and footer, and Submit bid closes it", async () => {
    render(<DemoPanel portal="vendor" tab="work-orders" story={OFFER} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bid" }));
    const dialog = await screen.findByRole("dialog", { name: "Submit bid" });
    for (const label of ["Service", "House", "When", "Bid", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Service preview")).toBeInTheDocument();
    clickStep(dialog, "Bid");
    expect(within(dialog).getByText("Labor")).toBeInTheDocument();
    expect(within(dialog).getByText("Materials")).toBeInTheDocument();
    expect(within(dialog).getByText("Note")).toBeInTheDocument();
    clickStep(dialog, "Review");
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit bid" }));
    expect(screen.queryByRole("dialog", { name: "Submit bid" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Bid submitted/);
    expectNoGenericCard();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an open job shows only its general area, and the row opens the service record page", async () => {
    render(<DemoPanel portal="vendor" tab="work-orders" story={OFFER} />);
    expect(screen.getByText("Near you")).toBeInTheDocument();
    expect(screen.queryByText(/Maple Duplex/)).toBeNull();
    fireEvent.click(screen.getByText("No hot water"));
    await screen.findByRole("button", { name: "Message the manager" });
    const rail = railLabels(recordSections("vendor", "job", { basePath: "/vendor" }));
    expect(rail).toEqual(["Overview", "Estimate & bid", "Schedule", "Invoice", "Payments", "Communication", "Documents"]);
    for (const label of rail) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    // header: Message the manager, the round primary labelled with the next step, and a More menu
    expect(document.querySelector("[data-attr='vendor-job-primary']")?.getAttribute("aria-label")).toBe("Submit bid");
    expect(screen.getByRole("button", { name: "Actions for More" })).toBeInTheDocument();
    // Estimate & bid sub tabs
    fireEvent.click(screen.getAllByText("Estimate & bid")[0]!);
    for (const label of ["Bid", "Estimate", "Estimate visit", "Decline"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expectNoGenericCard();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the row menu is per stage: Open offers Submit bid, Book visit, Decline; Scheduled offers Reschedule, Complete", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="work-orders" story={OFFER} />);
    await user.click(screen.getByRole("button", { name: /Actions for No hot water/ }));
    for (const label of ["Submit bid", "Book visit", "Decline"]) expect(await screen.findByText(label)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(tabButton("Scheduled"));
    await user.click(screen.getByRole("button", { name: /Actions for Kitchen faucet drip/ }));
    for (const label of ["Reschedule", "Complete"]) expect(await screen.findByText(label)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Completed: Send invoice opens Request payment (Service, Invoice, Review)", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="work-orders" story={OFFER} />);
    await user.click(tabButton("Completed"));
    await user.click(screen.getByRole("button", { name: /Actions for Replace bathroom exhaust fan/ }));
    await user.click(await screen.findByText("Send invoice"));
    const dialog = await screen.findByRole("dialog", { name: "Request payment" });
    for (const label of ["Service", "Invoice", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    clickStep(dialog, "Invoice");
    expect(within(dialog).getByText("Invoice number")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Amount").length).toBeGreaterThan(0);
    clickStep(dialog, "Review");
    expect(within(dialog).getByRole("button", { name: "Request payment" })).toBeInTheDocument();
  });

  it("Find work draws the real rows with Bid now, Needs an estimate visit and Message the manager", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="work-orders" story={OFFER} />);
    await user.click(tabButton("Find work"));
    for (const service of FIND_WORK_BOARD) expect(screen.getByText(service.title)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Actions for Water heater flush/ }));
    for (const label of ["Bid now", "Needs an estimate visit", "Message the manager"]) expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe("vendor Calendar matches the real Calendar page", () => {
  it("has All, Services, Availability with the real labels and Integrations, never the old Google label", () => {
    render(<DemoPanel portal="vendor" tab="calendar" story={OFFER} />);
    expect(VENDOR_CALENDAR_VIEW_TABS).toEqual(["all", "services", "availability"]);
    for (const label of ["All", "Services", "Availability"]) expect(tabButton(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Integrations" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Google Calendar/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add availability" })).toBeInTheDocument();
  });

  it("Add availability opens Set availability with weekly hours, date overrides and Save", async () => {
    render(<DemoPanel portal="vendor" tab="calendar" story={OFFER} />);
    fireEvent.click(screen.getByRole("button", { name: "Add availability" }));
    const dialog = await screen.findByRole("dialog", { name: "Set availability" });
    expect(within(dialog).getByText("Weekly hours")).toBeInTheDocument();
    expect(within(dialog).getByText("Date overrides")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Availability saved/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a visit opens the quick-look with Open and a message icon and no footer", async () => {
    render(<DemoPanel portal="vendor" tab="calendar" story={OFFER} />);
    fireEvent.click(screen.getAllByText("Kitchen faucet drip")[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Kitchen faucet drip" });
    expect(within(dialog).getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Message the manager" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Save|Submit|Done/ })).toBeNull();
    expect(within(dialog).getByText("Property")).toBeInTheDocument();
    expectNoGenericCard();
  });
});

describe("vendor Reviews matches the real Reviews page", () => {
  it("has the four stat cells above All, Needs reply, Replied, counted from the rows", () => {
    render(<DemoPanel portal="vendor" tab="reviews" />);
    const stats = screen.getByTestId("vendor-reviews-stats");
    for (const label of ["Average rating", "Reviews", "Needs reply", "Response rate"]) expect(within(stats).getByText(label)).toBeInTheDocument();
    const needs = VENDOR_REVIEWS.filter((r) => !r.reply).length;
    expect(within(stats).getByText("Needs reply").nextElementSibling?.textContent).toBe(String(needs));
    for (const tab of VENDOR_REVIEW_STATUS_TABS) expect(tabButton(tab.label)).toBeInTheDocument();
    expect(tabButton("Replied").textContent).toContain(String(VENDOR_REVIEWS.length - needs));
    expect(screen.getByRole("button", { name: "Profile settings" })).toBeInTheDocument();
  });

  it("an unreplied row opens Reply to review, and the quick replies toggle lists replies", async () => {
    render(<DemoPanel portal="vendor" tab="reviews" />);
    fireEvent.click(screen.getByText("Good work on the disposal. Arrived 20 minutes after the window started."));
    const dialog = await screen.findByRole("dialog", { name: "Reply to review" });
    expect(within(dialog).getByText("Your reply")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Quick replies" }));
    expect(within(dialog).getByText("Manage quick replies")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Thanks for the feedback." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save reply" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Reply sent/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the row menu offers Reply and Reply with a quick reply; a replied row offers Edit reply", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="reviews" />);
    await user.click(screen.getAllByRole("button", { name: "A PropLane manager actions" })[0]!);
    expect(await screen.findByRole("menuitem", { name: "Reply" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reply with a quick reply" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(tabButton("Replied"));
    await user.click(screen.getAllByRole("button", { name: "A PropLane manager actions" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Edit reply" }));
    expect(await screen.findByRole("dialog", { name: "Edit reply" })).toBeInTheDocument();
  });
});

describe("vendor Finances draws all five sections", () => {
  it("Balance & payouts: the stat strip, Bank and Withdraw, one Payouts tab counted from its rows", async () => {
    render(<DemoPanel portal="vendor" tab="financials" sub="balance" story={OFFER} />);
    for (const label of ["Available", "Pending", "Held", "On the way"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(tabButton("Payouts").textContent).toContain(String(VENDOR_PAYOUTS.length + 1));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("dialog", { name: "Withdraw" });
    expect(within(dialog).getAllByText("Amount").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Max" })).toBeInTheDocument();
    expect(within(dialog).getAllByText("To").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/Standard/).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/Instant/).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Withdraw \$/ }));
    expect(screen.queryByRole("dialog", { name: "Withdraw" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bank" }));
    const bank = await screen.findByRole("dialog", { name: "Add a bank account" });
    expect(within(bank).getByText("Routing number")).toBeInTheDocument();
    expect(within(bank).getByRole("button", { name: "Add account" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Balance & payouts: a payout row opens the payout record; Retry is on failed rows only", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="financials" story={OFFER} />);
    expect(screen.getAllByRole("button", { name: /Standard payout actions/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Standard payout actions/ }));
    expect(await screen.findByRole("menuitem", { name: "Retry" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.click(screen.getAllByText("Standard payout")[0]!);
    expect(await screen.findByRole("button", { name: "Receipt" })).toBeInTheDocument();
    expect(screen.getByText("Sent to your bank")).toBeInTheDocument();
  });

  it("Payments: Pending, Paid, Overdue with no balance card; Add payment opens Request payment", async () => {
    render(<DemoPanel portal="vendor" tab="financials" sub="income" story={OFFER} />);
    for (const bucket of VENDOR_PAYMENT_BUCKETS) expect(tabButton(bucket.label)).toBeInTheDocument();
    expect(screen.queryByText("Available now")).toBeNull();
    expect(screen.getByRole("button", { name: "Export invoices CSV" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payout settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    const dialog = await screen.findByRole("dialog", { name: "Request payment" });
    for (const label of ["Service", "Invoice", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Payments: a pending invoice menu has View invoice, Edit and Retract invoice; its record has the invoice rail and icons", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="financials" sub="income" story={OFFER} />);
    await user.click(screen.getByRole("button", { name: "INV-1015 actions" }));
    for (const name of ["View invoice", "Edit", "Retract invoice"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "View invoice" }));
    const rail = railLabels(recordSections("vendor", "invoice", { basePath: "/vendor" }));
    for (const label of rail) expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    for (const name of ["Edit", "Withdraw", "Download", "Submit"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  it("Payments: a paid row offers View payment, Download and Refund, and Refund opens the Refund a payment dialog", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="financials" sub="income" story={OFFER} />);
    await user.click(tabButton("Paid"));
    await user.click(screen.getByRole("button", { name: "INV-1012 actions" }));
    for (const name of ["View payment", "Download", "Refund"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Refund" }));
    const dialog = await screen.findByRole("dialog", { name: "Refund a payment" });
    expect(within(dialog).getByText("Reason")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Refund \$/ })).toBeInTheDocument();
  });

  it("Refunds: no tabs, rows from the fixtures, the round Refund a payment, and Refresh status in the menu", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="financials" sub="refunds" story={OFFER} />);
    for (const refund of DEMO_REFUNDS) expect(screen.getByText(refund.paymentLabel)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /actions$/ })[0]!);
    expect(await screen.findByRole("menuitem", { name: "Refresh status" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.click(screen.getByRole("button", { name: "Refund a payment" }));
    const dialog = await screen.findByRole("dialog", { name: "Refund a payment" });
    expect(within(dialog).getByText("Payment")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Amount").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Refund \$/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Statements: one Statements tab counted from its months; a row opens the month's statement without a primary", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="vendor" tab="financials" sub="statements" story={OFFER} />);
    expect(tabButton("Statements").textContent).toContain(String(DEMO_STATEMENTS.length));
    expect(screen.getByRole("button", { name: "Export all activity CSV" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("September 2025"));
    const dialog = await screen.findByRole("dialog", { name: "September 2025" });
    expect(within(dialog).getByText("Opening")).toBeInTheDocument();
    expect(within(dialog).getByText("Closing")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Save|Submit|Done|Withdraw/ })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "August 2025 actions" }));
    for (const name of ["View statement", "Download PDF", "Download CSV"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
  });

  it("Tax info: a W-9 card with a masked id, Tax years tab, and Edit W-9 opens the W-9 dialog", async () => {
    render(<DemoPanel portal="vendor" tab="financials" sub="tax" story={OFFER} />);
    expect(screen.getByText("W-9")).toBeInTheDocument();
    expect(tabButton("Tax years").textContent).toContain(String(DEMO_TAX_YEARS.length));
    expect(screen.getByText(/••-•••0000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit W-9" }));
    const dialog = await screen.findByRole("dialog", { name: "W-9" });
    expect(within(dialog).getByText("Legal name")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Submit W-9" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{2}-\d{7}/);
  });

  it("the Finances sub-rows are the real nav ids", () => {
    const finances = vendorPortal.sections.find((s) => s.section === "financials")!;
    expect(finances.tabs.map((t) => t.id)).toEqual(["balance", "income", "refunds", "statements", "tax"]);
  });
});

describe("vendor Documents matches the real Documents page", () => {
  it("groups the nine kinds by Tax, Business license, Insurance with N of M", () => {
    render(<DemoPanel portal="vendor" tab="documents" />);
    for (const section of VENDOR_DOCUMENT_SECTIONS) {
      const heading = screen.getByText(section.label, { selector: "span" });
      expect(heading.parentElement?.textContent).toMatch(new RegExp(`\\d of ${section.kinds.length}`));
      for (const kind of section.kinds) expect(screen.getByText(VENDOR_DOCUMENT_LABELS[kind])).toBeInTheDocument();
    }
    expect(screen.getByText("1099 form (prior year)")).toBeInTheDocument();
    expect(screen.getByText("Sales tax permit")).toBeInTheDocument();
    // manager-shared documents
    expect(screen.getByText("Vendor onboarding packet")).toBeInTheDocument();
  });

  it("Add document opens Upload document (Type, File, Review) with Upload", async () => {
    render(<DemoPanel portal="vendor" tab="documents" />);
    fireEvent.click(screen.getByRole("button", { name: "Add document" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload document" });
    for (const label of ["Type", "File", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    clickStep(dialog, "Review");
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/uploaded/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an uploaded row toggles the inline viewer; a missing row only asks for a file", async () => {
    render(<DemoPanel portal="vendor" tab="documents" />);
    fireEvent.click(screen.getByText("Signed W-9"));
    expect(await screen.findByRole("button", { name: "Download PDF" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Signed W-9"));
    expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
    fireEvent.click(screen.getByText("Certificate of insurance"));
    expect(screen.getByRole("status").textContent).toMatch(/Choose a PDF/);
  });
});

describe("vendor Communication matches the real Communication page", () => {
  it("has Active and Archived, Search communication, the settings gear, and New message opens the compose dialog", async () => {
    render(<DemoPanel portal="vendor" tab="communication" />);
    expect(tabButton("Active")).toBeInTheDocument();
    expect(tabButton("Archived")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search communication")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Communication settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    const dialog = await screen.findByRole("dialog", { name: "New message" });
    expect(within(dialog).getByText("Subject")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Send email" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send email" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Message sent/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("vendor Dashboard balance card", () => {
  it("shows Available to withdraw and Withdraw opens the Withdraw dialog", async () => {
    render(<VendorDashboardBalanceDemo />);
    expect(screen.getByText("Available to withdraw")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("dialog", { name: "Withdraw" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
