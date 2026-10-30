import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

it("keeps legacy role fallback confined to the reviewed routing and display inventory", () => {
  const root = join(process.cwd(), "src");
  const exceptions = new Set([
    // Client contact autofill and post-auth navigation do not grant API capabilities.
    "hooks/use-prospect-contact-autofill.ts",
    "lib/auth/resolve-post-auth-destination.ts",
  ]);
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.[tj]sx?$/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        const name = relative(root, path);
        if (text.split("\n").some((line) => line.includes("normalizePortalRoles(") && !line.includes("function normalizePortalRoles(") && !/,[ \t]*null\s*\)/.test(line))) {
          expect(exceptions.has(name), name).toBe(true);
        }
      }
    }
  }
  scan(root);
});
