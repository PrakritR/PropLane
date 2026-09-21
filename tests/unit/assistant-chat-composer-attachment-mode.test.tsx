// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import type { PendingChatAttachment } from "@/lib/assistant-chat-attachments.client";

const attachmentMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@/lib/assistant-chat-attachments.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistant-chat-attachments.client")>();
  return {
    ...actual,
    prepareChatAttachmentsFromFiles: attachmentMocks.prepare,
    revokeAttachmentPreview: attachmentMocks.revoke,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssistantChatComposer attachment mode", () => {
  it("discards an in-flight browser attachment when SMS mode becomes active", async () => {
    let finishPreparation!: (result: { prepared: PendingChatAttachment[]; error: string | null }) => void;
    attachmentMocks.prepare.mockReturnValue(new Promise((resolve) => { finishPreparation = resolve; }));
    const onAttachmentsChange = vi.fn();
    const onAttachmentError = vi.fn();
    const props = {
      input: "",
      setInput: vi.fn(),
      onSend: vi.fn(),
      attachments: [] as PendingChatAttachment[],
      onAttachmentsChange,
      onAttachmentError,
      allowAttachments: true,
    };
    const view = render(<AssistantChatComposer {...props} />);
    const input = screen.getByLabelText("Attach image or PDF")
      .parentElement?.querySelector("input[type=file]") as HTMLInputElement;

    fireEvent.change(input, { target: { files: [new File(["image"], "unit.png", { type: "image/png" })] } });
    expect(attachmentMocks.prepare).toHaveBeenCalledTimes(1);

    view.rerender(<AssistantChatComposer {...props} allowAttachments={false} />);
    finishPreparation({
      prepared: [{
        id: "prepared-1",
        kind: "image",
        fileName: "unit.png",
        mediaType: "image/png",
        dataBase64: "aW1hZ2U=",
        previewUrl: "blob:prepared-1",
      }],
      error: "A second file was rejected.",
    });

    await waitFor(() => expect(attachmentMocks.revoke).toHaveBeenCalledWith(expect.objectContaining({ id: "prepared-1" })));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(onAttachmentError).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Attach image or PDF")).toBeNull();
  });
});
