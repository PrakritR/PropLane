// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
import { PortalInboxMessageTable } from "@/components/portal/portal-inbox-ui";
import { Button } from "@/components/ui/button";
afterEach(cleanup);
it("offers the existing action on a collapsed admin table row", async () => {
  const archive = vi.fn();
  render(<PortalInboxMessageTable rowActionMenus rows={[{ id: "one", name: "Sam", email: "sam@example.test", subject: "Question", whenLabel: "Today", read: true }]} expandedId={null} onToggleExpand={() => {}} renderExtraActions={(row) => <Button onClick={() => archive(row.id)}>Archive</Button>} />);
  fireEvent.keyDown(screen.getAllByRole("button", { name: "Actions for Question" })[0], { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(archive).toHaveBeenCalledWith("one");
});
