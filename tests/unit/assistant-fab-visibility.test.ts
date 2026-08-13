// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { shouldHideAssistantFab } from "@/lib/axis-assistant/fab-visibility";

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
