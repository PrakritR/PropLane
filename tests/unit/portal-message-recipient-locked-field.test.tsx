/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PortalMessageRecipientLockedField } from "@/components/portal/portal-message-compose-fields";

afterEach(cleanup);

describe("PortalMessageRecipientLockedField", () => {
  it("opens the To menu even though the recipient is locked", async () => {
    render(<PortalMessageRecipientLockedField recipient="sohanvnaik@gmail.com" />);

    await userEvent.click(screen.getByRole("button", { name: /recipients/i }));

    expect(screen.getByRole("listbox", { name: /recipients/i })).toBeInTheDocument();
  });
});
