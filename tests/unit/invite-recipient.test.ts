import { describe, expect, it } from "vitest";
import { parseInviteRecipient, inviteRecipientHint } from "@/lib/invite-recipient";

describe("parseInviteRecipient", () => {
  it("returns empty for blank input", () => {
    expect(parseInviteRecipient("")).toEqual({ kind: "empty" });
    expect(parseInviteRecipient("  ")).toEqual({ kind: "empty" });
  });

  it("parses an email address", () => {
    const result = parseInviteRecipient("Ana@Reyes.com");
    expect(result.kind).toBe("email");
    expect(result).toEqual({
      kind: "email",
      value: "ana@reyes.com",
      label: "ana@reyes.com",
    });
  });

  it("parses a US phone number with formatting", () => {
    const result = parseInviteRecipient("415 555 0142");
    expect(result.kind).toBe("phone");
    expect(result.value).toBe("+14155550142");
    expect(result.label).toMatch(/\+1 \(415\)/);
  });

  it("parses an international phone with leading +", () => {
    const result = parseInviteRecipient("+1 (206) 555-0222");
    expect(result.kind).toBe("phone");
    expect(result.value).toBe("+12065550222");
  });

  it("parses a modern PROPLANE code", () => {
    const result = parseInviteRecipient("PROPLANE-17034810");
    expect(result.kind).toBe("code");
    expect(result.value).toBe("PROPLANE-17034810");
    expect(result.label).toBe("PROPLANE-17034810");
  });

  it("parses a legacy AXIS code", () => {
    const result = parseInviteRecipient("PROPLANE-17034810");
    expect(result.kind).toBe("code");
    expect(result.value).toBe("PROPLANE-17034810");
  });

  it("treats anything else as a name", () => {
    const result = parseInviteRecipient("Ana Reyes");
    expect(result.kind).toBe("name");
    expect(result.value).toBe("Ana Reyes");
  });

  it("trims whitespace from all inputs", () => {
    const result = parseInviteRecipient("  Ana@Reyes.com  ");
    expect(result.kind).toBe("email");
    expect(result.value).toBe("ana@reyes.com");
  });
});

describe("inviteRecipientHint", () => {
  it("returns empty message for empty recipient", () => {
    expect(inviteRecipientHint({ kind: "empty" })).toBe(
      "Add a phone, an email or a PropLane code",
    );
  });

  it("returns phone hint", () => {
    expect(
      inviteRecipientHint({
        kind: "phone",
        value: "+14155550142",
        label: "(415) 555-0142",
      }),
    ).toBe("Will text (415) 555-0142");
  });

  it("returns email hint", () => {
    expect(
      inviteRecipientHint({
        kind: "email",
        value: "ana@reyes.com",
        label: "ana@reyes.com",
      }),
    ).toBe("Will email ana@reyes.com");
  });

  it("returns code hint", () => {
    expect(
      inviteRecipientHint({
        kind: "code",
        value: "proplane-17034810",
        label: "PROPLANE-17034810",
      }),
    ).toBe("Will invite PROPLANE-17034810 in PropLane");
  });

  it("returns name hint (prompt to add contact info)", () => {
    expect(inviteRecipientHint({ kind: "name", value: "Ana Reyes" })).toBe(
      "Add a phone, an email or a PropLane code",
    );
  });
});

describe("legacy manager ids", () => {
  it("reads a seeded MGR- id as a PropLane code", () => {
    expect(parseInviteRecipient("MGR-TESTE2E2").kind).toBe("code");
  });
});
