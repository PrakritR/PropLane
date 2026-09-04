// @vitest-environment jsdom
//
// Pins the shared Button's loading + double-submit contract. The double-fire
// case is the one that matters most: several money paths here (charges, payouts,
// application submit) POST on click, so a button that can be clicked twice
// before React re-renders posts twice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics/track-client";

vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));

// `globals` is off in vitest.config, so testing-library's auto-cleanup is not
// registered — without this, one test's spinner is still in the DOM for the next.
afterEach(() => {
  cleanup();
  vi.mocked(track).mockClear();
});

/** A promise this test resolves by hand, so "in flight" is a real state. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const spinner = () => screen.queryByTestId("button-spinner");

describe("Button loading state", () => {
  it("shows no spinner and stays enabled at rest", () => {
    render(<Button onClick={() => {}}>Save</Button>);
    const btn = screen.getByRole("button", { name: /save/i });
    expect(spinner()).toBeNull();
    expect(btn).not.toBeDisabled();
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("spins and disables automatically while an async onClick is in flight", async () => {
    const d = deferred();
    render(<Button onClick={() => d.promise}>Save</Button>);
    const btn = screen.getByRole("button", { name: /save/i });

    fireEvent.click(btn);
    expect(spinner()).not.toBeNull();
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("aria-busy")).toBe("true");

    d.resolve();
    await d.promise;
    // WAIT for the state update queued in the promise's `.finally` rather than
    // assuming one macrotask is enough. A bare `setTimeout(0)` is not a promise
    // that React has re-rendered — under a loaded full-suite run it sometimes
    // is not, and the assertion below fails on a button that re-arms correctly
    // a tick later.
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(spinner()).toBeNull();
  });

  it("CANNOT be double-fired: a second click in the same tick is ignored", () => {
    const d = deferred();
    const onClick = vi.fn(() => d.promise);
    render(<Button onClick={onClick}>Pay</Button>);
    const btn = screen.getByRole("button", { name: /pay/i });

    // Three clicks before React has re-rendered with the disabled attribute —
    // the ref guard, not `disabled`, is what has to stop these.
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the in-flight promise REJECTS, instead of wedging", async () => {
    const d = deferred();
    const onClick = vi.fn(() => d.promise);
    render(<Button onClick={onClick}>Send</Button>);
    const btn = screen.getByRole("button", { name: /send/i });

    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);

    // The button logs a failed action rather than rethrowing it, so nothing
    // here should see an unhandled rejection.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const settled = d.promise.catch(() => undefined);
    d.reject(new Error("network down"));
    await settled;
    // Same reason as above: wait for the re-arm instead of one macrotask.
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(logged).toHaveBeenCalledWith("Button action failed", expect.any(Error));
    logged.mockRestore();

    expect(spinner()).toBeNull();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("honours an explicit `loading` prop for promises it does not own", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading={false} onClick={onClick}>
        Save
      </Button>,
    );
    expect(spinner()).toBeNull();

    rerender(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: /save/i });
    expect(spinner()).not.toBeNull();
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("aria-busy")).toBe("true");

    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not fire onClick when explicitly disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("leaves a synchronous onClick unaffected — no spinner, repeatable", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Toggle</Button>);
    const btn = screen.getByRole("button", { name: /toggle/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(spinner()).toBeNull();
  });

  it("still fires its PostHog event once, not once per blocked click", () => {
    const d = deferred();
    render(
      <Button event="charge_created" onClick={() => d.promise}>
        Charge
      </Button>,
    );
    const btn = screen.getByRole("button", { name: /charge/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    // The blocked second click must not double-count the funnel event either.
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("charge_created", undefined);
  });

  it("does not inject a second child under asChild (Slot takes exactly one)", () => {
    render(
      <Button asChild loading>
        <a href="https://example.test/open">Open</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: /open/i });
    expect(link.getAttribute("aria-busy")).toBe("true");
    expect(spinner()).toBeNull();
  });
});
