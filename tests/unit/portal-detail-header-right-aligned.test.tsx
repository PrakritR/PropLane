// @vitest-environment jsdom
//
// A record page's icon actions sit at the RIGHT EDGE of the header row (admin account record, admin
// property record, every manager record using `iconTitleActions`).
//
// The bug: the title block is capped (so the icons have room) but the actions host was a plain
// start-aligned flex box that grew to fill the leftover space, so the icons floated mid-row, right
// after the capped title. The fix lives in the SHARED header, so every record page gets it. jsdom
// has no layout engine, so this pins the classes that produce the alignment - on the host AND on
// the static-actions container - and the source guard stops a page from re-growing its own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";

afterEach(cleanup);

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function actionsContainer() {
  return screen.getByTestId("header-icons").parentElement as HTMLElement;
}

describe("PortalDetailHeader with iconTitleActions", () => {
  it("right-aligns the icons container, not just lets it grow", () => {
    render(
      <PortalDetailHeader
        title="Seattle Homes"
        iconTitleActions
        actions={<button type="button" data-testid="header-icons" aria-label="Disable account" />}
      />,
    );
    const host = actionsContainer();
    expect(host.className).toContain("justify-end");
    expect(host.className).toContain("items-center");
  });

  it("right-aligns on a phone too: the single-line variant keeps justify-end", () => {
    render(
      <PortalDetailHeader
        title="Seattle Homes"
        iconTitleActions
        titleSingleLine
        actions={<button type="button" data-testid="header-icons" aria-label="Edit" />}
      />,
    );
    expect(actionsContainer().className).toContain("justify-end");
  });

  it("caps the title only to leave room for the icons, which then take the far edge", () => {
    render(
      <PortalDetailHeader
        title="Seattle Homes"
        iconTitleActions
        actions={<button type="button" data-testid="header-icons" aria-label="Edit" />}
      />,
    );
    const title = screen.getByText("Seattle Homes").closest("div")!.parentElement as HTMLElement;
    expect(title.className).toContain("max-w-");
    // Both siblings flex into the row; the icons' box is the one that pushes its content right.
    expect(title.nextElementSibling).toBe(actionsContainer());
  });

  it("renders no icons container at all when there are no actions", () => {
    const { container } = render(<PortalDetailHeader title="Seattle Homes" iconTitleActions />);
    expect(container.querySelector('[data-slot="portal-title-actions"]')).toBeNull();
  });
});

describe("the fix lives in the shared header", () => {
  const shell = read("src/components/portal/portal-list-detail-shell.tsx");
  const slot = shell.slice(shell.indexOf("{/* The host stays mounted even while empty"), shell.indexOf("<div\n        className={cn(\n          \"w-full min-w-0 flex-col"));

  it("the iconTitleActions container and the published-actions host are both justify-end", () => {
    const occurrences = slot.match(/justify-end/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("the published-actions host no longer grows (a growing host pushes sibling icons left)", () => {
    const host = slot.slice(slot.indexOf("<PortalTitleActionsHost detail\n"), slot.indexOf("/>", slot.indexOf("<PortalTitleActionsHost detail\n")));
    expect(host).not.toContain("flex-1");
    expect(host).not.toContain("basis-0");
  });

  it("record pages inherit it - none carries a justify/ml-auto patch of its own", () => {
    for (const page of [
      "src/components/portal/admin-account-record-page.tsx",
      "src/components/portal/admin-property-record-page.tsx",
    ]) {
      const src = read(page);
      expect(src).toContain("iconTitleActions");
      expect(src).not.toMatch(/PortalRecordActions[^>]*className/);
      expect(src).not.toContain("justify-end");
    }
  });
});
