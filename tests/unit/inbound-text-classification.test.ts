import { describe, expect, it } from "vitest";
import { classifyInboundText, parseNameFromInboundText } from "@/lib/sms/inbound-text-classification";

describe("inbound-text-classification", () => {
  it("parses this is Name from body", () => {
    expect(parseNameFromInboundText("Hi this is Morgan Lee — tour?")).toBe("Morgan Lee");
  });

  it("routes vendor trade language to vendor-new", () => {
    const cls = classifyInboundText({ direction: "in", body: "I'm a plumber, need to quote a leak" });
    expect(cls.kind).toBe("vendor-new");
  });

  it("routes unknown inbound to potential-new", () => {
    const cls = classifyInboundText({ direction: "in", body: "Is this room still available?" });
    expect(cls.kind).toBe("potential-new");
  });

  it("ignores stop keywords", () => {
    const cls = classifyInboundText({ direction: "in", body: "STOP" });
    expect(cls.kind).toBe("stop");
  });
});
