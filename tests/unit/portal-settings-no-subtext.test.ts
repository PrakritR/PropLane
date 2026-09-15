/**
 * Source guard for AGENTS.md § No subtext on the settings kit.
 *
 * A settings section is a title; a row is a label and its control. The kit
 * used to accept `description` / `meta` props that drew a grey sentence under
 * each of them, and every panel grew one. They were removed in one sweep; this
 * test keeps them from growing back one prop at a time.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const KIT = join(ROOT, "src", "components", "portal", "portal-settings-ui.tsx");
const PORTAL_DIR = join(ROOT, "src", "components", "portal");

const GUARDED_TAGS = ["PortalSettingsSection", "PortalSettingsRow", "PortalSettingsDisclosureRow", "PortalSettingsLinkRow"];

function portalSources(): { file: string; source: string }[] {
  return readdirSync(PORTAL_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({ file: name, source: readFileSync(join(PORTAL_DIR, name), "utf8") }));
}

describe("settings kit has no subtext props", () => {
  it("the kit declares no description or meta prop on section, row, disclosure or link rows", () => {
    const source = readFileSync(KIT, "utf8");
    for (const tag of GUARDED_TAGS) {
      const start = source.indexOf(`export function ${tag}(`);
      expect(start, `${tag} missing from kit`).toBeGreaterThan(-1);
      const propsBlock = source.slice(start, source.indexOf("}) {", start));
      expect(propsBlock, `${tag} grew a description prop`).not.toMatch(/\bdescription\??:/);
      expect(propsBlock, `${tag} grew a meta prop`).not.toMatch(/\bmeta\??:/);
    }
  });

  it("no portal panel passes description or meta to a settings section or row", () => {
    const offenders: string[] = [];
    for (const { file, source } of portalSources()) {
      for (const tag of GUARDED_TAGS) {
        const re = new RegExp(`<${tag}\\b[^>]*?\\b(description|meta)=`, "gs");
        if (re.test(source)) offenders.push(`${file}: <${tag} ${RegExp.$1}=…>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reminder type options carry no description line", () => {
    const offenders = portalSources()
      .filter(({ file }) => /reminder-(settings-bundles|type-picker)|pro-portal-settings-panels/.test(file))
      .filter(({ source }) => /^\s*description:\s*["'`]/m.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
