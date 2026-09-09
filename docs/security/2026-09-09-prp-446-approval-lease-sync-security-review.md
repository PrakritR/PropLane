# PRP-446 approval lease-sync independent security review

- Reviewed: 2026-09-09
- Base: `9c12026a71efb59a47b03eaf5c0bdafcd8336f6a`
- Focused diff SHA-256: `e9328b4d5713d719afaa76a62e816b438cd4288e64e17e01271ed8232cfd4b2e`
- Verdict: **Pass. The prior P1 is resolved.**

Approval sync now requires both the prior row and the outgoing row to have no execution claim. The adversarial unsigned-prior to off-platform-executed-current regression asserts that no POST occurs while local state retains the fully signed filing.

Recovery uses the existing authenticated single-row route. Successful server inventory is required before retrying an absent local draft. Scope changes reset inventory and attempt state; keys include manager scope; in-flight and attempted guards suppress render-driven duplicates. Signed siblings are never posted and approval sync never falls back to replace-all.

Reported validation: 24 focused tests, targeted lint, diff-check, and 4 GB TypeScript passed.
