// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagerCommunication } from "@/components/marketing/resident-lifecycle-manager";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Sample inbox must never fetch"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  const view = render(<ManagerCommunication messages={[{ from: "resident", text: "Can I tour on Thursday?" }]} onReply={() => true} />);
  const folder = (name: "active" | "archived") => view.container.querySelector(`[data-attr="inbox-list-segment-${name}"]`) as HTMLElement;
  const count = (name: "active" | "archived") => Number(folder(name).textContent?.match(/\d+/)?.[0] ?? 0);
  const list = () => view.container.querySelector("[data-communication-inbox-list]") as HTMLElement;
  return { ...view, folder, count, list };
}

describe("sample manager communication actions", () => {
  it("marks the selected conversation unread, then reading the row clears it", () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    expect(screen.getByTitle("Jordan").closest(".portal-inbox-row")).toHaveAttribute("data-unread", "true");
    fireEvent.click(screen.getByTitle("Mina Chen"));
    expect(screen.getByTitle("Jordan").closest(".portal-inbox-row")).toHaveAttribute("data-unread", "true");
    fireEvent.click(screen.getByTitle("Jordan"));
    expect(screen.getByTitle("Jordan").closest(".portal-inbox-row")).not.toHaveAttribute("data-unread");
    expect(view.container.querySelector(".portal-inbox-row--selected")).toHaveTextContent("Jordan");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("archives and restores the actual row with folder counts and a coherent selection", async () => {
    const view = mount();
    const active = view.count("active");
    const archived = view.count("archived");
    fireEvent.click(screen.getByRole("button", { name: "Archive conversation" }));
    expect(view.count("active")).toBe(active - 1);
    expect(view.count("archived")).toBe(archived + 1);
    expect(within(view.list()).queryByTitle("Jordan")).toBeNull();
    expect(view.container.querySelector(".portal-inbox-row--selected")).toHaveTextContent("Mina Chen");
    fireEvent.click(view.folder("archived"));
    fireEvent.click(screen.getByTitle("Jordan"));
    expect(screen.getByRole("button", { name: "Restore conversation" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Jordan" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore", exact: true }));
    await waitFor(() => expect(view.count("active")).toBe(active));
    expect(view.count("archived")).toBe(archived);
    expect(within(view.list()).queryByTitle("Jordan")).toBeNull();
    fireEvent.click(view.folder("active"));
    fireEvent.click(screen.getByTitle("Jordan"));
    expect(view.container.querySelector(".portal-inbox-row--selected")).toHaveTextContent("Jordan");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not show an unrelated thread when a filter excludes every conversation", () => {
    const view = mount();
    fireEvent.change(screen.getByLabelText("Search contacts or messages"), { target: { value: "No matching person" } });
    expect(view.list()).toHaveTextContent("No matching conversations");
    expect(screen.queryByPlaceholderText("Write a reply…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive conversation" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never treats a different visible contact's composer as the prospect approval button", () => {
    const view = render(<ManagerCommunication messages={[{ from: "resident", text: "Can I tour?" }]} draft="Thursday at 5:30 works." onReply={() => true} />);
    expect(view.container.querySelector('[data-demo-target="comm-approve"]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Search contacts or messages"), { target: { value: "Mina" } });
    expect(view.container.querySelector(".portal-inbox-row--selected")).toHaveTextContent("Mina Chen");
    expect(view.container.querySelector('[data-demo-target="comm-approve"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
