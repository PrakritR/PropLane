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
    expect(screen.getByRole("heading", { name: "Review what the agent found" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create it, invite when you're ready" })).toBeInTheDocument();
  });

  // Captain 2026-09-25: the review step is a real /demo slice, not a
  // hand-drawn replica of it — assert the deep-link, not invented copy.
  it("embeds the real /demo Properties -> Import review screen, not a hand-drawn replica", () => {
    render(<SiteSwitchSteps />);
    const iframe = document.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
    expect(iframe?.getAttribute("src")).toBe("/demo?role=manager&section=import");
    expect(iframe).toHaveAttribute("tabindex", "-1");
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
