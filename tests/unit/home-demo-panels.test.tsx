// @vitest-environment jsdom
//
// The home demo draws one fixture-fed panel for every portal tab. This renders
// each DEMO_TABS entry for each portal and asserts it mounts, says something,
// never says "work order" (user-facing copy is "service"), and never fetches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { NO_STORY } from "@/components/marketing/site/product-mock/world";
import { ManagerCommunication } from "@/components/marketing/resident-lifecycle-manager";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

afterEach(cleanup);

let fetchSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // The list band logs (never throws) when a panel breaks its icon / primary-label contract.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

const PORTALS = Object.keys(DEMO_TABS) as DemoPortal[];

describe("DEMO_TABS contract", () => {
  it("is the real sidebar, row for row (the full parity check is home-demo-nav-parity.test.ts)", () => {
    expect(DEMO_TABS.manager.map((t) => t.id)).toEqual([
      "dashboard", "tasks", "calendar", "communication",
      "properties", "bookings", "promotion",
      "tours", "applications", "leases", "forms",
      "residents", "vendors", "services",
      "payments", "outgoing", "financials", "documents",
    ]);
    expect(DEMO_TABS.resident.map((t) => t.id)).toEqual([
      "dashboard", "communication",
      "move-in", "lease", "forms", "services",
      "tour", "applications",
      "payments", "documents",
    ]);
    expect(DEMO_TABS.vendor.map((t) => t.id)).toEqual([
      "dashboard", "communication", "calendar",
      "work-orders", "reviews",
      "financials", "documents",
    ]);
  });
});

describe.each(PORTALS)("DemoPanel - %s portal", (portal) => {
  // The role Dashboards load as their own chunk (`next/dynamic`), so a panel may
  // arrive a tick after render — and on a cold module graph that first import is
  // well over waitFor's 1s default, which made this case fail on the first run of
  // the file and pass on every later one. Wait long enough for the real import.
  it.each(DEMO_TABS[portal].map((t) => [t.id, t.label]))("renders the %s tab (%s)", async (tab) => {
    const { container } = render(<DemoPanel portal={portal} tab={tab} />);
    await waitFor(() => expect((container.textContent ?? "").trim().length).toBeGreaterThan(20), {
      timeout: 15_000,
    });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/work[\s-]?order/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("vendor Reviews", () => {
  it("draws the stats card above the All / Needs reply / Replied tabs", () => {
    render(<DemoPanel portal="vendor" tab="reviews" />);
    const stats = screen.getByTestId("vendor-reviews-stats");
    const tab = screen.getByRole("button", { name: /needs reply/i });
    expect(stats.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(tab);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The cursor drives the real controls through `data-demo-target`: each one must exist where the
 * script clicks it, and the sheet it opens must say what the manager is doing (the story is
 * causal, so a click has to do the thing its phone line reports).
 */
describe("demo cursor targets", () => {
  const target = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-demo-target="${id}"]`);

  it("Applications: Send application opens the real Send application pop-up whose primary sends, and every row is a target", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    expect(target(container, "application-row")).not.toBeNull();
    fireEvent.click(target(container, "applications-send")!);
    expect(await screen.findByRole("dialog", { name: "Send application" }, { timeout: 15000 })).toBeInTheDocument();
    expect(target(container, "sheet-primary")?.textContent).toBe("Send");
    expect(screen.getByText("Apply for Room 3 \u2014 PropLane")).toBeInTheDocument();
  }, 40000);

  it("Applications: a pending application opens its record, whose Approve is the story's target", async () => {
    const { container } = render(<DemoPanel portal="manager" tab="applications" story={{ ...NO_STORY, tourOffered: true, tourAccepted: true, applicationSubmitted: true }} />);
    fireEvent.click(target(container, "application-row")!.querySelector("button[data-attr='application-list-row']")!);
    await waitFor(() => expect(target(container, "sheet-primary")).not.toBeNull(), { timeout: 15000 });
    expect(target(container, "sheet-primary")?.getAttribute("aria-label")).toBe("Approve");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(target(container, "sheet-primary")!);
    await waitFor(() => expect(screen.getByText("Application approved (sample)")).toBeInTheDocument(), { timeout: 15000 });
    expect(target(container, "sheet-primary")).toBeNull();
  }, 40000);

  it("Leases: a draft lease is sent from its record, and one waiting on the manager is countersigned", async () => {
    const story = { ...NO_STORY, applicationApproved: true, leaseStep: 0 as const };
    const { container, unmount } = render(<DemoPanel portal="manager" tab="leases" story={story} />);
    fireEvent.click(target(container, "lease-row")!.querySelector("button[data-attr='lease-list-row']")!);
    await waitFor(() => expect(target(container, "sheet-primary")).not.toBeNull(), { timeout: 15000 });
    expect(target(container, "sheet-primary")?.getAttribute("aria-label")).toBe("Send lease");
    unmount();
    const signed = render(<DemoPanel portal="manager" tab="leases" story={{ ...story, leaseStep: 2 }} />);
    fireEvent.click(target(signed.container, "lease-row")!.querySelector("button[data-attr='lease-list-row']")!);
    await waitFor(() => expect(target(signed.container, "sheet-primary")).not.toBeNull(), { timeout: 15000 });
    expect(target(signed.container, "sheet-primary")?.getAttribute("aria-label")).toBe("Countersign");
  }, 40000);

  it("Payments sends a reminder for a pending charge; Services dispatches an open service", async () => {
    // A row opens the record page (what the real list does); the record's header icon is the story's target.
    const rent = { ...NO_STORY, leaseStep: 3 as const, applicationApproved: true };
    const payments = render(<DemoPanel portal="manager" tab="payments" story={rent} />);
    fireEvent.click(target(payments.container, "payment-row")!.querySelector("button[data-attr='payment-list-row']")!);
    await waitFor(() => expect(target(payments.container, "sheet-primary")).not.toBeNull());
    expect(target(payments.container, "sheet-primary")?.getAttribute("aria-label")).toBe("Send reminder");
    payments.unmount();
    const services = render(<DemoPanel portal="manager" tab="services" story={{ ...rent, rentPaid: true, service: "open" }} />);
    fireEvent.click(target(services.container, "service-row")!.querySelector("button[data-attr='work-order-list-row']")!);
    await waitFor(() => expect(target(services.container, "sheet-primary")).not.toBeNull());
    expect(target(services.container, "sheet-primary")?.getAttribute("aria-label")).toBe("Dispatch vendor");
  });

  it("Communication: a drafted reply waits for the manager's Approve and nothing sends before", () => {
    const onApprove = vi.fn();
    const { container, rerender } = render(<ManagerCommunication messages={[]} draft={null} onApprove={onApprove} onReply={() => true} />);
    expect(target(container, "comm-approve")).toBeNull();
    rerender(<ManagerCommunication messages={[]} draft="Yes, it is." onApprove={onApprove} onReply={() => true} />);
    expect(screen.getByText("PropLane draft - edit before sending")).toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(target(container, "comm-approve")!);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
