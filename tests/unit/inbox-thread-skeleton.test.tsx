// @vitest-environment jsdom
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
});
