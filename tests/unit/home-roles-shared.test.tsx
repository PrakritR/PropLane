// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthBrandPanel } from "@/components/auth/auth-brand-panel";
import { AuthOAuthLoading } from "@/components/auth/auth-oauth-loading";
import { HomeNumberStage } from "@/components/marketing/home-number-stage";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
import { HOME_ROLES } from "@/lib/marketing/home-roles";
import { publicTextingConfig } from "@/lib/marketing/public-texting";

afterEach(cleanup);

const LABELS = HOME_ROLES.map((role) => role.label);
const config = publicTextingConfig("+12025550123");

describe("one shared list of the people who text PropLane (captain #27)", () => {
  it("is Prospects, Residents, Vendors, Managers, Owners", () => {
    expect(LABELS).toEqual(["Prospects", "Residents", "Vendors", "Managers", "Owners"]);
  });

  it("draws the auth panel's strip from it, names and short lines in order", () => {
    const { container } = render(<AuthBrandPanel />);
    const items = [...container.querySelectorAll(".auth-who > li")];
    expect(items.map((li) => li.querySelector("strong")?.textContent)).toEqual(LABELS);
    expect(items.map((li) => li.querySelector(".auth-who-line")?.textContent)).toEqual(HOME_ROLES.map((role) => role.caption));
    expect(container).not.toHaveTextContent(/Renters?/);
  });

  it("draws the homepage hero strip from it", () => {
    render(<TextingHomeHero config={config} />);
    const strip = screen.getByRole("list", { name: "Who texts PropLane" });
    expect(within(strip).getAllByRole("link").map((link) => link.textContent)).toEqual(LABELS);
  });

  it("sends each hero role straight to its own start; managers and owners to the Property sign-up (captain #31)", () => {
    render(<TextingHomeHero config={config} />);
    const strip = screen.getByRole("list", { name: "Who texts PropLane" });
    expect(within(strip).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Prospects", "/rent/browse"],
      ["Residents", "/auth/create-account?mode=create&role=resident"],
      ["Vendors", "/auth/create-account?mode=create&role=vendor"],
      ["Managers", "/auth/create-account?mode=create&role=manager"],
      ["Owners", "/auth/create-account?mode=create&role=manager"],
    ]);
  });

  it("draws How it works (and its diagram) from it", () => {
    const html = renderToStaticMarkup(<PublicTextingProvider value={config}><HomeNumberStage /></PublicTextingProvider>);
    const order = HOME_ROLES.map((role) => html.indexOf(`id="how-${role.id}"`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const role of HOME_ROLES) expect(html).toContain(role.detail);
    expect(html).toContain(`connected to ${LABELS.map((label) => label.toLowerCase()).join(", ")} through PropLane`);
  });

  it("keeps no second, hand-typed role list in those files", () => {
    for (const file of [
      "src/components/auth/auth-brand-panel.tsx",
      "src/components/marketing/texting-home-hero.tsx",
      "src/components/marketing/home-number-stage.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("HOME_ROLES");
      expect(source).not.toMatch(/["']Prospects["']|["']Owners["']|["']Renters["']/);
    }
  });
});

describe("auth interstitials (captain #27)", () => {
  it("draw a small spinner and one line, with no second logo", () => {
    const { container } = render(<AuthOAuthLoading label="Checking your account" caption="Checking your account…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking your account…");
    expect(container.querySelectorAll("svg, img")).toHaveLength(0);
  });

  it("sit in an auth layout that carries no site footer", () => {
    const shell = readFileSync("src/components/auth/auth-split-shell.tsx", "utf8");
    const chrome = readFileSync("src/components/auth/auth-layout-chrome.tsx", "utf8");
    expect(shell).not.toMatch(/AuthLayoutFooter|PublicFooter/);
    expect(chrome).not.toMatch(/PublicFooter/);
  });
});
