// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AssistantMessageList } from "@/components/portal/assistant-panel-chrome";

describe("assistant pending-only rendering", () => {
  it("shows the pending card without an empty assistant bubble", () => {
    const { container } = render(
      <AssistantMessageList
        messages={[{ role: "user", content: "Create a charge" }, { role: "assistant", content: "" }]}
        ratings={{}}
        onRate={() => undefined}
        loading={false}
        trailing={<div data-testid="pending-card">Review charge</div>}
      />,
    );
    expect(container.textContent).toContain("Create a charge");
    expect(container.textContent).toContain("Review charge");
    expect(container.querySelectorAll(".rounded-2xl")).toHaveLength(1);
    cleanup();
  });
});
