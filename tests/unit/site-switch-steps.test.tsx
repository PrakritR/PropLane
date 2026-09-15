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

  it("renders all three step titles", () => {
    render(<SiteSwitchSteps />);
    expect(screen.getByRole("heading", { name: "Import your portfolio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Invite your residents" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Collect rent in PropLane" })).toBeInTheDocument();
  });

  it("renders the import button copy in the mock", () => {
    render(<SiteSwitchSteps />);
    expect(screen.getByText("Import 2 properties, 6 residents")).toBeInTheDocument();
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
