import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { twimlMediaUrl, twimlOk } from "@/lib/sms/inbound-pipeline.server";

describe("twimlOk media", () => {
  it("is unchanged without media", async () => {
    expect(await twimlOk("Hi & bye").text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Hi &amp; bye</Message></Response>');
    expect(await twimlOk().text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it("carries one https photo as <Media>, escaped", async () => {
    const xml = await twimlOk("Room at 5259 Brooklyn", "https://cdn.example.com/r.jpg?a=1&b=2").text();
    expect(xml).toContain("<Message><Body>Room at 5259 Brooklyn</Body><Media>https://cdn.example.com/r.jpg?a=1&amp;b=2</Media></Message>");
  });

  it("drops anything that is not an https URL, and never draws media without a body", async () => {
    for (const bad of ["http://x.test/a.jpg", "data:image/png;base64,AAA", "javascript:alert(1)", "not a url", ""]) {
      expect(await twimlOk("Hi", bad).text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Hi</Message></Response>');
    }
    expect(await twimlOk(undefined, "https://cdn.example.com/r.jpg").text()).not.toContain("<Media>");
    expect(twimlMediaUrl(null)).toBeNull();
  });
});
