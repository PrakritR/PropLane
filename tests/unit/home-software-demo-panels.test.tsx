// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeSoftwareDemoPanels from "@/components/marketing/home-software-demo-panels";
import { DRAFT_REPLY, STORIES } from "@/components/marketing/resident-lifecycle-script";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Preview must never fetch"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const request = STORIES.resident[0].messages[0].text;
describe("real fixture-backed autoplay panels", () => {
  it("shows the incoming text in the first frame and keeps it through the draft", async () => {
    const props = { request, draft: DRAFT_REPLY, onApprove: vi.fn(), onReady: vi.fn() };
    const view = render(<HomeSoftwareDemoPanels {...props} scene="text" />);
    expect((await screen.findAllByText(request)).length).toBeGreaterThan(0);
    const workspace = view.container.querySelector(".rlp-workspace");
    view.rerender(<HomeSoftwareDemoPanels {...props} scene="draft" />);
    expect(view.container.querySelector(".rlp-workspace")).toBe(workspace);
    expect(screen.getAllByText(request).length).toBeGreaterThan(0);
    await waitFor(() => expect(view.container.querySelector('[data-demo-target="comm-approve"]')).not.toBeNull());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the mounted portal and selected section when a visitor takes over", async () => {
    const interact = vi.fn();
    const props = { scene: "text" as const, request, draft: DRAFT_REPLY, onApprove: vi.fn(), onReady: vi.fn(), onInteract: interact };
    const view = render(<HomeSoftwareDemoPanels {...props} />);
    await screen.findAllByText(request);
    const workspace = view.container.querySelector(".rlp-workspace");
    const nav = () => within(view.container.querySelector(".rlp-nav") as HTMLElement);
    fireEvent.click(nav().getByRole("button", { name: "Leases", exact: true }));
    expect(interact).toHaveBeenCalledOnce();
    view.rerender(<HomeSoftwareDemoPanels {...props} interactive />);
    expect(view.container.querySelector("[data-portal-section-tabs]")).toBeNull();
    expect(nav().getByRole("button", { name: "Leases", exact: true })).toHaveAttribute("aria-current", "page");
    fireEvent.click(nav().getByRole("button", { name: "Tours", exact: true }));
    expect(nav().getByRole("button", { name: "Tours", exact: true })).toHaveAttribute("aria-current", "page");
    fireEvent.click(nav().getByRole("button", { name: "Leases", exact: true }));
    await waitFor(() => expect(nav().getByRole("button", { name: "Leases", exact: true })).toHaveAttribute("aria-current", "page"));
    expect(view.container.querySelector(".rlp-workspace")).toBe(workspace);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("adopts and approves the real inbox draft locally", async () => {
    const approve = vi.fn();
    const { container } = render(<HomeSoftwareDemoPanels scene="approve" request={request} draft={DRAFT_REPLY} onApprove={approve} onReady={vi.fn()} />);
    await waitFor(() => expect(container.querySelector('[data-demo-target="comm-approve"]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-demo-target="comm-approve"]')!);
    expect(approve).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("appends a typed reply locally and preserves the thread on pause", async () => {
    const props = { scene: "inbox" as const, request, draft: DRAFT_REPLY, onApprove: vi.fn(), onReady: vi.fn() };
    const view = render(<HomeSoftwareDemoPanels {...props} />);
    const input = await screen.findByPlaceholderText("Write a reply…");
    fireEvent.change(input, { target: { value: "I can meet you at the front door." } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getAllByText("I can meet you at the front door.").length).toBeGreaterThan(0);
    view.rerender(<HomeSoftwareDemoPanels {...props} interactive />);
    expect(screen.getAllByText(request).length).toBeGreaterThan(0);
    expect(screen.getAllByText("I can meet you at the front door.").length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restarts the walkthrough with only the incoming request without remounting the shell", async () => {
    const props = { request, draft: DRAFT_REPLY, onApprove: vi.fn(), onReady: vi.fn() };
    const view = render(<HomeSoftwareDemoPanels {...props} scene="approve" />);
    const workspace = view.container.querySelector(".rlp-workspace");
    await waitFor(() => expect(view.container.querySelector('[data-demo-target="comm-approve"]')).not.toBeNull());
    fireEvent.click(view.container.querySelector('[data-demo-target="comm-approve"]')!);
    view.rerender(<HomeSoftwareDemoPanels {...props} scene="approve" interactive />);
    expect(screen.getAllByText(DRAFT_REPLY).length).toBeGreaterThan(0);
    view.rerender(<HomeSoftwareDemoPanels {...props} scene="text" />);
    expect(screen.queryByText(DRAFT_REPLY)).not.toBeInTheDocument();
    expect(screen.getAllByText(request).length).toBeGreaterThan(0);
    expect(view.container.querySelector(".rlp-workspace")).toBe(workspace);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["text", "inbox"] as const)("restores Jordan and clears inbox filters when a guided %s scene resumes", async (scene) => {
    const props = { request, draft: DRAFT_REPLY, onApprove: vi.fn(), onReady: vi.fn() };
    const view = render(<HomeSoftwareDemoPanels {...props} scene="text" />);
    const workspace = view.container.querySelector(".rlp-workspace");
    const firstInbox = view.container.querySelector(".rlp-comm-frame");
    view.rerender(<HomeSoftwareDemoPanels {...props} scene="inbox" />);
    expect(view.container.querySelector(".rlp-comm-frame")).toBe(firstInbox);
    fireEvent.click(screen.getByTitle("Mina Chen"));
    expect(view.container.querySelector(".portal-inbox-row--selected")).toHaveTextContent("Mina Chen");
    fireEvent.change(screen.getByLabelText("Search contacts or messages"), { target: { value: "Mina" } });
    fireEvent.click(view.container.querySelector('[data-attr="inbox-list-segment-archived"]')!);
    view.rerender(<HomeSoftwareDemoPanels {...props} scene="inbox" interactive />);
    expect(screen.getByLabelText("Search contacts or messages")).toHaveValue("Mina");
    view.rerender(<HomeSoftwareDemoPanels {...props} scene={scene} />);
    expect(screen.getByLabelText("Search contacts or messages")).toHaveValue("");
    expect(view.container.querySelector('[data-attr="inbox-list-segment-active"]')).toHaveAttribute("aria-current", "page");
    expect(view.container.querySelector(".portal-inbox-row--selected")).toHaveTextContent("Jordan");
    expect(screen.getAllByText(request).length).toBeGreaterThan(0);
    expect(view.container.querySelector(".rlp-comm-frame")).not.toBe(firstInbox);
    expect(view.container.querySelector(".rlp-workspace")).toBe(workspace);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders the actual calendar and paid payment list from the shared story", async () => {
    const props = { request, draft: DRAFT_REPLY, onApprove: vi.fn(), onReady: vi.fn() };
    const view = render(<HomeSoftwareDemoPanels {...props} scene="tour" />);
    expect((await screen.findAllByText(/Jordan/, {}, { timeout: 10_000 })).length).toBeGreaterThan(0);
    expect(view.container.querySelector(".pm-window")).toBeNull();
    view.rerender(<HomeSoftwareDemoPanels {...props} scene="paid" />);
    expect(await screen.findByRole("button", { name: /^Paid/ })).toBeInTheDocument();
    expect(view.container).toHaveTextContent("October rent");
    expect(view.container.querySelector(".pm-window")).toBeNull();
    view.rerender(<HomeSoftwareDemoPanels {...props} scene="paid" interactive />);
    expect(screen.getByRole("button", { name: /^Paid/ })).toBeInTheDocument();
    expect(within(view.container.querySelector(".rlp-nav") as HTMLElement).getByRole("button", { name: "Incoming payments", exact: true })).toHaveAttribute("aria-current", "page");
    expect(fetch).not.toHaveBeenCalled();
  });
});
