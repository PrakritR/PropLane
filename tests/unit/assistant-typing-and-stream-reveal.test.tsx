// @vitest-environment jsdom
//
// M012 — typing indicator wave timing + one-shot streaming-text reveal
// (assistant-panel-chrome.tsx's AssistantMessageList), shared by the
// assistant dock AND every Communication thread's embedded assistant strip
// (both render through AssistantDockPanel -> this same component).
import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AssistantMessageList } from "@/components/portal/assistant-panel-chrome";

describe("AssistantMessageList — M012", () => {
  it("waves the typing dots on the interior.dev timing class, not a generic pulse", () => {
    const { container } = render(
      <AssistantMessageList messages={[]} ratings={{}} onRate={() => undefined} loading />,
    );
    const dots = container.querySelectorAll(".motion-typing-dot");
    expect(dots).toHaveLength(3);
    dots.forEach((dot) => expect(dot).toHaveAttribute("aria-hidden", "true"));
    // The status text itself carries the meaning; the dots are decorative.
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Thinking…");
    cleanup();
  });

  it("never shows the typing indicator when not loading", () => {
    const { container } = render(
      <AssistantMessageList messages={[]} ratings={{}} onRate={() => undefined} loading={false} />,
    );
    expect(container.querySelectorAll(".motion-typing-dot")).toHaveLength(0);
    cleanup();
  });

  it("does not mark a message present at first paint as a fresh reveal (a reopened thread)", () => {
    const { container } = render(
      <AssistantMessageList
        messages={[{ role: "assistant", content: "Earlier answer from history" }]}
        ratings={{}}
        onRate={() => undefined}
        loading={false}
      />,
    );
    expect(container.querySelector(".motion-stream-reveal")).toBeNull();
    expect(container.textContent).toContain("Earlier answer from history");
    cleanup();
  });

  it("marks a reply appended after mount as a fresh one-shot reveal, without altering the real text", () => {
    const { container, rerender } = render(
      <AssistantMessageList
        messages={[{ role: "user", content: "Create a charge" }]}
        ratings={{}}
        onRate={() => undefined}
        loading
      />,
    );
    expect(container.querySelector(".motion-stream-reveal")).toBeNull();

    rerender(
      <AssistantMessageList
        messages={[
          { role: "user", content: "Create a charge" },
          { role: "assistant", content: "Done — $50 recorded." },
        ]}
        ratings={{}}
        onRate={() => undefined}
        loading={false}
      />,
    );
    const revealed = container.querySelector(".motion-stream-reveal");
    expect(revealed).not.toBeNull();
    // The real text is present in full, immediately — never retyped/altered.
    expect(revealed!.textContent).toContain("Done — $50 recorded.");
    cleanup();
  });

  it("never marks the user's own message with the assistant reveal class", () => {
    const { container } = render(
      <AssistantMessageList
        messages={[{ role: "user", content: "Hello" }]}
        ratings={{}}
        onRate={() => undefined}
        loading={false}
      />,
    );
    expect(container.querySelector(".motion-stream-reveal")).toBeNull();
    cleanup();
  });
});
