// @vitest-environment jsdom
//
// The home demo draws one fixture-fed panel for every portal tab. This renders
// each DEMO_TABS entry for each portal and asserts it mounts, says something,
// never says "work order" (user-facing copy is "service"), and never fetches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it.each(DEMO_TABS[portal].map((t) => [t.id, t.label]))("renders the %s tab (%s)", (tab) => {
    const { container } = render(<DemoPanel portal={portal} tab={tab} />);
    const text = container.textContent ?? "";
    expect(text.trim().length).toBeGreaterThan(20);
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

  it("Applications: Send application opens a sheet whose primary sends, and every row is a target", () => {
    const { container } = render(<DemoPanel portal="manager" tab="applications" story={NO_STORY} />);
    expect(target(container, "application-row")).not.toBeNull();
    fireEvent.click(target(container, "applications-send")!);
    expect(screen.getByRole("dialog", { name: "Send application" })).toBeInTheDocument();
    expect(target(container, "sheet-primary")?.textContent).toBe("Send");
    expect(screen.getByText("Apply for Room 3 \u2014 PropLane")).toBeInTheDocument();
  });

  it("Leases: a lease in manager review is sent, and one waiting on the manager is countersigned", () => {
    const story = { ...NO_STORY, applicationApproved: true, leaseStep: 0 as const };
    const { container, unmount } = render(<DemoPanel portal="manager" tab="leases" story={story} />);
    fireEvent.click(target(container, "lease-row")!.querySelector("button[data-attr='lease-list-row']")!);
    expect(target(container, "sheet-primary")?.textContent).toBe("Send lease");
    unmount();
    const signed = render(<DemoPanel portal="manager" tab="leases" story={{ ...story, leaseStep: 2 }} />);
    fireEvent.click(target(signed.container, "lease-row")!.querySelector("button[data-attr='lease-list-row']")!);
    expect(target(signed.container, "sheet-primary")?.textContent).toBe("Countersign");
  });

  it("Payments sends a reminder for a pending charge; Services dispatches an open service", () => {
    const rent = { ...NO_STORY, leaseStep: 3 as const, applicationApproved: true };
    const payments = render(<DemoPanel portal="manager" tab="payments" story={rent} />);
    fireEvent.click(target(payments.container, "payment-row")!.querySelector("button[data-attr='payment-list-row']")!);
    expect(target(payments.container, "sheet-primary")?.textContent).toBe("Send reminder");
    payments.unmount();
    const services = render(<DemoPanel portal="manager" tab="services" story={{ ...rent, rentPaid: true, service: "open" }} />);
    fireEvent.click(target(services.container, "service-row")!.querySelector("button[data-attr='service-list-row']")!);
    expect(target(services.container, "sheet-primary")?.textContent).toBe("Dispatch vendor");
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
