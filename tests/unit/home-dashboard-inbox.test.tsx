// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeDashboardInbox from "@/components/marketing/home-dashboard-inbox";
import { DRAFT_REPLY } from "@/components/marketing/resident-lifecycle-script";

vi.mock("@/components/marketing/resident-lifecycle-manager", () => ({
  ManagerCommunication: ({ messages, draft, onApprove }: { messages: { text: string }[]; draft: string | null; onApprove(): void }) =>
    <div>{messages.map((message, index) => <p key={index}>{message.text}</p>)}{draft && <button data-demo-target="comm-approve" onClick={onApprove}>Send draft</button>}</div>,
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("guided inbox approval", () => {
  it("presses the real demo target once, after the pointer move", () => {
    const approve = vi.fn();
    const { rerender } = render(<HomeDashboardInbox animate approved={false} onApprove={approve} />);
    act(() => { vi.advanceTimersByTime(1219); });
    expect(approve).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(approve).toHaveBeenCalledOnce();
    rerender(<HomeDashboardInbox animate approved onApprove={approve} />);
    expect(screen.getByText(DRAFT_REPLY)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send draft" })).toBeNull();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(approve).toHaveBeenCalledOnce();
  });

  it("does not autoplay in the reduced-motion stacked view", () => {
    const approve = vi.fn();
    render(<HomeDashboardInbox animate={false} approved={false} onApprove={approve} />);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(approve).not.toHaveBeenCalled();
  });

  it("cancels the pending click when a scroll step unmounts", () => {
    const approve = vi.fn();
    const { unmount } = render(<HomeDashboardInbox animate approved={false} onApprove={approve} />);
    act(() => { vi.advanceTimersByTime(400); });
    unmount();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(approve).not.toHaveBeenCalled();
  });
});
