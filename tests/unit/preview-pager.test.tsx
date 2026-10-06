// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_STEP_MAX_QUESTIONS,
  PreviewPager,
  clampPreviewIndex,
  packPreviewSteps,
  previewStepIndexOf,
  previewStepLabel,
  type PreviewGroup,
} from "@/components/portal/preview-pager";

afterEach(cleanup);

const group = (key: string, count: number): PreviewGroup<string> => ({ key, title: key.toUpperCase(), items: Array.from({ length: count }, (_, i) => `${key}${i + 1}`) });
const sizes = (steps: PreviewGroup<string>[][]) => steps.map((step) => step.map((g) => `${g.key}:${g.items.length}`));

describe("packPreviewSteps", () => {
  it("fills a step up to the cap, then starts the next", () => {
    expect(PREVIEW_STEP_MAX_QUESTIONS).toBe(6);
    expect(sizes(packPreviewSteps([group("a", 2), group("b", 3), group("c", 2), group("d", 1)]))).toEqual([["a:2", "b:3"], ["c:2", "d:1"]]);
  });

  it("combines short consecutive sections exactly up to the cap", () => {
    expect(sizes(packPreviewSteps([group("a", 3), group("b", 3), group("c", 1)]))).toEqual([["a:3", "b:3"], ["c:1"]]);
  });

  it("never splits a section; one bigger than the cap gets a step to itself", () => {
    expect(sizes(packPreviewSteps([group("a", 1), group("big", 9), group("c", 1)]))).toEqual([["a:1"], ["big:9"], ["c:1"]]);
  });

  it("drops empty sections and returns no steps for an empty form", () => {
    expect(sizes(packPreviewSteps([group("a", 0), group("b", 2), group("c", 0)]))).toEqual([["b:2"]]);
    expect(packPreviewSteps([])).toEqual([]);
  });

  it("honours a custom cap", () => {
    expect(sizes(packPreviewSteps([group("a", 2), group("b", 2)], 3))).toEqual([["a:2"], ["b:2"]]);
  });
});

describe("step helpers", () => {
  it("labels and clamps", () => {
    expect(previewStepLabel(0, 4, "Form")).toBe("Step 1 of 4 · Form");
    expect(clampPreviewIndex(9, 3)).toBe(2);
    expect(clampPreviewIndex(-1, 3)).toBe(0);
    expect(clampPreviewIndex(5, 0)).toBe(0);
  });

  it("finds the step holding an item, counting a leading step", () => {
    const groups = [group("a", 4), group("b", 4), group("c", 1)];
    expect(previewStepIndexOf(groups, (item) => item === "a2")).toBe(0);
    expect(previewStepIndexOf(groups, (item) => item === "c1")).toBe(1);
    expect(previewStepIndexOf(groups, (item) => item === "c1", true)).toBe(2);
    expect(previewStepIndexOf(groups, (item) => item === "zzz")).toBe(-1);
  });
});

function pager(props: Partial<Parameters<typeof PreviewPager<string>>[0]> = {}) {
  return (
    <PreviewPager<string>
      heading="Applicant sees"
      ariaLabel="What the applicant sees"
      dataAttr="pager-test"
      attrPrefix="pager"
      formName="Lease"
      groups={[group("a", 4), group("b", 4), group("c", 1)]}
      itemKey={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      emptyText="No questions yet."
      {...props}
    />
  );
}

describe("PreviewPager", () => {
  it("shows the step line, whole sections with titles, and ‹ › that disable at the ends", () => {
    render(pager());
    expect(screen.getByText("Step 1 of 2 · Lease")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A" })).toBeTruthy();
    expect(screen.getByText("a4")).toBeTruthy();
    expect(screen.queryByText("b1")).toBeNull();
    const prev = screen.getByRole("button", { name: "Previous step" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(screen.getByText("Step 2 of 2 · Lease")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "B" })).toBeTruthy();
    expect(screen.getByText("c1")).toBeTruthy();
    expect(screen.queryByText("a1")).toBeNull();
    expect((screen.getByRole("button", { name: "Previous step" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("can be controlled and reports the next index", () => {
    const onIndexChange = vi.fn();
    const { rerender } = render(pager({ index: 0, onIndexChange }));
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(onIndexChange).toHaveBeenCalledWith(1);
    rerender(pager({ index: 1, onIndexChange }));
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
  });

  it("clamps an index past the end", () => {
    render(pager({ index: 40 }));
    expect(screen.getByText("Step 2 of 2 · Lease")).toBeTruthy();
  });

  it("draws a leading step first and counts it", () => {
    render(pager({ leadingStep: <p>The PDF</p> }));
    expect(screen.getByText("Step 1 of 3 · Lease")).toBeTruthy();
    expect(screen.getByText("The PDF")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText("a1")).toBeTruthy();
  });

  it("draws no arrows for a form that fits one step", () => {
    render(pager({ groups: [group("a", 2)] }));
    expect(screen.getByText("Step 1 of 1 · Lease")).toBeTruthy();
    expect(screen.getByText("a2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous step" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
  });

  it("with nothing to show, names the form and says so, with no arrows", () => {
    render(pager({ groups: [] }));
    expect(screen.getByText("No questions yet.")).toBeTruthy();
    expect(screen.getByText("Lease")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
  });
});

describe("both editors draw the shared pager", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  it("the application and move-in panels are PreviewPager, with no private header or arrows", () => {
    const application = read("src/components/portal/application-form-builder.tsx");
    const moveIn = read("src/components/portal/move-in-forms/move-in-form-live-preview.tsx");
    for (const source of [application, moveIn]) {
      expect(source).toContain("<PreviewPager");
      expect(source).not.toContain("ChevronLeft");
      expect(source).not.toMatch(/Previous question|Next question/);
    }
  });
});
