/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupLeaderAppIdField } from "@/components/marketing/group-leader-app-id-field";
import type { GroupLeaderLinkOk, GroupLeaderLinkPreview } from "@/lib/rental-application/group-leader-link";

const fetchPreview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rental-application/group-leader-link-client", () => ({ fetchGroupLeaderLinkPreview: fetchPreview }));
const preview: GroupLeaderLinkOk = { ok: true, leaderAppId: "PROPLANE-GRP1025A", groupId: "PROPLANE-GRP1025G", groupSize: 2, organizerFirstName: "QA", propertyId: "qa-house" };
beforeEach(() => { vi.useFakeTimers(); fetchPreview.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("group organizer validation", () => {
  it("validates once when an inline parent callback updates the form", async () => {
    fetchPreview.mockResolvedValue(preview);
    function Form() {
      const [resolved, setResolved] = useState(0);
      return <><output>{resolved}</output><GroupLeaderAppIdField value={preview.leaderAppId} onChange={() => {}} onResolved={() => setResolved((n) => n + 1)} /></>;
    }
    render(<Form />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("1");
    expect(screen.getByText(/Linked to QA's group/)).toBeTruthy();
  });

  it("delivers an in-flight result to the latest callback without restarting the lookup", async () => {
    let resolve!: (value: GroupLeaderLinkPreview) => void;
    fetchPreview.mockReturnValue(new Promise<GroupLeaderLinkPreview>((done) => { resolve = done; }));
    const first = vi.fn(); const latest = vi.fn();
    const view = render(<GroupLeaderAppIdField value={preview.leaderAppId} onChange={() => {}} onResolved={first} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    view.rerender(<GroupLeaderAppIdField value={preview.leaderAppId} onChange={() => {}} onResolved={latest} />);
    await act(async () => { resolve(preview); });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(preview);
    expect(fetchPreview).toHaveBeenCalledTimes(1);
  });

  it("discards the previous organizer response after the ID changes", async () => {
    let resolveOld!: (value: GroupLeaderLinkPreview) => void;
    fetchPreview.mockReturnValueOnce(new Promise<GroupLeaderLinkPreview>((done) => { resolveOld = done; })).mockResolvedValue({ ...preview, leaderAppId: "PROPLANE-OTHER123" });
    const onResolved = vi.fn();
    const view = render(<GroupLeaderAppIdField value={preview.leaderAppId} onChange={() => {}} onResolved={onResolved} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    view.rerender(<GroupLeaderAppIdField value="PROPLANE-OTHER123" onChange={() => {}} onResolved={onResolved} />);
    await act(async () => { resolveOld(preview); await vi.advanceTimersByTimeAsync(350); });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ leaderAppId: "PROPLANE-OTHER123" }));
  });
});
