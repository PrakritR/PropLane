import { describe, expect, it } from "vitest";

import { isValidPublishedCsvUrl } from "@/lib/sheet-sync/url";

describe("isValidPublishedCsvUrl", () => {
  it.each([
    "https://example.com/data/stays.csv",
    "https://example.com/export.CSV?token=1",
    "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv",
    "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv",
  ])("accepts %s", (url) => expect(isValidPublishedCsvUrl(url)).toBe(true));

  it.each([
    "",
    "not a url",
    "http://example.com/a.csv",
    "https://example.com/page.html",
    "https://docs.google.com/spreadsheets/d/abc/edit",
    "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=html",
    "https://user:pw@example.com/a.csv",
    "https://example.com:8443/a.csv",
    "https://localhost/a.csv",
    "https://127.0.0.1/a.csv",
    "https://10.0.0.5/a.csv",
    "https://[::1]/a.csv",
    "https://intranet/a.csv",
    "https://printer.local/a.csv",
    "ftp://example.com/a.csv",
  ])("rejects %s", (url) => expect(isValidPublishedCsvUrl(url)).toBe(false));
});
