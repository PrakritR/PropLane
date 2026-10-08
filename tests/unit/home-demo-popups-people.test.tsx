// @vitest-environment jsdom
//
// The home demo's manager Residents and Vendors tabs must behave like the real pages (pro-residents.tsx,
// pro-vendors-panel.tsx): the real tab labels counted from the rows drawn, the real header icons, the round + opening
// the real "Add resident" / "Add vendor" pop-ups (real step rails and footer words), a row opening the real RECORD PAGE
// (rail from `recordSections`, header icons from the registry), the row menu offering the real items, and nothing ever
// calling the network. The generic RESIDENT / HOME / STATUS field card must never come back.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { CATALOG_VENDORS, RESIDENT_ROWS, VENDOR_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import { demoResidentRecord } from "@/components/marketing/site/product-mock/fixtures-popups-people";
import { recordSections } from "@/lib/portals/record-sections";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

afterEach(cleanup);

// The pop-ups load on demand (`next/dynamic`); warm the chunk once so a cold transform never races findBy's 1s.
beforeAll(async () => {
  await import("@/components/marketing/site/product-mock/demo-popups-people");
}, 120000);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

const railLabels = (sections: ReturnType<typeof recordSections>) => sections.groups.flatMap((g) => g.items.map((i) => i.label));
/** Every action name in the record header: the visible icons plus whatever folded into the "More actions" menu. */
async function headerActionNames(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
  const visible = screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
  const more = screen.queryByRole("button", { name: "More actions" });
  if (!more) return visible;
  await user.click(more);
  const folded = (await screen.findAllByRole("menuitem")).map((i) => i.textContent ?? "");
  await user.keyboard("{Escape}");
  return [...visible, ...folded];
}
const countOf = (tab: string) => RESIDENT_ROWS.filter((r) => r.tab === tab).length;

