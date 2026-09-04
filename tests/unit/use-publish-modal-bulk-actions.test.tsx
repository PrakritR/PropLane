// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { usePublishModalBulkActions } from "@/hooks/use-publish-modal-bulk-actions";

function Harness({
  signature,
  label,
  onBulkActionsChange,
}: {
  signature: string;
  label: string;
  onBulkActionsChange: (actions: ReactNode | null) => void;
}) {
  usePublishModalBulkActions(
    onBulkActionsChange,
    signature,
    signature ? <button type="button">{label}</button> : null,
  );
  return null;
}

describe("usePublishModalBulkActions", () => {
  it("notifies only when the selection signature changes", () => {
    const notify = vi.fn<(actions: ReactNode | null) => void>();

    const { rerender } = render(
      <Harness signature="" label="Edit" onBulkActionsChange={notify} />,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(null);

    rerender(<Harness signature="lease-1" label="Edit" onBulkActionsChange={notify} />);
    expect(notify).toHaveBeenCalledTimes(2);

    rerender(<Harness signature="lease-1" label="Edit again" onBulkActionsChange={notify} />);
    expect(notify).toHaveBeenCalledTimes(2);

    rerender(<Harness signature="" label="Edit" onBulkActionsChange={notify} />);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenLastCalledWith(null);
  });

  it("clears parent actions on unmount", () => {
    const notify = vi.fn<(actions: ReactNode | null) => void>();

    const { unmount } = render(
      <Harness signature="svc-1" label="Edit service" onBulkActionsChange={notify} />,
    );
    expect(notify).toHaveBeenCalledTimes(1);

    unmount();
    expect(notify).toHaveBeenLastCalledWith(null);
  });
});
