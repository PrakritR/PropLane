// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu, RECORD_ACTION_DESTRUCTIVE_SETTLE_MS } from "@/components/ui/record-action-menu";

afterEach(cleanup);

/**
 * Direct `RecordActionContext` harness (simpler than routing through
 * `PortalRecordListSurface` / `DataList` for these menu-content assertions —
 * mirrors `communication-row-actions.tsx`'s own usage of the context).
 */
function Harness({
  onEdit = () => {},
  onDelete = () => {},
  onDuplicate = () => {},
}: {
  onEdit?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
}) {
  return (
    <RecordActionContext.Provider
      value={{
        scope: "test-record",
        clear: () => {},
        actions: (
          <>
            <Button onClick={onEdit}>Edit</Button>
            <Button variant="danger" onClick={onDelete}>Delete</Button>
            <Button onClick={onDuplicate}>Duplicate</Button>
          </>
        ),
      }}
    >
      <RecordActionMenu label="Test record" activate={() => {}} />
    </RecordActionContext.Provider>
  );
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Test record" }), { key: "ArrowDown" });
}

describe("RecordActionMenu destructive ordering", () => {
  it("moves the destructive action last regardless of source order, separated by a divider", async () => {
    render(<Harness />);
    openMenu();
    const menu = await screen.findByRole("menu");
    const items = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]'));
    const shape = items.map((el) => (el.getAttribute("role") === "separator" ? "separator" : el.textContent));
    expect(shape).toEqual(["Edit", "Duplicate", "separator", "Delete"]);
  });
});

describe("RecordActionMenu destructive settle guard", () => {
  it("is a no-op at 0ms: an immediate click on the destructive item is swallowed and the menu stays open", async () => {
    const onDelete = vi.fn();
    render(<Harness onDelete={onDelete} />);
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    openMenu();
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    // Still mocked to the same instant the menu opened at — 0ms elapsed.
    fireEvent.click(deleteItem);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeNull();
    dateSpy.mockRestore();
  });

  it("passes the click through once the settle window has elapsed", async () => {
    const onDelete = vi.fn();
    render(<Harness onDelete={onDelete} />);
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    openMenu();
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    dateSpy.mockReturnValue(1_000 + RECORD_ACTION_DESTRUCTIVE_SETTLE_MS + 1);
    fireEvent.click(deleteItem);
    expect(onDelete).toHaveBeenCalledTimes(1);
    dateSpy.mockRestore();
  });
});

describe("record-action-menu destructive color token", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("resolves .record-action-menu .text-danger to the semantic --destructive token, not the old hard-coded hex", () => {
    expect(css).toMatch(/\.record-action-menu\s+\.text-danger\s*\{\s*color:\s*var\(--destructive\);?\s*\}/);
    expect(css).not.toContain("#b93838");
  });

  it("defines --destructive in both the light and dark blocks", () => {
    const matches = css.match(/--destructive:\s*[^;]+;/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("mobileSheet prop removed from DropdownMenuContent", () => {
  // The old bottom-pinned mobile card's `mobileSheet` prop is gone entirely.
  // `mobileSheetClassName` / `mobileSheetFillsViewport` / `mobileSheetRaised`
  // are an unrelated feature on the filter sheet (and its browse caller) and
  // stay allowed.
  const ALLOWED = new Set(["mobileSheetClassName", "mobileSheetFillsViewport", "mobileSheetRaised"]);
  const SOURCE_FILES = walk(join(process.cwd(), "src")).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".css"),
  );

  it("every occurrence of the substring `mobileSheet` belongs to one of the three allowed identifiers", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const content = readFileSync(file, "utf8");
      const matches = content.match(/mobileSheet[A-Za-z0-9_]*/g) ?? [];
      for (const match of matches) {
        if (!ALLOWED.has(match)) offenders.push(`${file}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("data-mobile-sheet never appears in src/", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const content = readFileSync(file, "utf8");
      if (content.includes("data-mobile-sheet")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
