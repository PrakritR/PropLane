// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SiteSwitchSteps } from "@/components/marketing/site/switch-steps";
import { HOME_FAQ_ITEMS } from "@/components/marketing/site/home-faq-items";

afterEach(cleanup);

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

describe("SiteSwitchSteps", () => {
  it("renders the section heading", () => {
    render(<SiteSwitchSteps />);
    expect(
      screen.getByRole("heading", { name: "Up and running without starting over." }),
    ).toBeInTheDocument();
  });

  // Real /portal/properties/import flow is exactly Upload -> Review -> Create
  // (portfolio-import-page.tsx's `Step` type) - never the invented 5-step
  // "match columns" wizard this section used to show.
  it("renders all three real step titles", () => {
    render(<SiteSwitchSteps />);
    expect(screen.getByRole("heading", { name: "Import your portfolio" })).toBeInTheDocument();
    // "Review what the agent found" is the step's own h3 title AND the real
    // review panel's own h1 heading (both real, deliberately duplicated —
    // see the next test), so this one asserts by count rather than by role.
    expect(screen.getAllByText("Review what the agent found").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("heading", { name: "Create it, invite when you're ready" })).toBeInTheDocument();
  });

  // Captain 2026-09-26: "remove live demo no need" — the review step is now
  // the REAL `PortfolioImportReviewStep` fed the bundled sample rent roll,
  // never a live `/demo` iframe. Assert there is no iframe and the real
  // review screen's own copy renders.
  it("renders the real Properties -> Import review screen statically, never a /demo iframe", () => {
    render(<SiteSwitchSteps />);
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Review what the agent found" })).toBeInTheDocument();
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
  });

  it("is imported and rendered by the home page", () => {
    const page = read("../../src/app/(public)/page.tsx");
    expect(page).toContain(
      'import { SiteSwitchSteps } from "@/components/marketing/site/switch-steps";',
    );
    expect(page).toContain("<SiteSwitchSteps />");
  });
});

describe("home FAQ items", () => {
  it("includes the portfolio-import question", () => {
    const item = HOME_FAQ_ITEMS.find((i) => i.q === "How do we move our portfolio into PropLane?");
    expect(item).toBeDefined();
  });
});
