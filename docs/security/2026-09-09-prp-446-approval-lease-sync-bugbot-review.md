# PRP-446 approval lease-sync independent bug review

- Reviewed: 2026-09-09
- Base: `9c12026a71efb59a47b03eaf5c0bdafcd8336f6a`
- Focused diff SHA-256: `e9328b4d5713d719afaa76a62e816b438cd4288e64e17e01271ed8232cfd4b2e`
- Verdict: **Pass. No remaining P1/P2 finding.**

The outgoing row and its prior baseline must both be unsigned before approval sync posts it. The new off-platform execution regression proves an unsigned prior cannot authorize a signed current row. Normal approval recovery posts only the absent or changed unsigned draft, waits for a successful inventory refresh after failure, and does not duplicate requests across repeated renders.
