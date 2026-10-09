// @vitest-environment jsdom
//
// The home demo's manager Payments (incoming), Services and Communication tabs must behave like the real pages
// (pro-payments, pro-all-services-panel, pro-communication): the real tab labels counted from the rows the panel
// draws, the real header icons, the round + opens the real pop-up (Add charge / Add service / New message), a row opens
// the real record page (rail from `recordSections`), and nothing ever calls the network. The generic fixture sheet
// (a dialog with RESIDENT / HOME / STATUS boxes) must never come back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { COMM_CONVERSATIONS, PAYMENT_ROWS, SERVICE_THREADS } from "@/components/marketing/site/product-mock/fixtures";
import { moneyServiceRow, ASSIGNED_SERVICE_ROWS } from "@/components/marketing/site/product-mock/fixtures-popups-money";
import { SERVICE_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import { SERVICE_STAGE_TABS } from "@/lib/service-stage-ids";
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

const tabCount = (name: RegExp) => Number(/(\d+)\s*$/.exec(screen.getByRole("button", { name }).textContent ?? "")?.[1] ?? NaN);
const noGenericCard = () => {
  // The generic card was a dialog with grey RESIDENT / HOME / STATUS boxes; a record page is never a dialog.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector("p.uppercase.tracking-\\[0\\.04em\\]")).toBeNull();
};

describe("demo Payments tab matches the real Incoming payments page", () => {
  it("has the real Pending, Overdue, Paid tabs counted from the rows, a stat strip, and the real header icons", () => {
    render(<DemoPanel portal="manager" tab="payments" />);
    for (const bucket of ["pending", "overdue", "paid"] as const) {
      const expected = PAYMENT_ROWS.filter((r) => r.bucket === bucket).length;
      expect(tabCount(new RegExp(`^${bucket}`, "i"))).toBe(expected);
    }
    expect(screen.getByRole("heading", { name: "Incoming payments" })).toBeInTheDocument();
    expect(document.querySelector('[data-attr="payments-stat-strip"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Filter/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payment settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add charge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.getByPlaceholderText("Search payments")).toBeInTheDocument();
  });

  it("the round + opens the real Add charge pop-up: Who, Amount, Review, last label Add charge", async () => {
    render(<DemoPanel portal="manager" tab="payments" />);
    fireEvent.click(screen.getByRole("button", { name: "Add charge" }));
    const dialog = await screen.findByRole("dialog", { name: "Add charge" }, { timeout: 15000 });
    for (const label of ["Who", "Amount", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Property").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Resident").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Next: Amount/ }));
    for (const label of ["Type", "Charge title", "Amount", "Due", "Status"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Next: Review/ }));
    const finish = within(dialog).getByRole("button", { name: "Add charge" });
    fireEvent.click(finish);
    expect(screen.queryByRole("dialog", { name: "Add charge" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Charge added/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row opens the charge's record page: Payment and Communication rail, Send reminder is the story's target", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="payments" />);
    fireEvent.click(container.querySelector("[data-demo-target='payment-row'] button[data-attr='payment-list-row']")!);
    const reminder = await screen.findByRole("button", { name: "Send reminder" });
    noGenericCard();
    const rail = recordSections("manager", "payment", { direction: "incoming", bucket: "overdue" });
    const labels = rail.groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toEqual(["Payment", "Communication"]);
    for (const label of labels) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    for (const name of ["Payment settings", "Mark paid offline", "Edit", "Delete"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(reminder.getAttribute("data-demo-target")).toBe("sheet-primary");
    fireEvent.click(reminder);
    expect(screen.getByRole("status").textContent).toMatch(/Reminder sent/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("demo Services tab matches the real Services page", () => {
  const services = [...SERVICE_ROWS, ...ASSIGNED_SERVICE_ROWS].map(moneyServiceRow);

  it("has the four real stage tabs, counted from the rows, with Filter and the round + and no invented Settings gear", () => {
    render(<DemoPanel portal="manager" tab="services" />);
    for (const tab of SERVICE_STAGE_TABS) {
      const expected = services.filter((r) => r.stage === tab.id).length;
      expect(tabCount(new RegExp(`^${tab.label}`))).toBe(expected);
    }
    expect(screen.queryByRole("button", { name: /^Declined/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Done/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Filter/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add service" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByPlaceholderText("Search services")).toBeInTheDocument();
  });

  it("the round + opens the real Add service pop-up: Where, What, Review, last label Add service", async () => {
    render(<DemoPanel portal="manager" tab="services" />);
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    const dialog = await screen.findByRole("dialog", { name: "Add service" });
    for (const label of ["Where", "What", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    for (const label of ["Property", "Room", "Resident"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Next: What/ }));
    expect(within(dialog).getAllByText("Service type").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Photos \(0\/6\)/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("Resident charge").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Next: Review/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add service" }));
    expect(screen.queryByRole("dialog", { name: "Add service" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Service added/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const openFaucet = async (container: HTMLElement) => {
    // The faucet job: Liam Foster reported it, Pacific Plumbing is booked Thursday.
    const row = [...container.querySelectorAll("[data-demo-target='service-row'] button")].find((b) => b.textContent?.includes("Kitchen faucet drip"))!;
    fireEvent.click(row);
    return screen.findByRole("button", { name: "Remove service" });
  };
  const rail = (name: string) => screen.getAllByRole("link", { name }).find((a) => a.closest("nav"))!;

  it("a row opens the service's record page: Service, Vendors, Incoming and Outgoing payments, Communication", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="services" />);
    await openFaucet(container);
    noGenericCard();
    const sections = recordSections("manager", "service", { serviceKind: "work-order", serviceBucket: "scheduled" });
    for (const item of sections.groups.flatMap((g) => g.items)) expect(screen.getAllByText(item.label).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the header is Edit, ONE red trash and the labeled next step - no Message, no Cancel service, no Delete", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="services" />);
    await openFaucet(container);
    const header = container.querySelector('[data-attr="record-header-icons"]')!;
    const names = [...header.querySelectorAll("button")].filter((b) => !b.closest("[inert]")).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Edit", "Remove service", "Approve change order"]);
    const primary = header.querySelector("[data-labeled-primary]")!;
    expect(primary.textContent).toBe("Approve change order");
    expect(primary.getAttribute("data-demo-target")).toBe("sheet-primary");
    for (const gone of ["Message", "Cancel service", "Delete"]) expect(screen.queryByRole("button", { name: gone })).toBeNull();
  });

  it("the trash asks Cancel service (default) or Delete permanently; Cancel keeps the row, moved to Completed as Cancelled", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="services" />);
    fireEvent.click(await openFaucet(container));
    const dialog = await screen.findByRole("dialog", { name: "Remove service" });
    const radios = within(dialog).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["Cancel service", "Delete permanently"]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel service" }));
    expect(screen.queryByRole("dialog", { name: "Remove service" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Service cancelled/);
    // Back on the list, the row is no longer Scheduled but sits in Completed as Cancelled.
    expect(screen.queryByText("Kitchen faucet drip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
    const row = screen.getByText("Kitchen faucet drip").closest("[data-demo-target='service-row']")!;
    expect(row.textContent).toMatch(/Cancelled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Delete permanently is a press-and-hold and removes the row from every tab", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="services" />);
    fireEvent.click(await openFaucet(container));
    const dialog = await screen.findByRole("dialog", { name: "Remove service" });
    fireEvent.click(within(dialog).getAllByRole("radio")[1]!);
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirm);
    expect(screen.getByRole("dialog", { name: "Remove service" })).toBeInTheDocument();
    fireEvent.pointerDown(confirm, { button: 0, clientX: 0, clientY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    fireEvent.pointerUp(confirm);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Service removed/));
    for (const tab of [/^Scheduled/, /^Completed/]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(screen.queryByText("Kitchen faucet drip")).toBeNull();
    }
  });

  it("Communication opens on Everyone: the faucet conversation, resident and vendor merged in order and named", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="services" />);
    await openFaucet(container);
    fireEvent.click(rail("Communication"));
    const tabs = () => [...document.querySelectorAll('[data-attr^="service-communication-tab-"]')].map((t) => t.textContent?.trim());
    expect(tabs()).toEqual(["Everyone", "Liam Foster", "Pacific Plumbing"]);
    const bodies = () => [...document.querySelectorAll("p.whitespace-pre-wrap")].map((p) => p.textContent);
    expect(bodies()).toEqual(SERVICE_THREADS["wo-alder-faucet"]!.messages.map((m) => m.body));
    const names = [...document.querySelectorAll("[data-inbox-author]")].map((el) => `${el.textContent}${el.parentElement?.querySelector("[data-inbox-author-note]")?.textContent ?? ""}`.replace(/\s+/g, " "));
    expect(names[0]).toBe("Liam Foster· Resident");
    expect(names).toContain("You· to Pacific Plumbing");
    expect(names).toContain("Pacific Plumbing· Vendor");
    expect(names).toContain("You· to Liam Foster");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("each party's tab holds one thread, and a reply To Pacific Plumbing lands in Everyone and Pacific's tab only", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="services" />);
    await openFaucet(container);
    fireEvent.click(rail("Communication"));
    const click = (id: string) => fireEvent.click(document.querySelector(`[data-attr="service-communication-tab-${id}"]`)!);
    const bodies = () => [...document.querySelectorAll("p.whitespace-pre-wrap")].map((p) => p.textContent);
    click("resident");
    expect(bodies()).not.toContain("Can you send a photo of the faucet and the shutoff valve underneath?");
    expect(bodies()).toContain("Yes, I will be home Thursday morning. Come on in.");
    click("vendor");
    expect(bodies()).toEqual(SERVICE_THREADS["wo-alder-faucet"]!.messages.filter((m) => m.party === "vendor").map((m) => m.body));
    click("everyone");
    fireEvent.click(document.querySelector('[data-attr="service-communication-to-select"]')!);
    const option = within(screen.getByRole("listbox", { name: "To" })).getByRole("option", { name: "Pacific Plumbing · Vendor" });
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.change(screen.getByPlaceholderText("Write to Pacific Plumbing…"), { target: { value: "Gate code is 4471." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bodies().at(-1)).toBe("Gate code is 4471.");
    click("vendor");
    expect(bodies().at(-1)).toBe("Gate code is 4471.");
    click("resident");
    expect(bodies()).not.toContain("Gate code is 4471.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a service with no vendor conversation shows just the resident's thread", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="services" />);
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
    const row = container.querySelector("[data-demo-target='service-row'] button")!;
    fireEvent.click(row);
    await screen.findByRole("button", { name: "Remove service" });
    fireEvent.click(rail("Communication"));
    expect(document.querySelector('[data-attr="service-communication-tab-everyone"]')).toBeNull();
  });
});

describe("demo Communication tab matches the real Communication page", () => {
  it("has Active and Archived tabs with counts, Search communication, N records, and the real header icons", () => {
    render(<DemoPanel portal="manager" tab="communication" />);
    const active = COMM_CONVERSATIONS.filter((c) => c.segment === "active").length;
    const archived = COMM_CONVERSATIONS.filter((c) => c.segment === "archived").length;
    expect(screen.getByText("Active").closest("a")?.textContent).toContain(String(active));
    expect(screen.getByText("Archived").closest("a")?.textContent).toContain(String(archived));
    expect(screen.getByPlaceholderText("Search communication")).toBeInTheDocument();
    expect(screen.getByText(`${active} records`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filter/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Integrations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New message" })).toBeInTheDocument();
    // the Settings gear left the real page on 2026-10-05
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
  });

  it("the thread header carries the real icons and the line role · house, room · phone · email", () => {
    render(<DemoPanel portal="manager" tab="communication" />);
    for (const name of ["Mark unread", "Archive conversation", "Contact information"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByText(/^Prospect · Fremont Studio · \(206\) 555-0198 · jamie\.p@example\.com$/)).toBeInTheDocument();
  });

  it("Archived shows Delete all archived and a thread with Restore and Delete", () => {
    render(<DemoPanel portal="manager" tab="communication" />);
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByRole("button", { name: "Delete all archived" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Ethan Wright"));
    expect(screen.getByRole("button", { name: "Restore conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete conversation" })).toBeInTheDocument();
  });

  it("the round + opens the real New message pop-up with the Message preview panel", async () => {
    render(<DemoPanel portal="manager" tab="communication" />);
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    const dialog = await screen.findByRole("dialog", { name: "New message" });
    expect(within(dialog).getByPlaceholderText("Name, email or phone number")).toBeInTheDocument();
    expect(within(dialog).getByText("Subject")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Message preview").length).toBeGreaterThan(0);
    for (const name of ["Attach files", "Draft with PropLane", "In-app", "Email", "Text message"]) {
      expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    }
    const send = within(dialog).getByRole("button", { name: "Send email" });
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New message" })).toBeNull());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
