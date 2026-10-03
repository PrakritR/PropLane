// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResidentTermTabs } from "@/components/portal/resident-term-tabs";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResidentTermTabs", () => {
  it("shows Long term and Short term text tabs with counts and switches section", () => {
    const onChange = vi.fn();
    render(<ResidentTermTabs section="applications" term="long_term" counts={{ long_term: 2, short_term: 1 }} onChange={onChange} />);
    const long = document.querySelector('[data-attr="resident-applications-term-long"]') as HTMLElement;
    const short = document.querySelector('[data-attr="resident-applications-term-short"]') as HTMLElement;
    expect(long.textContent).toContain("Long term");
    expect(long.textContent).toContain("2");
    expect(short.textContent).toContain("Short term");
    expect(short.textContent).toContain("1");
    fireEvent.click(screen.getByText("Short term"));
    expect(onChange).toHaveBeenCalledWith("short_term");
  });
});
