// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";

function renderComposer(input: string) {
  return render(
    <AssistantChatComposer
      input={input}
      setInput={vi.fn()}
      onSend={vi.fn()}
      attachments={[]}
      onAttachmentsChange={vi.fn()}
    />,
  );
}

describe("assistant chat composer layout", () => {
  afterEach(cleanup);

  it("keeps both controls 32px circles, clear of the portal's 44px button floor", () => {
    renderComposer("");
    for (const name of ["Send message", "Attach image or PDF"]) {
      const cls = screen.getByRole("button", { name }).className;
      expect(cls, name).toContain("size-8");
      expect(cls, name).toContain("min-h-0");
      expect(cls, name).toContain("rounded-full");
    }
  });

  it("draws one focus ring (the box's) and no baseline gap under the textarea", () => {
    renderComposer("");
    const cls = screen.getByRole("textbox").className;
    expect(cls).toMatch(/\bblock\b/);
    expect(cls).toContain("focus-visible:outline-none!");
  });

  it("fills the send button only when there is something to send", () => {
    const { rerender } = renderComposer("");
    const send = () => screen.getByRole("button", { name: "Send message" });
    expect(send()).toBeDisabled();
    expect(send().style.background).toBe("");

    rerender(
      <AssistantChatComposer
        input="Late rent?"
        setInput={vi.fn()}
        onSend={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(send()).toBeEnabled();
    expect(send().style.background).toContain("--btn-primary");
  });
});
