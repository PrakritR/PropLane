// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InboxThreadSkeleton } from "@/components/portal/portal-inbox-ui";

afterEach(cleanup);

describe("InboxThreadSkeleton", () => {
  it("announces loading instead of Select a conversation", () => {
    render(<InboxThreadSkeleton />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-attr")).toBe("inbox-thread-skeleton");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading conversation…")).toBeTruthy();
    expect(screen.queryByText("Select a conversation")).toBeNull();
    expect(screen.queryByText("select a message")).toBeNull();
  });

  it("opens in the unified inbox while a clicked or routed thread is still resolving", () => {
    const source = readFileSync("src/components/portal/pro-unified-inbox.tsx", "utf8");
    expect(source).toContain("pendingThread");
    expect(source).toContain("<InboxThreadSkeleton");
    expect(source).toMatch(/pendingThread \? \(\s*<InboxThreadSkeleton/);
  });
});
