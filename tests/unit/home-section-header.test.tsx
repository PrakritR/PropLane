// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HomeSectionHeader } from "@/components/marketing/home-section-header";
import { HomeJoinFree } from "@/components/marketing/home-join-free";
import { MANAGER_GET_STARTED_HREF, RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";

afterEach(cleanup);

describe("homepage section headers", () => {
  it("renders one shared class", () => {
    render(<HomeSectionHeader id="x">Service</HomeSectionHeader>);
    expect(screen.getByRole("heading", { level: 2, name: "Service" })).toHaveClass("home-section-head");
  });

  it("uses the exact top-bar words in the page and the number stage", () => {
    const nav = readFileSync("src/components/layout/home-navbar.tsx", "utf8");
    const page = readFileSync("src/app/(public)/page.tsx", "utf8");
    const stage = readFileSync("src/components/marketing/home-number-stage.tsx", "utf8");
    const pricing = readFileSync("src/components/marketing/home-pricing-compare.tsx", "utf8");
    for (const word of ["How it works", "Service", "Pricing", "Contact"]) expect(nav).toContain(`"${word}"`);
    expect(stage).toContain('title="How it works"');
    expect(page).toContain("<HomeSectionHeader id=\"home-service-title\">Service</HomeSectionHeader>");
    expect(page).toContain("<HomeSectionHeader id=\"home-contact-title\">Contact</HomeSectionHeader>");
    expect(pricing).toContain("<HomeSectionHeader id={titleId}>Pricing</HomeSectionHeader>");
  });
});

describe("join free row", () => {
  it("wears the shared section header, like Contact (captain #22)", () => {
    render(<HomeJoinFree />);
    expect(screen.getByRole("heading", { level: 2, name: "Join free" })).toHaveClass("home-section-head");
  });

  it("says what each role does by text and carries no number button (captain #23)", () => {
    render(<HomeJoinFree />);
    expect(screen.getByText("Find housing by text")).toBeInTheDocument();
    expect(screen.getByText("Get jobs by text")).toBeInTheDocument();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it("links each role to its own preselected sign-up", () => {
    render(<HomeJoinFree />);
    const links = screen.getAllByRole("link", { name: /Sign up free/ });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF, MANAGER_GET_STARTED_HREF]);
    expect(RESIDENT_GET_STARTED_HREF).toContain("role=resident");
    expect(VENDOR_GET_STARTED_HREF).toContain("role=vendor");
    expect(MANAGER_GET_STARTED_HREF).toContain("role=manager");
  });
});
