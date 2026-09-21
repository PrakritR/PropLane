/** @vitest-environment jsdom */
/**
 * Portfolio import (rebuilt) — the three-step page at
 * `/portal/properties/import` (AREA 5). Covers: all three steps render from
 * a fixture proposal, a needs-row answer PATCHes and re-renders from the
 * server's response, Create posts `sendInvites: false` unless the checkbox
 * is ticked, and a failed create names the row. No pills (no `<Badge`) and
 * no page-level subtext under the headings.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { routeResolves } from "../helpers/route-resolves";
import { PortfolioImportUploadStep } from "@/components/portal/portfolio-import/upload-step";
import { PortfolioImportReviewStep } from "@/components/portal/portfolio-import/review-step";
import { PortfolioImportCreateStep } from "@/components/portal/portfolio-import/create-step";
import type { PortfolioImportCreateResult, PortfolioImportProposal } from "@/lib/portfolio-import/types";

afterEach(() => cleanup());

const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/portfolio-import/proposal.json"), "utf8"),
) as PortfolioImportProposal;

describe("route", () => {
  it("/portal/properties/import resolves to the static page, ahead of properties/[stage]", () => {
    expect(routeResolves("/portal/properties/import")).toBe(true);
  });
});

describe("PortfolioImportUploadStep", () => {
  it("shows the file kinds, the dropzone, and disables Read files until a file is picked", () => {
    render(<PortfolioImportUploadStep uploading={false} error={null} onSubmit={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText("Import your portfolio")).toBeTruthy();
    expect(screen.getByText("Drop files here")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read files" })).toBeDisabled();
  });

  it("submits the picked files and hint", () => {
    const onSubmit = vi.fn();
    render(<PortfolioImportUploadStep uploading={false} error={null} onSubmit={onSubmit} onBack={vi.fn()} />);
    const file = new File(["a,b"], "rentroll.csv", { type: "text/csv" });
    const input = document.querySelector('[data-attr="portfolio-import-file-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Anything PropLane should know?"), { target: { value: "2 buildings" } });
    fireEvent.click(screen.getByRole("button", { name: "Read files" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual([file]);
    expect(onSubmit.mock.calls[0][1]).toBe("2 buildings");
  });

  it("shows the server's error message and lets the manager retry", () => {
    render(
      <PortfolioImportUploadStep
        uploading={false}
        error="PropLane could not read the files."
        onSubmit={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("PropLane could not read the files.");
  });
});

describe("PortfolioImportReviewStep", () => {
  it("renders one card per property and a fact line built from the real rows", () => {
    render(
      <PortfolioImportReviewStep proposal={FIXTURE} saving={false} onAnswer={vi.fn()} onSkipToggle={vi.fn()} onContinue={vi.fn()} />,
    );
    expect(screen.getAllByText(FIXTURE.properties[0]!.address)).toHaveLength(1);
    expect(screen.getAllByText(FIXTURE.properties[1]!.address)).toHaveLength(1);
    const roomCount = FIXTURE.properties.reduce((sum, p) => sum + p.rooms.length, 0);
    const residentCount = FIXTURE.properties.reduce((sum, p) => sum + p.residents.length, 0);
    const summary = screen.getByText((_, node) => node?.getAttribute("data-attr") === "portfolio-import-summary-line");
    expect(summary.textContent).toContain(`${roomCount} rooms`);
    expect(summary.textContent).toContain(`${residentCount} residents`);
  });

  it("cites the source row and shows a plain status word, never a pill, on each row", () => {
    render(
      <PortfolioImportReviewStep proposal={FIXTURE} saving={false} onAnswer={vi.fn()} onSkipToggle={vi.fn()} onContinue={vi.fn()} />,
    );
    const jordanRow = screen.getByText("Jordan Lee").closest('[data-attr="portfolio-import-resident-row"]') as HTMLElement;
    expect(within(jordanRow).getByText("row 3")).toBeTruthy();
    expect(within(jordanRow).getByText("Ready")).toBeTruthy();
    const ariRow = screen.getByText("Ari Chen").closest('[data-attr="portfolio-import-resident-row"]') as HTMLElement;
    expect(within(ariRow).getByText("row 4")).toBeTruthy();
    expect(within(ariRow).getByText("Needs end date")).toBeTruthy();
    expect(document.querySelector("[class*='Badge']")).toBeNull();
  });

  it("expands a needs row and PATCHes the gap answer through onAnswer", () => {
    const onAnswer = vi.fn();
    render(
      <PortfolioImportReviewStep proposal={FIXTURE} saving={false} onAnswer={onAnswer} onSkipToggle={vi.fn()} onContinue={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Ari Chen"));
    const input = screen.getByLabelText("What date does Ari's lease end?") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2027-01-31" } });
    expect(onAnswer).toHaveBeenCalledWith("resident-ari-chen", { leaseEnd: "2027-01-31" });
  });

  it("a room with no resident offers Leave empty / Skip", () => {
    render(
      <PortfolioImportReviewStep proposal={FIXTURE} saving={false} onAnswer={vi.fn()} onSkipToggle={vi.fn()} onContinue={vi.fn()} />,
    );
    // room-elm-3 has no resident in the fixture.
    expect(screen.getByText("Room 3 · Leave empty")).toBeTruthy();
  });

  it("the ⋯ menu Skips a ready row through onSkipToggle", async () => {
    const onSkipToggle = vi.fn();
    render(
      <PortfolioImportReviewStep proposal={FIXTURE} saving={false} onAnswer={vi.fn()} onSkipToggle={onSkipToggle} onContinue={vi.fn()} />,
    );
    const jordanRow = screen.getByText("Jordan Lee").closest('[data-attr="portfolio-import-resident-row"]') as HTMLElement;
    await userEvent.click(within(jordanRow).getByRole("button", { name: "Actions for Jordan Lee" }));
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByText("Skip"));
    expect(onSkipToggle).toHaveBeenCalledWith("resident-jordan-lee", false);
  });

  it("Create N… reflects the residents not marked skip", () => {
    render(
      <PortfolioImportReviewStep proposal={FIXTURE} saving={false} onAnswer={vi.fn()} onSkipToggle={vi.fn()} onContinue={vi.fn()} />,
    );
    const included = FIXTURE.properties.reduce((sum, p) => sum + p.residents.filter((r) => r.status !== "skip").length, 0);
    expect(screen.getByRole("button", { name: `Create ${included}…` })).toBeTruthy();
  });
});

describe("PortfolioImportCreateStep", () => {
  it("posts sendInvites: false by default", () => {
    const onCreate = vi.fn();
    render(<PortfolioImportCreateStep proposal={FIXTURE} result={null} creating={false} onBack={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Create everything" }));
    expect(onCreate).toHaveBeenCalledWith(false);
  });

  it("posts sendInvites: true once the checkbox is ticked", () => {
    const onCreate = vi.fn();
    render(<PortfolioImportCreateStep proposal={FIXTURE} result={null} creating={false} onBack={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByLabelText("Email + SMS each resident now"));
    fireEvent.click(screen.getByRole("button", { name: "Create everything" }));
    expect(onCreate).toHaveBeenCalledWith(true);
  });

  it("names the property and row in a failed create's failures list", () => {
    const result: PortfolioImportCreateResult = {
      created: { properties: 1, rooms: 3, residents: 1, leases: 1, charges: 2, tasks: 1, invites: 0 },
      failures: [
        { propertyKey: "prop-elm", address: "48 Elm Ave, Austin, TX 78702", row: 18, message: "Room 2 rent was missing." },
      ],
    };
    render(<PortfolioImportCreateStep proposal={FIXTURE} result={result} creating={false} onBack={vi.fn()} onCreate={vi.fn()} />);
    const failureRow = screen.getByText("48 Elm Ave, Austin, TX 78702").closest('[data-attr="portfolio-import-failure-row"]') as HTMLElement;
    expect(within(failureRow).getByText("Row 18 — Room 2 rent was missing.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Done" }).getAttribute("href")).toBe("/portal/properties?tab=drafts");
  });
});

describe("no pills, no page-subtext", () => {
  const SOURCES = [
    "src/components/portal/portfolio-import/upload-step.tsx",
    "src/components/portal/portfolio-import/review-step.tsx",
    "src/components/portal/portfolio-import/create-step.tsx",
  ];

  it("draws no Badge or status chip", () => {
    for (const file of SOURCES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} draws a <Badge`).not.toMatch(/<Badge\b/);
    }
  });

  it("upload/review headings carry no subtitle prop", () => {
    for (const file of SOURCES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} passes a subtitle=`).not.toMatch(/\bsubtitle=\{/);
    }
  });
});
