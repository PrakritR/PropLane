import { expect, it } from "vitest";
import { extractDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";

it("preserves disclosure lists while removing executable markup from a stored override", () => {
  const result = extractDisclosureReviewFromLeaseHtml('<aside class="disclosure-review"><ul><li>Review the dates</li></ul><img src=x onerror="alert(document.cookie)"><script>alert(1)</script><p onclick="alert(1)">Notice</p></aside>');
  expect(result).toContain("<ul><li>Review the dates</li></ul>");
  expect(result).toContain("Notice");
  expect(result).not.toMatch(/onerror|onclick|<script|<img/i);
});

it("rejects javascript URLs and active embedded documents", () => {
  const result = extractDisclosureReviewFromLeaseHtml('<aside class="disclosure-review"><a href="javascript:alert(1)">Review</a><iframe src="https://attacker.example"></iframe></aside>');
  expect(result).not.toMatch(/javascript:|<iframe/i);
});
