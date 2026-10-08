// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantChatHistoryPanel } from "@/components/portal/assistant-chat-history-panel";

afterEach(cleanup);

describe("AssistantChatHistoryPanel", () => {
  it("shows a compact archive header, prompt search, and a pencil-style new conversation action", () => {
    const onSearchQueryChange = vi.fn();
    const onNewChat = vi.fn();

    render(
      <AssistantChatHistoryPanel
        open
        threads={[]}
        activeThreadId=""
        onSelect={async () => {}}
        onDelete={async () => true}
        onNewChat={onNewChat}
        onClose={() => {}}
        searchQuery=""
        onSearchQueryChange={onSearchQueryChange}
      />,
    );

    expect(screen.getByText("Past conversations").className).toContain("uppercase");
    const search = screen.getByRole("searchbox", { name: "Search conversations" });
    fireEvent.change(search, { target: { value: "lease" } });
    expect(onSearchQueryChange).toHaveBeenCalledWith("lease");

    const newConversation = screen.getByRole("button", { name: "New conversation" });
    expect(newConversation.className).not.toContain("bg-primary");
    fireEvent.click(newConversation);
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("confirms before deleting an individual conversation", async () => {
    const onDelete = vi.fn(async () => true);
    render(
      <AssistantChatHistoryPanel
        open
        threads={[{ id: "thread-1", title: "Lease Renewal Options", updatedAt: "2026-08-04T12:00:00.000Z" }]}
        activeThreadId=""
        onSelect={async () => {}}
        onDelete={onDelete}
        onNewChat={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Lease Renewal Options" }));
    expect(screen.getByText("Delete conversation?")).toBeInTheDocument();
    // A plain click on the red button confirms (no press-and-hold).
    const confirmButton = screen.getByRole("button", { name: "Delete conversation" });
    fireEvent.click(confirmButton);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("thread-1"));
  });
});
