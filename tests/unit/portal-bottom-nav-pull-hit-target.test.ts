/**
 * PRP-366 / PRP-349: the "Show all sections" pull control must not cover the
 * bottom-nav tabs. A full-width `inset-x-0` + `h-11` overlay stole every tap.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("portal native bottom-nav pull hit target (PRP-366)", () => {
  const sidebarSrc = readFileSync(
    join(process.cwd(), "src/components/portal/portal-sidebar.tsx"),
    "utf8",
  );

  it("does not use a full-bar pull overlay over the tabs", () => {
    expect(sidebarSrc).not.toMatch(
      /portal-native-bottom-nav-pull[^"]*inset-x-0[^"]*h-11/,
    );
    expect(sidebarSrc).not.toMatch(
      /portal-native-bottom-nav-pull[^"]*h-11[^"]*inset-x-0/,
    );
  });

  it("keeps the pull control as a narrow centered handle hit target", () => {
    expect(sidebarSrc).toContain("portal-native-bottom-nav-pull absolute left-1/2");
    expect(sidebarSrc).toContain("h-4 w-14");
  });
});
