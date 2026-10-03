const VENDOR_RE =
  /\b(plumb\w*|electrician|electric\w*|handyman|handy man|hvac|locksmith|contractor|roofer|painter|landscap\w*|pest control|i'?m a vendor|i am a vendor|a vendor|vendor|quote|estimate|bid)\b/i;

const STOP_RE = /^\s*(stop|stopall|unsubscribe|end|quit|start|unstop|yes|help)\s*[.!]?\s*$/i;

export type InboundTextClassification =
  | { kind: "invalid"; label: string }
  | { kind: "stop"; label: string }
  | { kind: "vendor-known"; label: string }
  | { kind: "vendor-new"; label: string }
  | { kind: "known"; label: string }
  | { kind: "potential-new"; label: string }
  | { kind: "thread"; label: string };

export function parseNameFromInboundText(body: string): string {
  const match = body.match(
    /(?:this is|it's|i am|i'm|my name is|name is)\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?)/i,
  );
  return match?.[1]?.trim() ?? "";
}

export function classifyInboundText(input: {
  direction: "in" | "out";
  body: string;
  markVendor?: boolean;
  knownResident?: boolean;
  knownVendor?: boolean;
  vendorLabel?: string;
  knownLabel?: string;
}): InboundTextClassification {
  if (input.direction === "in" && STOP_RE.test(input.body || "")) {
    return { kind: "stop", label: "Opt-out or opt-in keyword" };
  }
  if (input.knownVendor) {
    return { kind: "vendor-known", label: input.vendorLabel?.trim() || "Vendor" };
  }
  if (input.knownResident || input.knownLabel) {
    return { kind: "known", label: input.knownLabel?.trim() || "Known contact" };
  }
  if (input.direction === "out") {
    return input.markVendor ? { kind: "vendor-new", label: "New vendor" } : { kind: "thread", label: "New contact" };
  }
  if (VENDOR_RE.test(input.body || "")) {
    return { kind: "vendor-new", label: "New vendor" };
  }
  return { kind: "potential-new", label: "New Potential resident" };
}

/** The trade a vendor-sounding text names, in the words the Vendors list already uses. */
export function guessTradeFromInboundText(body: string): string {
  const text = (body || "").toLowerCase();
  if (/plumb/.test(text)) return "Plumbing";
  if (/electric/.test(text)) return "Electrical";
  if (/hvac/.test(text)) return "HVAC";
  if (/lock/.test(text)) return "Locksmith";
  if (/clean/.test(text)) return "Cleaning";
  if (/paint/.test(text)) return "Painting";
  if (/landscap/.test(text)) return "Landscaping";
  if (/roof/.test(text)) return "Roofing";
  if (/pest/.test(text)) return "Pest control";
  if (/handy|repair|contractor/.test(text)) return "General repair";
  return "General maintenance";
}
