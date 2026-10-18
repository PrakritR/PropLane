// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxComposer } from "@/components/portal/portal-inbox-ui";
import {
  INBOX_ATTACHMENT_FAILED_MESSAGE,
  INBOX_ATTACHMENT_UPLOADING_MESSAGE,
} from "@/lib/inbox-attachment-send-gate";

afterEach(() => cleanup());

const attachment = (over: Partial<{ uploading: boolean; error: string }>) => ({
  id: "a1",
  fileName: "photo.jpg",
  previewUrl: "blob:photo",
  ...over,
});

function composer(attachments: ReturnType<typeof attachment>[], sendAtLabel?: string) {
  return (
    <InboxComposer
      value="here's the photo"
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      attachments={attachments}
      sendAtLabel={sendAtLabel}
      dataAttr="reply"
    />
  );
}

/**
 * An inert Send button has to say why: the one attachment gate that blocks the send also
 * supplies the explanation, so neither state leaves the button reading just "Send".
 */
describe("InboxComposer send button names why it is blocked", () => {
  it("explains an upload still in flight", () => {
    render(composer([attachment({ uploading: true })]));
    const send = screen.getByRole("button", { name: INBOX_ATTACHMENT_UPLOADING_MESSAGE });
    expect(send).toBeDisabled();
    expect(send.getAttribute("title")).toBe(INBOX_ATTACHMENT_UPLOADING_MESSAGE);
  });

  it("explains a failed upload", () => {
    render(composer([attachment({ error: "Upload failed" })]));
    const send = screen.getByRole("button", { name: INBOX_ATTACHMENT_FAILED_MESSAGE });
    expect(send).toBeDisabled();
    expect(send.getAttribute("title")).toBe(INBOX_ATTACHMENT_FAILED_MESSAGE);
  });

  it("falls back to the send label when nothing blocks the send", () => {
    render(composer([attachment({})], "Mon 9:00 AM"));
    const send = screen.getByRole("button", { name: "Send at Mon 9:00 AM" });
    expect(send).not.toBeDisabled();
    expect(send.getAttribute("title")).toBe("Send at Mon 9:00 AM");
  });
});
