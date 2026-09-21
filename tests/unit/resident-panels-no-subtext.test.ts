// The resident My home, Communication and Services panels carry labels and
// controls, never a muted sentence under a heading, row or field explaining it
// (AGENTS.md → Portal UI system, "No subtext"; docs/agents/ui-change-checklist.md
// § No subtext). PLAN-0920-vendor-resident-portals's review flagged "generic
// helper prose still in My home / Communication / Services" as an outstanding
// resident-parity gap; this reads the source so the rule fails the build the
// day that prose comes back.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const PORTAL_DIR = join(ROOT, "src", "components", "portal");

const FILES = [
  "resident-move-in-view.tsx",
  "resident-move-in-panel.tsx",
  "resident-communication.tsx",
  "resident-services-panel.tsx",
  "resident-add-service-modal.tsx",
];

// Generic pattern: a bold "label" span immediately followed by more literal
// capitalized prose — the exact shape a locked-state banner used twice in
// this surface ("<label sentence.></span> <explanatory sentence>"). A plain
// single-line empty-state message ("No services yet.") never matches this,
// only a label that keeps going past its own sentence.
const GENERIC_BANNED = [
  {
    re: /font-semibold">[^<]+<\/span>\s*(?:\{" "\}\s*)?[A-Z][a-z]/,
    why: "a bold label followed by an explanatory sentence",
  },
  { re: /\bhint="[^"]*"/, why: "a field hint" },
  { re: /\bdescription="[^"]*"/, why: "a section or option description" },
];

// Specific historical sentences removed from these panels. Regression guard
// in case someone reintroduces the exact copy through a JS expression, a
// template literal, or other shape the generic regex above would not catch.
const RETIRED_SENTENCES = [
  "both you and your property manager have signed the lease",
  "Once your property manager assigns your listing room, your house details will appear here automatically",
  "Request add-ons and report issues once you and your manager have both signed",
  "Your manager will confirm the final price before approving",
  "when your manager approves the final amount",
  "This request was not approved. Contact your property manager for details",
  "Your manager receives one service list for both",
];

describe("resident My home / Communication / Services panels have no helper-prose subtext", () => {
  for (const file of FILES) {
    it(file, () => {
      const src = readFileSync(join(PORTAL_DIR, file), "utf8");
      // Comments explain the code to developers; the rule is about what renders.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

      for (const { re, why } of GENERIC_BANNED) {
        const m = code.match(re);
        expect(m, `${file} renders ${why}: ${m?.[0]}`).toBeNull();
      }

      for (const sentence of RETIRED_SENTENCES) {
        expect(
          code.includes(sentence),
          `${file} reintroduced retired helper prose: "${sentence}"`,
        ).toBe(false);
      }
    });
  }
});