describe("demo Residents tab matches the real Residents page", () => {
  it("has the real Potential, Current and Past tabs, counted from the rows it draws", () => {
    render(<DemoPanel portal="manager" tab="residents" />);
    for (const [label, id] of [["Potential", "potential"], ["Current", "current"], ["Past", "past"]] as const) {
      const button = screen.getByRole("button", { name: new RegExp(`^${label}`) });
      expect(button.textContent).toContain(String(countOf(id)));
    }
    // the real header: the Filter popover and the round +, no gear
    expect(screen.getAllByRole("button", { name: /Filter/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add resident" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /settings|defaults/i })).toBeNull();
  });

  it("the Filter popover has the real Group by and Property fields", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="residents" />);
    await user.click(screen.getAllByRole("button", { name: /Filter/ })[0]!);
    expect((await screen.findAllByText("Group by")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Property").length).toBeGreaterThan(0);
  });

  it("the round + opens the real Add resident wizard, not a toast", async () => {
    render(<DemoPanel portal="manager" tab="residents" />);
    fireEvent.click(screen.getByRole("button", { name: "Add resident" }));
    const dialog = await screen.findByRole("dialog", { name: "Add resident" });
    expect(screen.queryByRole("status")).toBeNull();
    // the real rail
    for (const label of ["Resident", "Home", "Application", "Lease", "Payments", "Documents", "Review"]) {
      expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getAllByText("Off this add").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Add documents").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Start from a file")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Upload a file")).toBeInTheDocument();
    expect(within(dialog).getByText("Step 1 of 7")).toBeInTheDocument();
    // step 1: the real Contact step
    expect(within(dialog).getByText("Who are you adding?")).toBeInTheDocument();
    expect(within(dialog).getByText("Contact")).toBeInTheDocument();
    expect(within(dialog).getByText("Full name")).toBeInTheDocument();
    expect(within(dialog).getByText("Preferred contact")).toBeInTheDocument();
    // step 2: the real Home step
    fireEvent.click(within(dialog).getByRole("button", { name: /^Next/ }));
    expect(within(dialog).getByText("Step 2 of 7")).toBeInTheDocument();
    expect(within(dialog).getByText("How they rent it")).toBeInTheDocument();
    expect(within(dialog).getByText("Listing says")).toBeInTheDocument();
    // walk to the last step; the footer primary is the real "Add resident"
    for (let step = 3; step <= 7; step += 1) fireEvent.click(within(dialog).getByRole("button", { name: /^Next/ }));
    expect(within(dialog).getByText("Step 7 of 7")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add resident" }));
    expect(screen.queryByRole("dialog", { name: "Add resident" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/\(sample\)/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row opens the resident record page: the real rail, header icons per section, no generic card", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="residents" />);
    await user.click(screen.getByText("Liam Foster"));
    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);
    expect(document.querySelector("[data-attr='demo-record-page']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // the rail is the registry's, current resident
    const expected = railLabels(recordSections("manager", "resident", { residentsTab: "current" }));
    for (const label of expected) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    // header icons: Overview carries none, Forms (like Move in and Communication) Edit and Delete
    await user.click(screen.getAllByText("Forms")[0]!);
    expect(await headerActionNames(user)).toEqual(expect.arrayContaining(["Edit", "Delete"]));
    // Payments: Payment reminder + Add charge, and Add charge opens the real Add charge pop-up
    await user.click(screen.getAllByText("Payments")[0]!);
    expect(await headerActionNames(user)).toEqual(expect.arrayContaining(["Payment reminder", "Add charge"]));
    await user.click(screen.getByRole("button", { name: "Add charge" }));
    const dialog = await screen.findByRole("dialog", { name: "Add charge" });
    for (const label of ["Who", "Amount", "Review"]) expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a potential resident's record has no Services tab and its Application tab approves, declines, edits and downloads", async () => {
    const user = userEvent.setup();
    const pending = RESIDENT_ROWS.find((r) => r.tab === "potential" && r.status === "Pending review")!;
    render(<DemoPanel portal="manager" tab="residents" />);
    await user.click(screen.getByRole("button", { name: /^Potential/ }));
    await user.click(screen.getByText(pending.name));
    const expected = railLabels(recordSections("manager", "resident", { residentsTab: "potential", hiddenSections: ["services"] }));
    expect(expected).not.toContain("Services");
    expect(screen.queryByText("Services")).toBeNull();
    await user.click(screen.getAllByText("Application")[0]!);
    expect(await headerActionNames(user)).toEqual(expect.arrayContaining(["Approve", "Decline", "Edit", "Download PDF"]));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve application" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(screen.queryByRole("dialog", { name: "Approve application" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the row menu offers the real items and Edit opens the Edit resident wizard", async () => {
    const user = userEvent.setup();
    const pending = RESIDENT_ROWS.find((r) => r.tab === "potential" && r.status === "Pending review")!;
    render(<DemoPanel portal="manager" tab="residents" />);
    await user.click(screen.getByRole("button", { name: /^Potential/ }));
    await user.click(screen.getByRole("button", { name: `Actions for ${pending.name}` }));
    for (const name of ["Send setup", "Remind to finish", "Edit", "Approve", "Delete"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("menuitem", { name: "Send setup" }));
    const setup = await screen.findByRole("dialog", { name: "Send setup" });
    expect(within(setup).getAllByText("To").length).toBeGreaterThan(0);
    expect(within(setup).getAllByRole("button", { name: "Send setup" }).length).toBeGreaterThan(0);
    fireEvent.click(within(setup).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: `Actions for ${pending.name}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit resident" });
    expect(within(edit).getAllByText("Review").length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("derives the record's rows from the list row, never a typed count", () => {
    const row = RESIDENT_ROWS.find((r) => r.id === "res-liam")!;
    const record = demoResidentRecord(row);
    expect(record.name).toBe(row.name);
    expect(record.charges.every((c) => c.title.startsWith("Rent"))).toBe(true);
  });
});

describe("demo Vendors tab matches the real Vendors page", () => {
  it("has the real Your vendors and PropLane vendors tabs, counted from the rows it draws, and the gear on both", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="vendors" />);
    expect(screen.getByRole("button", { name: /^Your vendors/ }).textContent).toContain(String(VENDOR_ROWS.length));
    expect(screen.getByRole("button", { name: /^PropLane vendors/ }).textContent).toContain(String(CATALOG_VENDORS.length));
    expect(screen.getByRole("button", { name: "Vendor defaults" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Filter by trade or rating/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^PropLane vendors/ }));
    expect(screen.getByRole("button", { name: "Vendor defaults" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filter by trade or rating/ })).toBeInTheDocument();
  });

  it("the catalog Filter is an inline panel with Trade, Area, Rating and Reset", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="vendors" />);
    await user.click(screen.getByRole("button", { name: /^PropLane vendors/ }));
    await user.click(screen.getByRole("button", { name: /Filter by trade or rating/ }));
    expect(screen.getByText("Trade")).toBeInTheDocument();
    expect(screen.getByText("Area")).toBeInTheDocument();
    expect(screen.getByText("Rating")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("City or ZIP")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("City or ZIP"), "Shoreline");
    expect(screen.getByText("Lakeview Painting")).toBeInTheDocument();
    expect(screen.queryByText("Puget Sound HVAC")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("Puget Sound HVAC")).toBeInTheDocument();
  });

  it("the round + opens the real Add vendor wizard with its six steps", async () => {
    render(<DemoPanel portal="manager" tab="vendors" />);
    fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));
    const dialog = await screen.findByRole("dialog", { name: "Add vendor" });
    for (const label of ["Invite by", "Contact", "Properties", "What they do", "Typical price", "Review"]) {
      expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getByText("Step 1 of 6")).toBeInTheDocument();
    for (let step = 2; step <= 6; step += 1) fireEvent.click(within(dialog).getByRole("button", { name: /^Next/ }));
    expect(within(dialog).getByText("Step 6 of 6")).toBeInTheDocument();
    expect(within(dialog).getByText("Share on PropLane")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Invite vendor" }));
    // the real flow continues to the invite message
    expect(await screen.findByRole("dialog", { name: "New message" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a Your vendors row opens the vendor record with the real rail and header icons", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="vendors" />);
    await user.click(screen.getByText("Pacific Plumbing"));
    expect(document.querySelector("[data-attr='demo-record-page']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const label of railLabels(recordSections("manager", "vendor"))) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(await headerActionNames(user)).toEqual(expect.arrayContaining(["Edit vendor", "Invite to PropLane", "Message", "Remove vendor"]));
    await user.click(screen.getByRole("button", { name: "Edit vendor" }));
    expect(await screen.findByRole("dialog", { name: "Edit vendor" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a PropLane vendor row opens the catalog record, and Add to your vendors opens the one-step Invite vendor", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="vendors" />);
    await user.click(screen.getByRole("button", { name: /^PropLane vendors/ }));
    await user.click(screen.getByText("Puget Sound HVAC"));
    expect(document.querySelector("[data-attr='demo-record-page']")).not.toBeNull();
    for (const label of railLabels(recordSections("manager", "vendorCatalog"))) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Add to your vendors" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite vendor" });
    expect(within(dialog).getAllByText("Properties").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/^Step \d of \d$/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Invite" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the catalog row menu offers Add to your vendors, which asks first and then reads Added", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="vendors" />);
    await user.click(screen.getByRole("button", { name: /^PropLane vendors/ }));
    await user.click(screen.getByRole("button", { name: "Actions for Lakeview Painting" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add to your vendors" }));
    const dialog = await screen.findByRole("dialog", { name: "Add to your vendors" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to your vendors" }));
    expect(screen.queryByRole("dialog", { name: "Add to your vendors" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Actions for Lakeview Painting" }));
    const added = await screen.findByRole("menuitem", { name: "Added" });
    expect(added.getAttribute("aria-disabled") === "true" || added.hasAttribute("data-disabled")).toBe(true);
    // Your vendors grew by the one it joined
    expect(screen.getByRole("button", { name: /^Your vendors/ }).textContent).toContain(String(VENDOR_ROWS.length + 1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Your vendors rows offer Edit and Remove", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="vendors" />);
    await user.click(screen.getByRole("button", { name: "Actions for Cascade Locksmiths" }));
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeInTheDocument();
    // a destructive item ignores a tap that lands right as the menu opens (the real menu's settle guard)
    await new Promise((resolve) => setTimeout(resolve, 600));
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(await screen.findByRole("dialog", { name: "Remove vendor — notification preview" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
