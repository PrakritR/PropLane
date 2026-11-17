// @vitest-environment jsdom
//
// The manager dashboard never draws a zero it has not read: while a read is pending the tile is a
// skeleton, after 12 s (or on error) it is "—" with "Unavailable · Retry", and only an answered
// read shows its figure, zero included.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AttentionPanel, KpiCard, combineReadStates, settleRead } from "@/components/portal/pro-dashboard-kpis";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("KpiCard read states", () => {
  it("loading draws a skeleton, never the zero", () => {
    render(<KpiCard label="Occupancy" value="0%" state="loading" href="/x" />);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading Occupancy" })).toBeInTheDocument();
  });

  it("failed draws a dash and Unavailable with a Retry that re-runs the read", async () => {
    const onRetry = vi.fn(async () => undefined);
    render(<KpiCard label="Rent collected" value="$0" state="failed" onRetry={onRetry} href="/x" />);
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("an answered zero is shown", () => {
    render(<KpiCard label="Occupancy" value="0%" state="ready" href="/x" />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});

describe("AttentionPanel read states", () => {
  it("never says nothing is waiting while loading", () => {
    render(<AttentionPanel rows={[]} state="loading" />);
    expect(screen.queryByText(/Nothing is waiting/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading needs attention" })).toBeInTheDocument();
  });

  it("shows Unavailable and Retry when a source failed", () => {
    const onRetry = vi.fn();
    render(<AttentionPanel rows={[]} state="failed" onRetry={onRetry} />);
    expect(screen.queryByText(/Nothing is waiting/)).not.toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("says nothing is waiting only once every source answered", () => {
    render(<AttentionPanel rows={[]} state="ready" />);
    expect(screen.getByText("Nothing is waiting on you. Nice.")).toBeInTheDocument();
  });
});

describe("settling a read", () => {
  it("combines states: failed beats loading beats ready", () => {
    expect(combineReadStates(["ready", "loading"])).toBe("loading");
    expect(combineReadStates(["loading", "failed"])).toBe("failed");
    expect(combineReadStates(["ready", "ready"])).toBe("ready");
  });

  it("a read with no answer in 12 s is failed", async () => {
    vi.useFakeTimers();
    const pending = settleRead(new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(pending).resolves.toBe("failed");
  });

  it("a rejection, a false answer and an unanswered flag are failed; an answer is ready", async () => {
    await expect(settleRead(Promise.reject(new Error("x")))).resolves.toBe("failed");
    await expect(settleRead(Promise.resolve(false))).resolves.toBe("failed");
    await expect(settleRead(Promise.resolve([]), { answered: () => false })).resolves.toBe("failed");
    await expect(settleRead(Promise.resolve([]))).resolves.toBe("ready");
  });
});
