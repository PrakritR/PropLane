import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Radix keeps its focus-scope stack and its dismissable-layer stack in module scope. When the Dialog and the
 * DropdownMenu each resolve their OWN copy, the Dialog's focus trap is never paused while a menu inside it is
 * open, so the trap pulls focus back out of the menu and the menu closes in the same frame (the Bookings day
 * dialog's ⋯ did exactly that). `package.json` overrides keep one copy of each.
 */
function resolvedFrom(parent: string, dependency: string): string {
  const parentDir = path.join(process.cwd(), "node_modules", parent);
  return createRequire(path.join(parentDir, "noop.js")).resolve(dependency);
}

describe("one Radix focus stack for dialogs and menus", () => {
  for (const dependency of ["@radix-ui/react-focus-scope", "@radix-ui/react-dismissable-layer"]) {
    it(`${dependency} resolves to the same file for the Dialog and the Menu`, () => {
      expect(resolvedFrom("@radix-ui/react-menu", dependency)).toBe(resolvedFrom("@radix-ui/react-dialog", dependency));
    });
  }
});
