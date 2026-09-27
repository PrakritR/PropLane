import { describe, expect, it } from "vitest";

import { GOOGLE_SHEETS_OAUTH_SCOPES } from "@/lib/sheet-sync/google-sheets-auth";

/**
 * BUILD-WAVE2 C210: Connect Google Sheets is blocked for every manager except
 * the app's own developer account because the OAuth request asks for more
 * than "the file you pick". `drive.metadata.readonly` is a Google-restricted
 * scope (needs a paid security assessment); `spreadsheets.readonly` is a
 * sensitive scope broader than one file. Neither may ever reappear here.
 */
describe("Google Sheets OAuth scope stays file-only", () => {
  const scopes = GOOGLE_SHEETS_OAUTH_SCOPES.split(" ").filter(Boolean);

  it("never asks for a Google-restricted or sensitive scope", () => {
    const forbidden = [
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
    ];
    for (const scope of forbidden) {
      expect(scopes).not.toContain(scope);
    }
  });

  it("asks only for the picked file and the account email", () => {
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
  });
});
