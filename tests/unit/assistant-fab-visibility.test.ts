// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldHideAssistantFab } from "@/lib/axis-assistant/fab-visibility";

const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const CHROME_HOOK = readFileSync(
  join(process.cwd(), "src/hooks/use-communication-surface-chrome.ts"),
  "utf8",
);

function setHtmlAttrs(attrs: Record<string, boolean>) {
  const html = document.documentElement;
  for (const [key, on] of Object.entries(attrs)) {
    if (on) html.setAttribute(key, "true");
    else html.removeAttribute(key);
  }
}

describe("shouldHideAssistantFab", () => {
  afterEach(() => {
    setHtmlAttrs({
      "data-hide-assistant-fab": false,
      "data-rental-wizard-active": false,
      "data-communication-surface": false,
      "data-communication-hide-assistant-fab": false,
      "data-communication-thread-reading": false,
      "data-communication-thread-selected": false,
    });
  });

  it("hides when explicitly suppressed", () => {
    setHtmlAttrs({ "data-hide-assistant-fab": true });
    expect(shouldHideAssistantFab()).toBe(true);
  });

  it("shows on Communication list (no thread open) for manager", () => {
    setHtmlAttrs({
      "data-communication-surface": true,
      "data-communication-thread-reading": false,
      "data-communication-thread-selected": false,
      "data-communication-hide-assistant-fab": false,
    });
    expect(shouldHideAssistantFab()).toBe(false);
  });

  it("hides on resident Communication for the whole tab", () => {
    setHtmlAttrs({
      "data-communication-surface": true,
      "data-communication-hide-assistant-fab": true,
    });
    expect(shouldHideAssistantFab()).toBe(true);
  });

  it("hides on Communication while a thread is open (desktop and mobile)", () => {
    setHtmlAttrs({
      "data-communication-surface": true,
      "data-communication-thread-reading": true,
    });
    expect(shouldHideAssistantFab()).toBe(true);
  });

  it("hides on Communication when a conversation is selected (desktop split)", () => {
    setHtmlAttrs({
      "data-communication-surface": true,
      "data-communication-thread-selected": true,
    });
    expect(shouldHideAssistantFab()).toBe(true);
  });
});

describe("Communication chrome does not hide the Ask PropLane dock", () => {
  it("keeps FAB hide rules on an open Communication thread", () => {
    expect(GLOBALS_CSS).toContain(
      "html[data-communication-surface][data-communication-thread-selected] .axis-assistant-fab",
    );
    expect(GLOBALS_CSS).toContain(
      "html[data-communication-surface][data-communication-thread-reading] .axis-assistant-fab",
    );
  });

  it("never display:none the dock rail on Communication attrs", () => {
    for (const block of GLOBALS_CSS.split("}")) {
      if (!block.includes(".portal-assistant-dock-rail") || !/display:\s*none/.test(block)) continue;
      expect(block).not.toContain("data-communication-thread-selected");
      expect(block).not.toContain("data-communication-thread-reading");
      expect(block).not.toContain("data-communication-hide-assistant-fab");
    }
  });

  it("does not stamp the global hide-FAB flag that also blanks the rail", () => {
    expect(CHROME_HOOK).not.toMatch(/dataset\.hideAssistantFab\s*=\s*"true"/);
  });
});
