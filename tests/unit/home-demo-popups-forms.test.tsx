// @vitest-environment jsdom
//
// The home demo's manager Forms tab must behave like the real Forms page (forms-list.tsx): the round + opens the
// real "Send a move-in form" popup (one step "Send a form", Resident / Form / Due, "What <first> gets" panel, Cancel +
// Send), a row opens the form's record (Answers · Activity rail, "Not submitted yet" + Remind, or the answers), the row
// menu's Edit opens "Edit <form>" (Details · Questions, Save), and nothing ever calls the network. The generic
// RESIDENT / HOME / STATUS field card must never come back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { MANAGER_FORMS } from "@/components/marketing/site/product-mock/fixtures-more";
import { formsBucketCounts } from "@/lib/move-in-forms/manager-rows";
import { formsListHref } from "@/lib/portal-detail-routes";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

afterEach(cleanup);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

describe("demo Forms tab matches the real Forms page", () => {
  it("has the real Pending and Completed tabs, counted from the rows it draws", () => {
    render(<DemoPanel portal="manager" tab="forms" />);
    const counts = formsBucketCounts(MANAGER_FORMS.map((form) => ({ status: form.bucket === "completed" ? "submitted" : "sent" })));
    const pending = screen.getByRole("button", { name: /^Pending/ });
    const completed = screen.getByRole("button", { name: /^Completed/ });
    expect(pending.textContent).toContain(String(counts.pending));
    expect(completed.textContent).toContain(String(counts.completed));
    // the real route ids the tabs link to
    expect(formsListHref("/portal", "pending")).toBe("/portal/forms");
    expect(formsListHref("/portal", "completed")).toBe("/portal/forms/completed");
  });

  it("the round + opens the real Send a move-in form popup, not a toast", async () => {
    render(<DemoPanel portal="manager" tab="forms" />);
    fireEvent.click(screen.getByRole("button", { name: "Add form" }));
    const dialog = await screen.findByRole("dialog", { name: "Send a move-in form" }, { timeout: 15000 });
    expect(screen.queryByRole("status")).toBeNull();
    // one step, "Send a form", with the resident card on the rail and the right-hand "What <first> gets" panel
    expect(within(dialog).getAllByText("Send a form").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Resident").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Form").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Due").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/^What .* gets$/).length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    const send = within(dialog).getByRole("button", { name: "Send" });
    fireEvent.click(send);
    expect(screen.queryByRole("dialog", { name: "Send a move-in form" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Form sent/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a pending row opens the form record: Answers and Activity, Not submitted yet, Remind, Done", async () => {
    render(<DemoPanel portal="manager" tab="forms" />);
    fireEvent.click(screen.getByText("Key receipt"));
    const dialog = await screen.findByRole("dialog", { name: "Key receipt · Liam Foster" }, { timeout: 15000 });
    expect(within(dialog).getAllByText("Answers").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Activity").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Not submitted yet").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Remind Liam" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeInTheDocument();
    // never the generic field card
    expect(within(dialog).queryByText(/^Home$/)).toBeNull();
    expect(within(dialog).queryByText(/^Status$/)).toBeNull();
    fireEvent.click(within(dialog).getAllByText("Activity")[0]!);
    expect(within(dialog).getAllByText("History").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Last reminder").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a completed row opens its answers and the filled PDF", async () => {
    render(<DemoPanel portal="manager" tab="forms" />);
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
    fireEvent.click(screen.getByText("Pet agreement"));
    const dialog = await screen.findByRole("dialog", { name: "Pet agreement · Maya Chen" }, { timeout: 15000 });
    expect(within(dialog).getAllByText("Filled PDF").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Biscuit").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByRole("button", { name: "Download PDF" }).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the row menu offers Edit, Remind and Cancel request, and Edit opens the Edit form popup", async () => {
    const user = userEvent.setup();
    render(<DemoPanel portal="manager" tab="forms" />);
    await user.click(screen.getByRole("button", { name: "Actions for Intake form" }));
    expect(await screen.findByRole("menuitem", { name: "Edit" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remind" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Cancel request" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Intake form" }, { timeout: 15000 });
    expect(within(dialog).getAllByText("Details").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Questions").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Due").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Blocks").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getAllByText("Questions")[0]!);
    expect(within(dialog).getAllByText(/Add section/).length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
